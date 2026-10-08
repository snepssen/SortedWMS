const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { Store } = require('../server/store');
const { Printers } = require('../server/print');
const { createServer } = require('../server/index');
const { seedDemo } = require('../server/seed');

const site = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'server', 'site.example.json'), 'utf8'));
const tmpDb = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sorted-')), 'wms.db');
// A clock that moves 7 seconds per reading, so replay has to use the journaled times to match.
const stepClock = (start = Date.UTC(2026, 9, 8, 6, 0)) => { let t = start; return () => (t += 7000); };
const state = (store) => JSON.stringify(store.wh);

// Drive one handheld through its current job: scan where it says, twice.
function work(store, id) {
  const ins = store.wh.instruction(id);
  if (ins.kind === 'pickup' || ins.kind === 'check-pallet') store.exec('scan', { id, code: ins.pallet.sscc }, id);
  const next = store.wh.instruction(id);
  if (next.kind === 'drop' || next.kind === 'check-label') store.exec('scan', { id, code: next.target }, id);
}

test('replaying the journal rebuilds exactly the same warehouse', () => {
  const file = tmpDb();
  const a = new Store({ file, site, now: stepClock() });
  seedDemo(a);
  for (let i = 0; i < 6; i++) { work(a, 'HH01'); work(a, 'HH03'); a.tick(); }
  a.exec('applyTemplate', { from: 'AA01A1', to: 'AA10E3', category: 'CHE' }, 'boss');
  a.exec('setTruckMode', { id: 'HH02', mode: 'transfer' }, 'HH02');
  const p = Object.values(a.wh.pallets).find((x) => x.loc && a.wh.locations[x.loc].kind === 'rack' && x.itemNo.startsWith('Y') && !Object.values(a.wh.tasks).some((t) => t.sscc === x.sscc && t.status !== 'done' && t.status !== 'cancelled'));
  a.exec('scan', { id: 'HH02', code: p.sscc }, 'HH02');
  a.exec('scan', { id: 'HH02', code: 'AB05A1' }, 'HH02');
  a.tick();

  const b = new Store({ file, site: null, now: stepClock(0) }); // site comes from the database
  assert.deepStrictEqual(b.replayErrors, []);
  assert.strictEqual(state(b), state(a));
  assert.strictEqual(b.wh.pallets[p.sscc].loc, a.wh.resolve('AB05A1'));
  b.db.close();
  a.db.close();
});

test('a snapshot plus the journal after it gives the same state', () => {
  const file = tmpDb();
  const a = new Store({ file, site, now: stepClock() });
  seedDemo(a);
  work(a, 'HH01');
  a.snapshot();
  work(a, 'HH01');
  work(a, 'HH03');
  a.exec('setConfig', { patch: { aisleCap: 1 } }, 'boss');
  const b = new Store({ file, site: null, now: stepClock(0) });
  assert.strictEqual(state(b), state(a));
  assert.strictEqual(b.wh.config.aisleCap, 1);
  b.db.close();
  a.close();
  const c = new Store({ file, site: null }); // after a clean shutdown: straight from the last snapshot
  assert.strictEqual(state(c), state(a));
  c.db.close();
});

test('a failed command changes nothing and is not journaled', () => {
  const a = new Store({ site, now: stepClock() });
  seedDemo(a);
  const before = state(a);
  const n = a.journal({ limit: 1000 }).length;
  assert.throws(() => a.exec('setConfig', { patch: { aisleCap: 0 } }, 'boss'), /whole number/);
  assert.throws(() => a.exec('scan', { id: 'NOPE', code: '1' }, 'x'));
  assert.strictEqual(state(a), before);
  assert.strictEqual(a.journal({ limit: 1000 }).length, n);
});

test('the audit trail says who did what', () => {
  const a = new Store({ site, now: stepClock() });
  seedDemo(a);
  work(a, 'HH01');
  const scans = a.journal({ by: 'HH01' });
  assert.ok(scans.length >= 1);
  assert.ok(scans.every((r) => r.by === 'HH01' && r.op === 'scan'));
  assert.ok(a.journal({ op: 'addOrder' }).length === 2);
});

test('ticks are only journaled when something happened', () => {
  const a = new Store({ site, now: stepClock() });
  const count = () => a.db.prepare("SELECT COUNT(*) AS n FROM journal WHERE op = 'tick'").get().n;
  a.tick();
  a.tick();
  assert.strictEqual(count(), 0);
});

test('label jobs go to the printer over TCP 9100-style raw socket', async () => {
  const got = [];
  const srv = net.createServer((s) => { let d = ''; s.on('data', (c) => (d += c)); s.on('end', () => got.push(d)); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const printers = new Printers({ 'LP-OUT-01': `127.0.0.1:${srv.address().port}` });
  printers.flush([{ id: 1, printer: 'LP-OUT-01', zpl: '^XA^FDhello^FS^XZ' }, { id: 2, printer: 'LP-OUT-09', zpl: '^XA^XZ' }]);
  printers.flush([{ id: 1, printer: 'LP-OUT-01', zpl: '^XA^FDhello^FS^XZ' }]); // already sent: not again
  await new Promise((r) => setTimeout(r, 200));
  srv.close();
  assert.deepStrictEqual(got, ['^XA^FDhello^FS^XZ']);
  assert.ok(printers.results.some((r) => r.id === 2 && !r.ok && /No address/.test(r.error)));
});

test('HTTP API: template range, handheld transfer, lost pallets, audit', async () => {
  const store = new Store({ site, now: stepClock() });
  seedDemo(store);
  const server = createServer({ store, printers: new Printers({}), token: 'secret' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body, headers = {}) => {
    const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json', 'x-token': 'secret', ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };
  try {
    assert.strictEqual((await call('GET', '/api/summary', null, { 'x-token': 'wrong' })).status, 401);

    // The yoghurt racks AA..AH in one go: preview first, then apply.
    const prev = await call('GET', '/api/template/preview?from=AA01A1&to=AB10E3&category=PRO');
    assert.strictEqual(prev.body.locations, 300);
    assert.strictEqual(prev.body.changed, 300);
    assert.deepStrictEqual(prev.body.first, ['AA01A1', 'AA01A2', 'AA01A3']);
    const applied = await call('POST', '/api/template/apply', { from: 'AA01A1', to: 'AB10E3', category: 'PRO' }, { 'x-operator': 'boss' });
    assert.strictEqual(applied.status, 200);
    assert.strictEqual(applied.body.changed, 300);
    assert.strictEqual(store.wh.locations[store.wh.resolve('AB10E3')].category, 'PRO');
    assert.strictEqual(store.wh.locations[store.wh.resolve('AC01A1')].category, 'YOG');

    // A driver's correction transfer: scan the pallet, then where it really stands.
    const p = Object.values(store.wh.pallets).find((x) => x.loc && x.itemNo.startsWith('C') && store.wh.locations[x.loc].kind === 'rack' && !Object.values(store.wh.tasks).some((t) => t.sscc === x.sscc && ['open', 'active', 'held'].includes(t.status)));
    const occupied = Object.values(store.wh.locations).find((l) => l.kind === 'rack' && l.category === 'CHE' && l.sscc && l.sscc !== p.sscc && !Object.values(store.wh.tasks).some((t) => t.sscc === l.sscc && ['open', 'active', 'held'].includes(t.status)));
    const displaced = occupied.sscc;
    assert.strictEqual((await call('POST', '/api/devices/HH03/mode', { mode: 'transfer' })).status, 200);
    await call('POST', '/api/devices/HH03/scan', { code: `00${p.sscc}` });
    let dev = (await call('GET', '/api/devices/HH03')).body;
    assert.strictEqual(dev.instruction.kind, 'transfer');
    assert.strictEqual(dev.instruction.pallet.sscc, p.sscc);
    await call('POST', '/api/devices/HH03/scan', { code: store.wh.label(occupied.code) });
    dev = (await call('GET', '/api/devices/HH03')).body;
    assert.ok(dev.message.ok, dev.message.text);
    assert.strictEqual(store.wh.pallets[p.sscc].loc, occupied.code);
    const lost = (await call('GET', '/api/lost')).body;
    assert.deepStrictEqual(lost.map((x) => x.sscc), [displaced]);
    assert.strictEqual(lost[0].missingFrom, occupied.code);

    // Find mode on the handheld.
    await call('POST', '/api/devices/HH03/mode', { mode: 'find' });
    await call('POST', '/api/devices/HH03/scan', { code: store.wh.label(occupied.code) });
    dev = (await call('GET', '/api/devices/HH03')).body;
    assert.match(dev.instruction.result.text, new RegExp(p.sscc.slice(-6)));

    // Errors come back as 400 with the reason; unknown things as 404.
    assert.strictEqual((await call('POST', '/api/transfer', { sscc: '000000000000000000', to: 'AA01A1' })).body.ok, false);
    assert.strictEqual((await call('GET', '/api/devices/NOPE')).status, 404);
    const bad = await call('POST', '/api/config', { aisleCap: 0 });
    assert.strictEqual(bad.status, 400);

    // The audit trail has the operator and the device.
    const j = (await call('GET', '/api/journal?op=applyTemplate')).body;
    assert.strictEqual(j[0].by, 'boss');
    assert.strictEqual((await call('GET', '/api/journal?by=HH03')).body.filter((r) => r.op === 'scan').length, 3);

    // Pages are served.
    const page = await fetch(`${base}/handheld`);
    assert.match(await page.text(), /SortedWMS handheld/);
  } finally {
    server.close();
  }
});

test('a request sent again with the same request ID is answered once, not done twice', () => {
  const { createApi } = require('../server/api');
  const file = tmpDb();
  const store = new Store({ file, site, now: stepClock() });
  seedDemo(store);
  const api = createApi({ store, printers: { results: [], flush() {}, list: () => [] } });
  const sscc = store.wh.instruction('HH01').pallet.sscc;
  const rows = () => store.journal({ limit: 1000 }).length;
  const before = rows();
  const first = api.handle('POST', '/api/devices/HH01/scan', { code: sscc }, 'HH01', 'HH01-abc-1');
  const again = api.handle('POST', '/api/devices/HH01/scan', { code: sscc }, 'HH01', 'HH01-abc-1');
  assert.deepStrictEqual(again, first);
  assert.strictEqual(rows(), before + 1, 'journaled once');
  assert.strictEqual(store.wh.instruction('HH01').kind, 'drop', 'picked up once, not "scan again to move it"');
  // A new request ID is a new scan.
  const third = api.handle('POST', '/api/devices/HH01/scan', { code: sscc }, 'HH01', 'HH01-abc-2');
  assert.strictEqual(rows(), before + 2);
  assert.match(third.body.text, /carrying it/);
});
