const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const tls = require('node:tls');
const http = require('node:http');
const { spawnSync } = require('node:child_process');
const { Store } = require('../server/store');
const { createApi } = require('../server/api');
const { createOutbox, sign } = require('../server/outbox');
const { sendMail } = require('../server/smtp');
const { createAlerts, advance } = require('../server/alerts');
const { permissionFor } = require('../server/permissions');
const i18n = require('../src/i18n');

const site = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'server', 'site.blank.json'), 'utf8'));

function world(now) {
  let t = now || Date.parse('2026-01-15T12:00:00Z');
  const store = new Store({ site, now: () => t });
  store.exec('setConfig', { patch: { timeZone: 'UTC', language: 'en' } }, 'office');
  store.exec('addClient', { id: 'CL-A', name: 'North' }, 'office');
  store.exec('addClient', { id: 'CL-B', name: 'South' }, 'office');
  store.exec('addItem', { itemNo: 'MUG', name: 'Mug', category: 'GEN', clientId: 'CL-A', palletQty: 1 }, 'office');
  store.exec('addItem', { itemNo: 'CABLE', name: 'Cable', category: 'GEN', clientId: 'CL-B', palletQty: 1 }, 'office');
  store.exec('createLocation', { code: 'BIN-A', kind: 'bin', name: 'Bin A' }, 'office');
  store.exec('createLocation', { code: 'BIN-B', kind: 'bin', name: 'Bin B' }, 'office');
  store.exec('updateItem', { itemNo: 'MUG', reorderPoint: 5 }, 'office');
  store.exec('updateItem', { itemNo: 'CABLE', reorderPoint: 4 }, 'office');
  store.exec('binPut', { loc: 'BIN-A', itemNo: 'MUG', qty: 10 }, 'office');
  store.exec('binPut', { loc: 'BIN-B', itemNo: 'CABLE', qty: 10 }, 'office');
  const mails = [];
  const alerts = createAlerts({
    store,
    secretsFile: null,
    env: {},
    log() {},
    now: () => t,
    mailer: (msg) => { mails.push(msg); return Promise.resolve({ accepted: 1 }); },
  });
  return { store, alerts, mails, at(ms) { t = ms; }, get t() { return t; }, set t(v) { t = v; } };
}

function lows(store) {
  return (store.wh.messages || []).filter((m) => m.type === 'stock.low' || m.type === 'stock.recovered' || m.type === 'stock.digest');
}

test('crossing the reorder point alerts once, a bounce does not, recovery and a reminder do', () => {
  const w = world();
  w.alerts.evaluate();
  assert.equal(lows(w.store).length, 0, 'stock is above the point');
  w.store.exec('addOrder', { id: 'SO1', customer: 'Shop', lane: 'OUT-01', clientId: 'CL-A', lines: [{ itemNo: 'MUG', units: 6 }] }, 'office');
  const first = w.alerts.evaluate();
  assert.equal(first.filter((e) => e.itemNo === 'MUG').length, 1);
  assert.equal(lows(w.store).filter((m) => m.type === 'stock.low').length, 1);
  w.alerts.evaluate();
  assert.equal(lows(w.store).filter((m) => m.type === 'stock.low').length, 1, 'still low, no second alert');
  // Back above, then under again before the quiet period ends.
  w.store.exec('binPut', { loc: 'BIN-A', itemNo: 'MUG', qty: 10 }, 'office');
  w.alerts.evaluate();
  assert.equal(lows(w.store).some((m) => m.type === 'stock.recovered'), false);
  w.store.exec('addOrder', { id: 'SO2', customer: 'Shop', lane: 'OUT-02', clientId: 'CL-A', lines: [{ itemNo: 'MUG', units: 20 }] }, 'office');
  w.alerts.evaluate();
  assert.equal(lows(w.store).filter((m) => m.type === 'stock.low').length, 1, 'the bounce does not send another alert');
  // Stay above through the quiet period.
  w.store.wh.orders.SO1.status = 'shipped';
  w.store.wh.orders.SO2.status = 'shipped';
  w.alerts.evaluate();
  w.t += 30 * 60000;
  w.alerts.evaluate();
  assert.equal(lows(w.store).filter((m) => m.type === 'stock.recovered' && m.data.itemNo === 'MUG').length, 1);
  // Down again, then a reminder while it stays there.
  w.store.exec('addOrder', { id: 'SO3', customer: 'Shop', lane: 'OUT-01', clientId: 'CL-A', lines: [{ itemNo: 'MUG', units: 20 }] }, 'office');
  w.alerts.evaluate();
  assert.equal(lows(w.store).filter((m) => m.type === 'stock.low').length, 2);
  w.t += 24 * 3600000;
  w.alerts.evaluate();
  const mugLows = lows(w.store).filter((m) => m.type === 'stock.low' && m.data.itemNo === 'MUG');
  assert.equal(mugLows.length, 3);
  assert.equal(mugLows[mugLows.length - 1].data.reminder, true);
  const text = w.store.db.prepare("SELECT summary FROM alert_sent WHERE kind = 'stock.low' ORDER BY id DESC LIMIT 1").get().summary;
  assert.match(text, /Mug/);
  assert.match(text, /reorder point/);
  w.store.close();
});

test('the latch itself: one low, a reminder, a bounce, then recovery', () => {
  let step = advance(null, false, 0, { debounceMs: 1000, reminderMs: 5000 });
  assert.equal(step.emit, null);
  step = advance(step.latch, true, 10, { debounceMs: 1000, reminderMs: 5000 });
  assert.equal(step.emit, 'low');
  step = advance(step.latch, true, 20, { debounceMs: 1000, reminderMs: 5000 });
  assert.equal(step.emit, null);
  step = advance(step.latch, true, 5010, { debounceMs: 1000, reminderMs: 5000 });
  assert.equal(step.emit, 'reminder');
  step = advance(step.latch, false, 6000, { debounceMs: 1000, reminderMs: 5000 });
  assert.equal(step.emit, null);
  step = advance(step.latch, true, 6500, { debounceMs: 1000, reminderMs: 5000 });
  assert.equal(step.emit, null);
  assert.equal(step.latch.phase, 'low');
  step = advance(step.latch, false, 7000, { debounceMs: 1000, reminderMs: 5000 });
  step = advance(step.latch, false, 8000, { debounceMs: 1000, reminderMs: 5000 });
  assert.equal(step.emit, 'recovered');
});

test('a digest groups the items, and a client only receives its own', async () => {
  const w = world(Date.parse('2026-01-15T06:00:00Z'));
  w.alerts.save({
    mode: 'digest',
    digestTime: '07:00',
    debounceMinutes: 0,
    warehouseRecipients: [{ email: 'office@example.com' }],
    clientRecipients: { 'CL-A': [{ email: 'a@example.com', userId: 2 }], 'CL-B': [{ email: 'b@example.com', userId: 3 }] },
    smtp: { host: '127.0.0.1', port: 2525, mode: 'plain', from: 'wms@example.com' },
  });
  w.store.exec('addOrder', { id: 'SO1', customer: 'Shop', lane: 'OUT-01', clientId: 'CL-A', lines: [{ itemNo: 'MUG', units: 6 }] }, 'office');
  w.store.exec('addOrder', { id: 'SO2', customer: 'Shop', lane: 'OUT-02', clientId: 'CL-B', lines: [{ itemNo: 'CABLE', units: 8 }] }, 'office');
  w.alerts.evaluate();
  assert.equal(w.mails.length, 0, 'the digest has not gone out');
  assert.equal(lows(w.store).length, 0);
  w.t = Date.parse('2026-01-15T07:00:00Z');
  w.alerts.evaluate();
  const office = w.mails.filter((m) => m.to === 'office@example.com');
  assert.equal(office.length, 1);
  assert.match(office[0].text, /Mug/);
  assert.match(office[0].text, /Cable/);
  assert.equal(office[0].subject, 'Low-stock digest');
  const north = w.mails.filter((m) => m.to === 'a@example.com');
  assert.equal(north.length, 1);
  assert.match(north[0].text, /Mug/);
  assert.doesNotMatch(north[0].text, /Cable/);
  assert.equal(w.mails.some((m) => m.to === 'b@example.com' && /Mug/.test(m.text)), false);
  const digests = lows(w.store).filter((m) => m.type === 'stock.digest');
  assert.ok(digests.some((m) => m.clientId === 'CL-A' && m.data.items.every((item) => item.clientId === 'CL-A')));
  assert.ok(digests.some((m) => m.clientId === 'CL-B'));
  await new Promise((r) => setImmediate(r));
  w.store.exec('setConfig', { patch: { language: 'nl' } }, 'office');
  const dutch = i18n.t('nl', '{item} is at or below its reorder point: {available} available, reorder point {point}.');
  assert.match(dutch, /bestelpunt/);
  w.store.close();
});

test('the webhook payload is a signed stock.low message', async () => {
  const w = world();
  const got = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => { got.push({ headers: req.headers, raw, body: JSON.parse(raw) }); res.writeHead(204); res.end(); });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const box = createOutbox({ store: w.store, log: { warn() {}, error() {} } });
  try {
    const hook = box.add({ url: `http://127.0.0.1:${server.address().port}/hook`, types: ['stock.low'] });
    w.store.exec('addOrder', { id: 'SO1', customer: 'Shop', lane: 'OUT-01', clientId: 'CL-A', lines: [{ itemNo: 'MUG', units: 6 }] }, 'office');
    w.alerts.evaluate();
    await box.pump();
    assert.equal(got.length, 1);
    const message = got[0].body.messages[0];
    assert.equal(message.type, 'stock.low');
    assert.equal(message.clientId, 'CL-A');
    assert.equal(message.data.itemNo, 'MUG');
    assert.equal(message.data.name, 'Mug');
    assert.ok(message.data.available <= message.data.reorderPoint);
    assert.equal(message.data.reminder, false);
    assert.equal(got[0].headers['x-sorted-signature'], sign(hook.secret, got[0].raw));
  } finally {
    await new Promise((r) => server.close(r));
    w.store.close();
  }
});

test('SMTP speaks STARTTLS with AUTH PLAIN and SMTPS with AUTH LOGIN', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sorted-smtp-'));
  const key = path.join(dir, 'key.pem');
  const cert = path.join(dir, 'cert.pem');
  const made = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', key, '-out', cert, '-days', '1', '-nodes', '-subj', '/CN=localhost'], { encoding: 'utf8' });
  assert.equal(made.status, 0, made.stderr);
  const pem = { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
  const seen = [];
  function session(sock, greet) {
    let buf = '';
    let data = false;
    let body = '';
    const write = (line) => sock.write(`${line}\r\n`);
    if (greet) write('220 ready');
    const onData = (chunk) => {
      buf += chunk.toString('utf8');
      if (data) {
        body += chunk.toString('utf8');
        if (body.includes('\r\n.\r\n')) { data = false; write('250 queued'); }
        return;
      }
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        seen.push(line);
        const up = line.toUpperCase();
        if (up.startsWith('EHLO')) write('250-ready\r\n250-STARTTLS\r\n250 AUTH PLAIN LOGIN');
        else if (up === 'STARTTLS') {
          write('220 go ahead');
          sock.removeListener('data', onData);
          const secureSock = new tls.TLSSocket(sock, { isServer: true, cert: pem.cert, key: pem.key });
          secureSock.on('secure', () => session(secureSock, false));
          secureSock.on('error', () => {});
          return;
        } else if (up.startsWith('AUTH PLAIN')) write('235 ok');
        else if (up === 'AUTH LOGIN') write('334 user');
        else if (up.startsWith('MAIL FROM')) write('250 ok');
        else if (up.startsWith('RCPT TO')) write('250 ok');
        else if (up === 'DATA') { write('354 go'); data = true; body = ''; }
        else if (up === 'QUIT') write('221 bye');
        else if (/^[A-Za-z0-9+/=]+$/.test(line)) write(seen.filter((row) => /^[A-Za-z0-9+/=]+$/.test(row)).length < 2 ? '334 pass' : '235 ok');
        else write('250 ok');
      }
    };
    sock.on('data', onData);
  }
  const plain = net.createServer((sock) => session(sock, true));
  await new Promise((r) => plain.listen(0, '127.0.0.1', r));
  const secure = tls.createServer(pem, (sock) => session(sock, true));
  await new Promise((r) => secure.listen(0, '127.0.0.1', r));
  try {
    await sendMail({
      host: '127.0.0.1', port: plain.address().port, mode: 'starttls', auth: 'PLAIN',
      user: 'ada', password: 'sample-secret', from: 'wms@example.com', to: 'office@example.com',
      subject: 'Low stock', text: 'Mug is low', tls: { rejectUnauthorized: false, ca: pem.cert },
    });
    assert.ok(seen.some((line) => line.toUpperCase() === 'STARTTLS'));
    assert.ok(seen.some((line) => line.startsWith('AUTH PLAIN ')));
    assert.equal(seen.some((line) => line.includes('sample-secret')), false);
    seen.length = 0;
    await sendMail({
      host: '127.0.0.1', port: secure.address().port, mode: 'smtps', auth: 'LOGIN',
      user: 'ada', password: 'sample-secret', from: 'wms@example.com', to: 'office@example.com',
      subject: 'Low stock', text: 'Cable is low', tls: { rejectUnauthorized: false, ca: pem.cert },
    });
    assert.ok(seen.some((line) => line.toUpperCase() === 'AUTH LOGIN'));
    assert.ok(seen.some((line) => line === Buffer.from('ada').toString('base64')));
    assert.equal(seen.join('\n').includes('sample-secret'), false);
  } finally {
    await new Promise((r) => plain.close(r));
    await new Promise((r) => secure.close(r));
  }
});

test('a backup failure is raised on the alert channel, and the password stays out of the export', () => {
  const w = world();
  const mod = require('../modules/alerts');
  mod.raise(w.store, { type: 'backup.failed', summary: 'folder nas: not reachable' });
  const row = w.store.db.prepare("SELECT kind, summary FROM alert_sent WHERE kind = 'backup.failed'").get();
  assert.match(row.summary, /not reachable/);
  assert.ok((w.store.wh.messages || []).some((m) => m.type === 'backup.failed'));
  w.alerts.save({ smtp: { host: 'smtp.example', port: 587, mode: 'starttls', user: 'ada', from: 'wms@example.com', password: 'sample-secret' } });
  const dumped = JSON.stringify(w.store.exportBackup());
  assert.equal(dumped.includes('sample-secret'), false);
  const view = w.alerts.status({ role: 'manager', id: 1, permissions: ['alerts.read'] });
  assert.equal(view.smtp.passwordSet, true);
  assert.equal(JSON.stringify(view).includes('sample-secret'), false);
  w.store.close();
});

test('notify routes name a permission and disappear when the module is off', async () => {
  assert.equal(permissionFor('POST', '/api/notify/test').permission, 'alerts.write');
  assert.equal(permissionFor('GET', '/api/alerts/low-stock').permission, 'reports.read');
  const w = world();
  const api = createApi({ store: w.store, printers: { flush() {} }, alerts: w.alerts });
  w.store.wh.setModules({ alerts: false });
  const denied = await api.handle('GET', '/api/notify', {}, 'admin', null, { role: 'administrator', id: 1, permissions: ['alerts.read'] });
  assert.equal(denied.status, 404);
  w.store.close();
});
