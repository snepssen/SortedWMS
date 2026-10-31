const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Warehouse } = require('../src/engine');
const { Store } = require('../server/store');
const { Printers } = require('../server/print');
const { createServer } = require('../server/index');
const { createAuth } = require('../server/auth');
const GS1 = require('../src/gs1');

const sscc = (n) => { const body = String(n).padStart(17, '0'); return body + GS1.checkDigit(body); };

// Screws come in boxes of 5000, 40 boxes to a pallet. Pallets stand in the
// racks; loose screws sit in shelf bins on the mezzanine.
function wh() {
  const w = new Warehouse({ aisles: [1], bays: 2, levels: 2, positions: [10], outLanes: 1, clock: () => Date.UTC(2026, 9, 8, 8) });
  w.addItem({ itemNo: 'M3', name: 'M3 screw', category: 'YOG', palletQty: 200000, uom: 'piece' });
  w.setItemUnits('M3', { packs: [{ unit: 'box', per: 5000 }] });
  w.generateGuided({ sections: { count: 1, name: 'Mezz' }, layouts: [{ type: 'shelf', bays: { count: 1, name: 'Shelf 1' }, positions: { count: 3, name: 'Bin 1' } }] });
  return w;
}

const tasksOf = (wave) => wave.tasks.map((t) => [t.kind, t.qty, t.loc, t.box || null]);
const MIN = 60000;

// A clock the test can move forward.
function timed() {
  let t = Date.UTC(2026, 9, 8, 8);
  const w = new Warehouse({ aisles: [1], bays: 2, levels: 2, positions: [10], outLanes: 1, clock: () => t });
  w.addItem({ itemNo: 'M3', name: 'M3 screw', category: 'YOG', palletQty: 200000, uom: 'piece' });
  w.setItemUnits('M3', { packs: [{ unit: 'box', per: 5000 }] });
  w.generateGuided({ sections: { count: 1, name: 'Mezz' }, layouts: [{ type: 'shelf', bays: { count: 1, name: 'Shelf 1' }, positions: { count: 3, name: 'Bin 1' } }] });
  w.createLocation({ code: 'POSTPICK', kind: 'virtual', role: 'staging', name: 'Post-pick lane' });
  return { w, later: (min) => { t += min * MIN; } };
}

test('5100 screws: one box from the pallet for the man-up, 100 from a bin', () => {
  const w = wh();
  w.stockPallet('01-01-1-10', { sscc: sscc(11), itemNo: 'M3', qty: 200000, receivedAt: 1 });
  w.binPut({ loc: 'Mezz-Shelf1-Bin1', itemNo: 'M3', qty: 300 });
  w.addOrder({ id: 'SO1', customer: 'Builder', lane: 'OUT-01', lines: [{ itemNo: 'M3', units: 5100 }] });
  const wave = w.planWave({ orders: ['SO1'] });
  assert.deepEqual(tasksOf(wave), [['case', 5000, '01-01-1-10', 'whole'], ['bin', 100, 'Mezz-Shelf1-Bin1', null]]);
  assert.equal(wave.tasks[0].role, 'man-up');
  assert.equal(wave.tasks[1].role, 'picker');
  assert.deepEqual(wave.short, []);
});

test('pallets first, then whole boxes, then the small pick', () => {
  const w = wh();
  w.setFeatures({ lotExpiry: true, fefo: true });
  w.stockPallet('01-01-1-10', { sscc: sscc(11), itemNo: 'M3', qty: 200000, expiry: '2029-01-01', receivedAt: 1 });
  w.stockPallet('01-02-1-10', { sscc: sscc(22), itemNo: 'M3', qty: 20000, expiry: '2028-01-01', receivedAt: 2 });
  w.binPut({ loc: 'Mezz-Shelf1-Bin1', itemNo: 'M3', qty: 500 });
  w.addOrder({ id: 'SO1', customer: 'Builder', lane: 'OUT-01', lines: [{ itemNo: 'M3', units: 30250 }] });
  const wave = w.planWave({ orders: ['SO1'] });
  assert.deepEqual(tasksOf(wave), [
    ['pallet', 20000, '01-02-1-10', null],
    ['case', 10000, '01-01-1-10', 'whole'],
    ['bin', 250, 'Mezz-Shelf1-Bin1', null],
  ]);
  assert.equal(wave.tasks[0].dropTo, 'OUT-01', 'a whole pallet goes straight to the dock');
});

test('when the bins cannot give the whole remainder, the man-up opens a box, and the next small pick takes from it', () => {
  const w = wh();
  w.stockPallet('01-01-1-10', { sscc: sscc(11), itemNo: 'M3', qty: 200000, receivedAt: 1 });
  w.binPut({ loc: 'Mezz-Shelf1-Bin1', itemNo: 'M3', qty: 60 });
  w.addOrder({ id: 'SO1', customer: 'A', lane: 'OUT-01', lines: [{ itemNo: 'M3', units: 5100 }] });
  w.addOrder({ id: 'SO2', customer: 'B', lane: 'OUT-01', lines: [{ itemNo: 'M3', units: 300 }] });
  const wave = w.planWave({ orders: ['SO1', 'SO2'] });
  assert.deepEqual(tasksOf(wave), [['case', 5000, '01-01-1-10', 'whole'], ['case', 100, '01-01-1-10', 'new'], ['case', 300, '01-01-1-10', 'open']]);
  assert.equal(w.binContents('Mezz-Shelf1-Bin1').lines[0].qty, 60, 'the bin is not emptied for part of a small pick');
  for (const t of wave.tasks) w.confirmWaveTask({ task: t.id });
  assert.equal(w.pallets[sscc(11)].openBox, 4600, 'one box opened for both orders');
  assert.equal(w.pallets[sscc(11)].qty, 194600);
});

test('the queue holds an order that would open a box until it has waited the maximum time', () => {
  const { w, later } = timed();
  w.setWaveConfig({ maxWaitMin: 60, postPick: 'POSTPICK' });
  w.stockPallet('01-01-1-10', { sscc: sscc(11), itemNo: 'M3', qty: 200000, receivedAt: 1 });
  w.addOrder({ id: 'SO1', customer: 'A', lane: 'OUT-01', lines: [{ itemNo: 'M3', units: 10000 }] });
  w.addOrder({ id: 'SO2', customer: 'B', lane: 'OUT-01', lines: [{ itemNo: 'M3', units: 40 }] });
  const first = w.autoWave();
  assert.deepEqual(first.orders, ['SO1'], 'whole boxes drop cleanly; SO2 would open a box and waits');
  assert.equal(first.tasks[0].dropTo, 'POSTPICK');
  assert.equal(w.autoWave(), null, 'nothing new while a wave is active');
  const queue = w.waveQueue();
  assert.deepEqual(queue.map((q) => [q.orderId, q.clean, q.due]), [['SO2', false, false]]);
  later(30);
  w.binPut({ loc: 'Mezz-Shelf1-Bin1', itemNo: 'M3', qty: 100 });
  w.addOrder({ id: 'SO3', customer: 'C', lane: 'OUT-01', lines: [{ itemNo: 'M3', units: 5000 }] });
  w.confirmWaveTask({ task: first.tasks[0].id });
  const second = Object.values(w.waves).find((x) => x.id !== first.id);
  assert.ok(second, 'finishing a wave drops the queue into the next one');
  assert.deepEqual(second.orders, ['SO2', 'SO3'], 'the bin top-up let SO2 drop cleanly');
  assert.deepEqual(tasksOf(second), [['bin', 40, 'Mezz-Shelf1-Bin1', null], ['case', 5000, '01-01-1-10', 'whole']]);
});

test('an order that has waited the maximum time goes out with an opened box, on the clock tick', () => {
  const { w, later } = timed();
  w.setWaveConfig({ maxWaitMin: 60 });
  w.stockPallet('01-01-1-10', { sscc: sscc(11), itemNo: 'M3', qty: 200000, receivedAt: 1 });
  w.addOrder({ id: 'SO2', customer: 'B', lane: 'OUT-01', lines: [{ itemNo: 'M3', units: 40 }] });
  assert.equal(w.autoWave(), null);
  later(61);
  const wave = w.autoWave();
  assert.deepEqual(tasksOf(wave), [['case', 40, '01-01-1-10', 'new']]);
  w.setWaveConfig({ auto: false });
  w.addOrder({ id: 'SO4', customer: 'D', lane: 'OUT-01', lines: [{ itemNo: 'M3', units: 5000 }] });
  w.confirmWaveTask({ task: wave.tasks[0].id });
  assert.equal(Object.keys(w.waves).length, 1, 'with automatic waves off, the office plans them');
});

test('a reach truck never gets a pallet pick from a bin or the mezzanine', () => {
  const w = wh();
  w.createLocation({ code: 'MEZZ-A1', kind: 'mezzanine', name: 'Mezzanine' });
  w.stockPallet('MEZZ-A1', { sscc: sscc(33), itemNo: 'M3', qty: 200000, receivedAt: 1 });
  assert.deepEqual(w._fefo('M3').map((p) => p.sscc), []);
  w.stockPallet('01-01-1-10', { sscc: sscc(11), itemNo: 'M3', qty: 200000, receivedAt: 2 });
  assert.deepEqual(w._fefo('M3').map((p) => p.sscc), [sscc(11)]);
  const order = w.addOrder({ id: 'SO9', customer: 'X', lane: 'OUT-01', lines: [{ itemNo: 'M3', pallets: 1 }] });
  assert.deepEqual(order.lines[0].allocated, [sscc(11)]);
});

test('confirming tasks picks the order, keeps the pallet in its slot, and goes on to packing', () => {
  const w = wh();
  w.stockPallet('01-01-1-10', { sscc: sscc(11), itemNo: 'M3', qty: 10001, receivedAt: 1 });
  w.binPut({ loc: 'Mezz-Shelf1-Bin1', itemNo: 'M3', qty: 300 });
  const order = w.addOrder({ id: 'SO1', customer: 'Builder', lane: 'OUT-01', lines: [{ itemNo: 'M3', units: 5100 }] });
  const wave = w.planWave({ orders: ['SO1'] });
  const [box, bin] = wave.tasks;
  assert.throws(() => w.confirmWaveTask({ task: box.id, scan: 'Mezz-Shelf1-Bin1' }), /Wrong place. Go to 01-01-1-10/);
  w.confirmWaveTask({ task: box.id, scan: sscc(11), by: 'manup1' });
  assert.equal(w.pallets[sscc(11)].qty, 5001);
  assert.equal(w.pallets[sscc(11)].loc, '01-01-1-10');
  assert.equal(order.status, 'picking');
  w.confirmWaveTask({ task: bin.id, scan: 'mezz-shelf1-bin1', by: 'cart1' });
  assert.equal(order.lines[0].picked, 5100);
  assert.equal(order.status, 'ready');
  assert.equal(w.binContents('Mezz-Shelf1-Bin1').lines[0].qty, 200);
  assert.throws(() => w.confirmWaveTask({ task: bin.id }), /is done/);
  assert.deepEqual(w.waveTasks({}), []);
  const carton = w.openCarton({ orderId: 'SO1' });
  w.packIntoCarton({ carton: carton.id, code: sscc(11), qty: 5000 });
  w.packIntoCarton({ carton: carton.id, code: 'Mezz-Shelf1-Bin1', qty: 100 });
  assert.equal(carton.packed.reduce((s, p) => s + p.qty, 0), 5100);
});

test('a whole pallet picked for a piece line ships with the cartons as one shipment', () => {
  const w = wh();
  w.stockPallet('01-01-1-10', { sscc: sscc(11), itemNo: 'M3', qty: 20000, receivedAt: 1 });
  w.binPut({ loc: 'Mezz-Shelf1-Bin1', itemNo: 'M3', qty: 100 });
  const order = w.addOrder({ id: 'SO1', customer: 'Builder', lane: 'OUT-01', lines: [{ itemNo: 'M3', units: 20050 }] });
  const wave = w.planWave({ orders: ['SO1'] });
  assert.deepEqual(tasksOf(wave), [['pallet', 20000, '01-01-1-10', null], ['bin', 50, 'Mezz-Shelf1-Bin1', null]]);
  for (const t of wave.tasks) w.confirmWaveTask({ task: t.id });
  assert.equal(w.pallets[sscc(11)].loc, 'OUT-01');
  const carton = w.openCarton({ orderId: 'SO1' });
  w.packIntoCarton({ carton: carton.id, code: 'Mezz-Shelf1-Bin1', qty: 50 });
  w.closeCarton({ carton: carton.id, lengthMm: 300, widthMm: 200, heightMm: 150, weightKg: 1 });
  assert.equal(order.status, 'packed');
  assert.throws(() => w.dispatchCartons({ orderId: 'SO1' }), /one shipment/);
  const ship = w.stageShipment({ orderId: 'SO1' });
  assert.deepEqual(ship.holders.map((h) => h.kind).sort(), ['carton', 'pallet']);
});

test('short stock is reported, a cancelled wave frees its stock, and an emptied pallet leaves its slot', () => {
  const w = wh();
  w.stockPallet('01-01-1-10', { sscc: sscc(11), itemNo: 'M3', qty: 7000, receivedAt: 1 });
  w.addOrder({ id: 'SO1', customer: 'A', lane: 'OUT-01', lines: [{ itemNo: 'M3', units: 12000 }] });
  const wave = w.planWave({ orders: ['SO1'] });
  assert.deepEqual(tasksOf(wave), [['pallet', 7000, '01-01-1-10', null]]);
  assert.deepEqual(wave.short, [{ orderId: 'SO1', itemNo: 'M3', qty: 5000 }]);
  w.cancelWave({ id: wave.id });
  w.adjustQuantity(sscc(11), 6000, 'recount');
  const again = w.planWave({ orders: ['SO1'] });
  assert.equal(again.tasks[0].qty, 6000);
  w.stockPallet('01-02-1-10', { sscc: sscc(22), itemNo: 'M3', qty: 3000, receivedAt: 2 });
  const third = w.planWave({ orders: ['SO1'] });
  assert.deepEqual(tasksOf(third), [['pallet', 3000, '01-02-1-10', null]]);
  w.confirmWaveTask({ task: again.tasks[0].id });
  assert.equal(w.locations['01-01-1-10'].sscc, null);
});

test('waves through the API: office plans, the man-up and the bin picker confirm, and a restart replays it', async () => {
  const site = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'server', 'site.example.json'), 'utf8'));
  const store = new Store({ site });
  const auth = createAuth(store.db);
  auth.ensureDemoUsers();
  const server = createServer({ store, printers: new Printers({}), auth });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = async (username, password) => (await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) })).headers.get('set-cookie').split(';')[0];
  const call = async (method, p, body, cookie) => {
    const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };
  try {
    const admin = await login('admin', 'sorted-admin');
    const office = await login('office', 'sorted-office');
    const inbound = await login('inbound', 'sorted-inbound');
    const picker = await login('picker', 'sorted-picker');
    const ok = (r) => { assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };
    ok(await call('POST', '/api/locations/guided', { answers: { sections: { count: 1, name: 'Mezz' }, layouts: [{ type: 'shelf', positions: { count: 2, name: 'Bin 1' } }] } }, admin));
    ok(await call('POST', '/api/items', { itemNo: 'M3', name: 'M3 screw', category: 'YOG', palletQty: 200000, uom: 'piece' }, admin));
    ok(await call('POST', '/api/items/M3/units', { packs: [{ unit: 'box', per: 5000 }] }, admin));
    const rack = store.wh._racks().find((l) => !l.sscc && !l.blocked && l.category === 'YOG').code;
    const added = store.exec('importStock', { rows: [{ code: rack, sscc: sscc(9911), itemNo: 'M3', qty: 200000, receivedAt: 1 }] }, 'admin');
    assert.equal(added.added, 1, JSON.stringify(added.errors));
    ok(await call('POST', '/api/bins/put', { loc: 'Mezz-Bin1', itemNo: 'M3', qty: 400 }, inbound));
    const lane = Object.values(store.wh.locations).find((l) => l.kind === 'lane' && l.role === 'out').code;
    ok(await call('POST', '/api/orders', { id: 'W-1', customer: 'Builder', lane, lines: [{ itemNo: 'M3', units: 10250 }] }, office));
    assert.equal((await call('POST', '/api/waves', { orders: ['W-1'] }, picker)).status, 403, 'the office plans waves');
    const wave = ok(await call('POST', '/api/waves', { orders: ['W-1'] }, office));
    assert.deepEqual(wave.tasks.map((t) => [t.kind, t.qty]), [['case', 10000], ['bin', 250]]);
    const queue = ok(await call('GET', '/api/waves/queue', null, office));
    assert.equal(queue.active, wave.id);
    const mine = ok(await call('GET', '/api/waves/tasks?kind=case', null, picker));
    assert.equal(mine.length, 1);
    ok(await call('POST', `/api/waves/tasks/${mine[0].id}/confirm`, { scan: rack }, picker));
    const bins = ok(await call('GET', '/api/waves/tasks?kind=bin', null, picker));
    ok(await call('POST', `/api/waves/tasks/${bins[0].id}/confirm`, { scan: 'Mezz-Bin1' }, picker));
    assert.equal(store.wh.orders['W-1'].lines[0].picked, 10250);
    store.load();
    assert.equal(store.wh.orders['W-1'].lines[0].picked, 10250, 'the journal replays the wave');
    assert.equal(store.wh.pallets[sscc(9911)].qty, 190000);
  } finally {
    await new Promise((r) => server.close(r));
    store.close();
  }
});
