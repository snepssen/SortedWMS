const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const GS1 = require('../src/gs1');
const { missingDutch } = require('../src/terminal');
const { serve, allow } = require('../server/terminal');
const { Store } = require('../server/store');
const { createAuth } = require('../server/auth');

function site() {
  return { name: 'RF', categories: { GEN: 'General' }, layout: { aisles: [1], bays: 2, levels: 1, positions: [10], outLanes: 1 } };
}

function open(port) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    let buf = '';
    let mark = 0;
    const timer = setTimeout(() => { sock.destroy(); reject(new Error(`timed out after:\n${buf.slice(-500)}`)); }, 6000);
    sock.on('data', (chunk) => { buf += chunk.toString('latin1'); });
    sock.on('error', reject);
    sock.on('connect', () => resolve({
      text: () => buf,
      send: (s) => sock.write(s),
      wait: (needle) => new Promise((done, fail) => {
        const start = Date.now();
        const tick = () => {
          if (buf.slice(mark).includes(needle)) { mark = buf.length; done(buf); }
          else if (Date.now() - start > 1500) fail(new Error(`no ${needle} in:\n${buf.slice(-600)}`));
          else setTimeout(tick, 15);
        };
        tick();
      }),
      end: () => { clearTimeout(timer); sock.end(); },
    }));
  });
}

test('Dutch terminal sentences cover the English ones, and only private addresses are allowed', () => {
  assert.deepEqual(missingDutch(), []);
  assert.equal(allow('127.0.0.1', 'lan'), true);
  assert.equal(allow('::ffff:192.168.1.9', 'lan'), true);
  assert.equal(allow('8.8.8.8', 'lan'), false);
});

test('a socket session signs in, receives, puts away, and counts blind', async () => {
  const store = new Store({ site: site(), now: () => Date.UTC(2026, 10, 5, 9) });
  store.exec('setModules', { modules: { terminal: true } }, 'admin');
  const auth = createAuth(store.db);
  auth.ensureDemoUsers();
  const manager = auth.getUser('manager');
  auth.setTerminalPin(manager.id, '2468');
  const gtin = GS1.makeGtin13('200000', 1);
  store.exec('addItem', { itemNo: 'Y1', name: 'Saw', category: 'GEN', palletQty: 10, gtin }, 'setup');
  store.exec('addDelivery', { id: 'D1', supplier: 'Mill', category: 'GEN', pallets: 1 }, 'setup');
  store.exec('createLocation', { code: 'BIN-A', kind: 'bin', name: 'Bin A' }, 'setup');
  store.exec('binPut', { loc: 'BIN-A', itemNo: 'Y1', qty: 37 }, 'setup');
  store.exec('setAbc', { settings: { frequency: { A: 1, B: 1, C: 1 }, thresholdQty: 0, thresholdPercent: 0 } }, 'setup');
  store.exec('planAbc', {}, 'setup');
  for (const loc of Object.values(store.wh.locations)) if (loc.kind === 'rack') loc.category = 'GEN';
  const server = serve({ store, auth, port: 0, idleMs: 60000 });
  await new Promise((r) => server.on('listening', r));
  const port = server.address().port;
  try {
    const client = await open(port);
    await client.wait('Screen'); client.send('1\n');
    await client.wait('User'); client.send('manager\n');
    await client.wait('PIN'); client.send('2468\n');
    await client.wait('Menu'); client.send('1\n');
    await client.wait('Scan');
    const sscc = store.wh.nextSscc();
    const label = `(00)${sscc}(02)${GS1.gtin14(gtin)}(15)270301(10)B7(37)10`;
    client.send(`${label}\n`);
    await client.wait('registered');
    assert.equal(store.wh.pallets[sscc].loc, 'DOCK-IN');
    const task = Object.values(store.wh.tasks).find((t) => t.type === 'PUTAWAY' && t.sscc === sscc && t.status !== 'done' && t.status !== 'cancelled');
    assert.ok(task && task.to, 'put-away has a slot');
    client.send(`${sscc}\n`);
    await client.wait('Take it to');
    client.send(`${task.to}\n`);
    await new Promise((resolve, reject) => {
      const start = Date.now();
      const tick = () => {
        if (store.wh.pallets[sscc].loc === task.to) resolve();
        else if (Date.now() - start > 2000) reject(new Error(client.text().slice(-400)));
        else setTimeout(tick, 20);
      };
      tick();
    });
    client.send('0\n');
    await client.wait('Menu');
    client.send('7\n');
    const blind = await client.wait('BIN-A');
    assert.match(blind, /Y1/);
    assert.doesNotMatch(blind.slice(blind.lastIndexOf('Count')), /\b37\b/);
    client.send('37\n');
    await new Promise((resolve, reject) => {
      const start = Date.now();
      const tick = () => {
        const line = store.wh.abcBoard({ reveal: true }).lines.find((row) => row.itemNo === 'Y1');
        if (line && line.status === 'matched') resolve();
        else if (Date.now() - start > 2000) reject(new Error(client.text().slice(-400)));
        else setTimeout(tick, 20);
      };
      tick();
    });
    if (fs.existsSync('/opt/cursor/artifacts')) fs.writeFileSync('/opt/cursor/artifacts/terminal-20x16.txt', client.text().slice(0, 1800));
    client.end();
  } finally {
    await new Promise((r) => server.close(r));
    store.close();
  }
});

test('the parser echoes what is typed, stars a PIN, and never types a function key into a field', () => {
  const lines = [];
  const keys = [];
  let echoed = '';
  let masked = false;
  const { createParser } = require('../server/terminal');
  const push = createParser((l) => lines.push(l), () => {}, { echo: (t) => { echoed += t; }, mask: () => masked, onKey: (k) => keys.push(k) });
  push(Buffer.from('ab\x7fc\r\n'));
  assert.deepEqual(lines, ['ac']);
  assert.equal(echoed, 'ab\b \bc\r\n');
  masked = true; echoed = '';
  push(Buffer.from('2468\r'));
  assert.equal(echoed, '****\r\n');
  masked = false;
  push(Buffer.from('xy\x1bOP'));
  push(Buffer.from('\x1b[11~\x1b[A\x1b[13~'));
  assert.deepEqual(keys, ['F1', 'F1', 'F3']);
  push(Buffer.from('\n'));
  assert.deepEqual(lines, ['ac', '2468', ''], 'half-typed text and escape codes are dropped, not booked');
});

test('every screen profile fits, and wide short screens put the menu in two columns', () => {
  const { layout } = require('../server/terminal');
  const { createSession, PROFILES } = require('../src/terminal');
  const store = new Store({ site: site(), now: () => Date.UTC(2026, 10, 5, 9) });
  store.exec('setModules', { modules: { terminal: true } }, 'admin');
  const auth = createAuth(store.db);
  auth.ensureDemoUsers();
  auth.setTerminalPin(auth.getUser('manager').id, '2468');
  try {
    for (const [name, size] of Object.entries(PROFILES)) {
      const ui = createSession({ store, auth, device: 'RF1', profile: name });
      ui.input('manager'); ui.input('2468');
      const { lines, prompt } = layout(ui);
      assert.equal(lines.length, size.rows - 1, `${name}: the last row is the prompt`);
      assert.ok(lines.every((l) => l.length <= size.cols), `${name}: nothing wider than the screen`);
      assert.ok(prompt.length < size.cols);
      const text = lines.join('\n');
      assert.match(text, /1 Receive/, name);
      assert.match(text, /9 More/, `${name}: the whole menu is on screen`);
    }
  } finally { store.close(); }
});

test('two terminals at once get different device ids, and a freed id is used again', async () => {
  const store = new Store({ site: site(), now: () => Date.UTC(2026, 10, 5, 9) });
  store.exec('setModules', { modules: { terminal: true } }, 'admin');
  const auth = createAuth(store.db);
  const server = serve({ store, auth, port: 0, idleMs: 60000 });
  await new Promise((r) => server.on('listening', r));
  const port = server.address().port;
  try {
    const a = await open(port); await a.wait('RF1');
    const b = await open(port); await b.wait('RF2');
    a.end();
    await new Promise((r) => setTimeout(r, 100));
    const c = await open(port); await c.wait('RF1');
    b.end(); c.end();
  } finally {
    await new Promise((r) => server.close(r));
    store.close();
  }
});
