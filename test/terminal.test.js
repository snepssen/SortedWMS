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
