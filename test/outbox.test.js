const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { Store } = require('../server/store');
const { Printers } = require('../server/print');
const { createServer } = require('../server/index');
const { createAuth } = require('../server/auth');
const { createOutbox, sign } = require('../server/outbox');

const site = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'site.json'), 'utf8'));
const quiet = { warn() {}, error() {} };

// Stock found: one stock.adjusted message each, for the item's client.
let n = 0;
function found(store, itemNo = 'W1001') {
  const code = Object.values(store.wh.locations).find((l) => l.kind === 'rack' && !l.sscc && !l.reservedBy && l.category === store.wh.items[itemNo].category).code;
  store.exec('createStock', { code, itemNo, qty: 5 + (++n % 7), reason: 'found' }, 'stock');
}

async function receiver() {
  const got = [];
  let status = 200;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => { got.push({ headers: req.headers, raw, body: JSON.parse(raw) }); res.writeHead(status); res.end('ok'); });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}/hook`, got, answer: (s) => { status = s; }, close: () => new Promise((r) => server.close(r)) };
}

test('webhooks: new messages POSTed in order and signed; a failure is tried again later, nothing skipped or sent twice', async () => {
  const store = new Store({ site });
  const rx = await receiver();
  let t = Date.now();
  const box = createOutbox({ store, now: () => t, log: quiet });
  try {
    found(store); // before the webhook: not sent
    const hook = box.add({ url: rx.url });
    assert.match(hook.secret, /^whs_/);
    assert.equal(box.list()[0].secret, undefined, 'the secret is shown once');
    for (let i = 0; i < 3; i++) found(store);
    assert.equal(box.list()[0].waiting, 3);
    await box.pump();
    assert.equal(rx.got.length, 1);
    const first = rx.got[0];
    assert.deepEqual(first.body.messages.map((m) => m.seq), [2, 3, 4]);
    assert.equal(first.headers['x-sorted-signature'], sign(hook.secret, first.raw), 'the receiver can check it came from here');
    assert.equal(box.list()[0].delivered, 4);

    rx.answer(500);
    found(store);
    found(store);
    await box.pump();
    let h = box.list()[0];
    assert.equal(h.failures, 1);
    assert.equal(h.lastError, 'HTTP 500');
    assert.equal(h.delivered, 4, 'not moved on');
    await box.pump();
    assert.equal(rx.got.length, 2, 'not tried again before its time');
    t += 6000;
    rx.answer(204);
    await box.pump();
    assert.equal(rx.got.length, 3);
    assert.deepEqual(rx.got[2].body.messages.map((m) => m.seq), [5, 6], 'the same batch again, then on');
    h = box.list()[0];
    assert.equal(h.failures, 0);
    assert.equal(h.delivered, 6);
    await box.pump();
    assert.equal(rx.got.length, 3, 'nothing new, nothing sent');

    // A restart carries on where it was.
    found(store);
    const again = createOutbox({ store, now: () => t, log: quiet });
    await again.pump();
    assert.deepEqual(rx.got[3].body.messages.map((m) => m.seq), [7]);
  } finally { await rx.close(); store.close(); }
});

test('webhooks: only the types and the client asked for; a receiver that is gone backs off', async () => {
  const store = new Store({ site });
  const rx = await receiver();
  let t = Date.now();
  const box = createOutbox({ store, now: () => t, log: quiet });
  try {
    box.add({ url: rx.url, types: 'stock.adjusted', clientId: 'cl-garden' });
    assert.throws(() => box.add({ url: rx.url, types: 'invoice.paid' }), /Message type is one of/);
    assert.throws(() => box.add({ url: 'ftp://x' }), /http/);
    found(store, 'W1001');
    found(store, 'G2001');
    found(store, 'W1002');
    await box.pump();
    assert.equal(rx.got.length, 1);
    assert.deepEqual(rx.got[0].body.messages.map((m) => [m.type, m.clientId]), [['stock.adjusted', 'CL-GARDEN']]);
    assert.equal(box.list()[0].delivered, 2);
    await box.pump();
    assert.equal(box.list()[0].delivered, 3, 'moved past what is not its own');
    const dead = box.add({ url: 'http://127.0.0.1:9/nobody' });
    found(store, 'W1001');
    await box.pump();
    const d = box.list().find((x) => x.id === dead.id);
    assert.ok(d.lastError && d.failures === 1 && d.nextTry > t);
    box.retry(dead.id);
    assert.equal(box.list().find((x) => x.id === dead.id).nextTry, null);
  } finally { await rx.close(); store.close(); }
});

test('the outbox folder: each message a file of its own, written once', () => {
  const store = new Store({ site });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sorted-outbox-'));
  try {
    const box = createOutbox({ store, log: quiet });
    found(store);
    found(store);
    assert.equal(box.writeFolder(dir), 2);
    assert.deepEqual(fs.readdirSync(dir).sort(), ['000001-stock.adjusted.json', '000002-stock.adjusted.json']);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, '000002-stock.adjusted.json'), 'utf8')).seq, 2);
    assert.equal(box.writeFolder(dir), 0, 'nothing new');
    found(store);
    assert.equal(createOutbox({ store, log: quiet }).writeFolder(dir), 1, 'a restart carries on');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); store.close(); }
});

test('webhooks over the API: an administrator adds and removes them; others cannot', async () => {
  const store = new Store({ site });
  const auth = createAuth(store.db);
  auth.ensureDemoUsers();
  const outbox = createOutbox({ store, log: quiet });
  const server = createServer({ store, printers: new Printers({}), auth, outbox });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body, headers = {}) => {
    const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json(), headers: res.headers };
  };
  const login = async (username) => ((await call('POST', '/api/login', { username, password: `sorted-${username}` })).headers.getSetCookie()[0] || '').split(';')[0];
  try {
    const admin = await login('admin');
    const made = await call('POST', '/api/webhooks', { url: 'https://erp.example/in', types: ['order.shipped'] }, { cookie: admin });
    assert.equal(made.status, 200);
    assert.match(made.body.secret, /^whs_/);
    const listed = await call('GET', '/api/webhooks', null, { cookie: admin });
    assert.equal(listed.body.webhooks.length, 1);
    assert.equal(JSON.stringify(listed.body).includes(made.body.secret), false);
    const office = await login('office');
    assert.equal((await call('POST', '/api/webhooks', { url: 'https://x.example' }, { cookie: office })).status, 403);
    assert.equal((await call('POST', `/api/webhooks/${made.body.id}/remove`, {}, { cookie: admin })).status, 200);
    assert.equal((await call('GET', '/api/webhooks', null, { cookie: admin })).body.webhooks.length, 0);
    const log = await call('GET', '/api/auth-log', null, { cookie: admin });
    assert.ok(JSON.stringify(log.body).includes('webhook-added') && JSON.stringify(log.body).includes('webhook-removed'));
  } finally { await new Promise((r) => server.close(r)); store.close(); }
});
