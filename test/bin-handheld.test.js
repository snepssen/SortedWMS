const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Warehouse } = require('../src/engine');
const { Store } = require('../server/store');
const { Printers } = require('../server/print');
const { createServer } = require('../server/index');
const { createAuth } = require('../server/auth');
const { loadSample } = require('../server/samples');

function wh() {
  const w = new Warehouse({ aisles: [1], bays: 2, levels: 2, positions: [10], outLanes: 1, clock: () => Date.UTC(2026, 9, 8, 8) });
  w.addItem({ itemNo: 'M3', name: 'M3 screw', category: 'YOG', palletQty: 1, uom: 'piece' });
  w.addItem({ itemNo: 'AA', name: 'AA battery', category: 'YOG', palletQty: 1, uom: 'piece' });
  w.setItemUnits('M3', { packs: [{ unit: 'box', per: 100 }], unitWeightKg: 0.01 });
  w.generateGuided({ sections: { count: 1, name: 'Wall' }, layouts: [{ type: 'shelf', positions: { count: 4, name: 'Bin 1' } }] });
  return w;
}

test('bin picks come in walking order, and a claimed one is hidden from the next picker', () => {
  const w = wh();
  w.binPut({ loc: 'Wall-Bin3', itemNo: 'M3', qty: 50 });
  w.binPut({ loc: 'Wall-Bin1', itemNo: 'AA', qty: 20 });
  w.addOrder({ id: 'O1', customer: 'A', lane: 'OUT-01', lines: [{ itemNo: 'M3', units: 10 }, { itemNo: 'AA', units: 4 }] });
  w.planWave({});
  assert.deepEqual(w.waveTasks({ kind: 'bin' }).map((t) => t.loc), ['Wall-Bin1', 'Wall-Bin3']);
  const first = w.waveTasks({ kind: 'bin', for: 'pat' })[0];
  w.claimWaveTask({ task: first.id, by: 'pat' });
  assert.throws(() => w.claimWaveTask({ task: first.id, by: 'sam' }), /pat is already on task/);
  assert.deepEqual(w.waveTasks({ kind: 'bin', for: 'sam' }).map((t) => t.loc), ['Wall-Bin3'], 'sam does not see what pat took');
  assert.equal(w.waveTasks({ kind: 'bin', for: 'pat' })[0].id, first.id, 'pat sees their own first');
  assert.throws(() => w.releaseWaveTask({ task: first.id, by: 'sam' }), /pat's/);
  w.releaseWaveTask({ task: first.id, by: 'pat' });
  assert.equal(w.waveTasks({ kind: 'bin', for: 'sam' }).length, 2);
});

test('not enough in the bin: the bin is held for a check and the pick is planned again elsewhere', () => {
  const w = wh();
  w.binPut({ loc: 'Wall-Bin1', itemNo: 'M3', qty: 30 });
  w.binPut({ loc: 'Wall-Bin2', itemNo: 'M3', qty: 30 });
  w.addOrder({ id: 'O1', customer: 'A', lane: 'OUT-01', lines: [{ itemNo: 'M3', units: 20 }] });
  const wave = w.planWave({});
  assert.deepEqual(wave.tasks.map((t) => [t.loc, t.qty]), [['Wall-Bin1', 20]]);
  const out = w.shortWaveTask({ task: wave.tasks[0].id, found: 12, by: 'pat' });
  assert.equal(wave.tasks[0].status, 'cancelled');
  assert.match(w.checks[out.check].note, /only 12 of 20 M3 found/);
  assert.ok(wave.completedAt, 'the wave is done, so the queue can drop again');
  const next = Object.values(w.waves).find((x) => x.id !== wave.id);
  assert.deepEqual(next.tasks.map((t) => [t.loc, t.qty]), [['Wall-Bin2', 20]], 'planned again from the other bin');
});

test('put-away suggests a bin that already holds the item, then an empty one, never a held or full one', () => {
  const w = wh();
  w.locations['Wall-Bin2'].capacity = { maxWeightKg: 1 };
  w.binPut({ loc: 'Wall-Bin2', itemNo: 'M3', qty: 95 });
  w.binPut({ loc: 'Wall-Bin1', itemNo: 'AA', qty: 5 });
  let hint = w.suggestBin('M3', 5);
  assert.deepEqual([hint.best.loc, hint.best.why], ['Wall-Bin2', 'already holds M3']);
  hint = w.suggestBin('M3', 10);
  assert.equal(hint.best.loc, 'Wall-Bin3', 'Bin2 has no room for 10 more; the first empty bin');
  w.raiseCheck({ loc: 'Wall-Bin3', note: 'Shelf loose' });
  assert.equal(w.suggestBin('M3', 10).best.loc, 'Wall-Bin4');
  w.setBinMode({ code: 'Wall-Bin4', mixed: false });
  w.binPut({ loc: 'Wall-Bin4', itemNo: 'AA', qty: 1 });
  assert.equal(w.suggestBin('M3', 10).best, null, 'no bin can take it');
  assert.throws(() => w.suggestBin('NOPE'), /Unknown item NOPE/);
});

test('the bin handheld page is served, and pickers claim and report through the API', async () => {
  const site = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'server', 'site.blank.json'), 'utf8'));
  const store = new Store({ site });
  loadSample(store, '3pl');
  const auth = createAuth(store.db);
  auth.ensureDemoUsers();
  const server = createServer({ store, printers: new Printers({}), auth });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = async (u, p) => (await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) })).headers.get('set-cookie').split(';')[0];
  const call = async (method, p, body, cookie) => {
    const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };
  try {
    const page = await fetch(base + '/bins');
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<script src="camera.js"><\/script>/);
    const office = await login('office', 'sorted-office');
    const picker = await login('picker', 'sorted-picker');
    const inbound = await login('inbound', 'sorted-inbound');
    assert.equal((await call('POST', '/api/waves', {}, office)).status, 200);
    const mine = await call('GET', '/api/waves/tasks?kind=bin&mine=1', null, picker);
    assert.equal(mine.status, 200);
    const t = mine.body[0];
    assert.equal((await call('POST', `/api/waves/tasks/${t.id}/claim`, {}, picker)).body.claimedBy, 'picker');
    assert.equal((await call('POST', `/api/waves/tasks/${t.id}/claim`, {}, inbound)).status, 403, 'only pickers pick');
    const short = await call('POST', `/api/waves/tasks/${t.id}/short`, { found: 0 }, picker);
    assert.equal(short.status, 200, short.body.error);
    assert.equal(t.itemNo, 'CABLE-C');
    assert.equal((await call('GET', '/api/bins/suggest?item=CABLE-C&qty=10', null, inbound)).body.best.why, 'empty', 'the cable bin is held after the short pick');
    assert.equal((await call('GET', '/api/bins/suggest?item=MOUSE-W&qty=10', null, inbound)).body.best.why, 'already holds MOUSE-W');
  } finally {
    await new Promise((r) => server.close(r));
    store.close();
  }
});
