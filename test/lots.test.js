const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Warehouse } = require('../src/engine');
const { Store } = require('../server/store');
const GS1 = require('../src/gs1');

const sscc = (n) => { const body = String(n).padStart(17, '0'); return body + GS1.checkDigit(body); };

// Yoghurt pots, 12 to a tray, loose trays and pots in chilled bins. Today is 2 November 2026.
function wh() {
  const w = new Warehouse({ aisles: [1], bays: 2, levels: 2, positions: [10], outLanes: 1, clock: () => Date.UTC(2026, 10, 2, 8) });
  w.setFeatures({ lotExpiry: true, fefo: true });
  w.addItem({ itemNo: 'YOG', name: 'Strawberry yoghurt', category: 'YOG', palletQty: 960, uom: 'pot', minShipDays: 7 });
  w.setItemUnits('YOG', { packs: [{ unit: 'tray', per: 12 }] });
  w.generateGuided({ sections: { count: 1, name: 'Chill' }, layouts: [{ type: 'shelf', positions: { count: 3, name: 'Bin 1' } }] });
  return w;
}

const order = (w, id, units, extra = {}) => w.addOrder({ id, customer: extra.customer || 'Corner shop', lane: 'OUT-01', lines: [{ itemNo: 'YOG', units }], minDays: extra.minDays });
const lots = (wave) => wave.tasks.map((t) => [t.loc, t.qty, t.batch, t.expiry]);

test('a wave names the batch to take from each bin, earliest best-before first, and the pick takes that batch', () => {
  const w = wh();
  w.binPut({ loc: 'Chill-Bin1', itemNo: 'YOG', qty: 10, batch: 'L-LATE', expiry: '2026-12-30' });
  w.binPut({ loc: 'Chill-Bin1', itemNo: 'YOG', qty: 3, batch: 'L-EARLY', expiry: '2026-11-20' });
  w.binPut({ loc: 'Chill-Bin2', itemNo: 'YOG', qty: 4, batch: 'L-MID', expiry: '2026-11-25' });
  order(w, 'SO1', 6);
  const wave = w.planWave({ orders: ['SO1'] });
  assert.deepEqual(lots(wave), [['Chill-Bin1', 3, 'L-EARLY', '2026-11-20'], ['Chill-Bin2', 3, 'L-MID', '2026-11-25']]);
  for (const t of wave.tasks) w.confirmWaveTask({ task: t.id });
  assert.deepEqual(w.binContents('Chill-Bin1').lines.map((l) => [l.batch, l.qty]), [['L-LATE', 10]], 'the later batch is untouched');
  assert.deepEqual(w.orders.SO1.staged.map((s) => [s.batch, s.qty]), [['L-EARLY', 3], ['L-MID', 3]]);
});

test('a pick task holds to its batch: if that batch is gone the picker is told, not given another', () => {
  const w = wh();
  w.binPut({ loc: 'Chill-Bin1', itemNo: 'YOG', qty: 5, batch: 'A', expiry: '2026-11-20' });
  w.binPut({ loc: 'Chill-Bin1', itemNo: 'YOG', qty: 5, batch: 'B', expiry: '2026-12-20' });
  order(w, 'SO1', 4);
  const wave = w.planWave({ orders: ['SO1'] });
  w.binMove({ from: 'Chill-Bin1', to: 'Chill-Bin3', itemNo: 'YOG', qty: 5, batch: 'A' });
  assert.throws(() => w.confirmWaveTask({ task: wave.tasks[0].id }), /Chill-Bin1 has 0 .*batch A, best before 2026-11-20.*not 4/);
});

test('expired and short-dated stock stays out of picks; an order can take fewer or need more days left', () => {
  const w = wh();
  w.binPut({ loc: 'Chill-Bin1', itemNo: 'YOG', qty: 6, batch: 'OLD', expiry: '2026-11-01' });
  w.binPut({ loc: 'Chill-Bin1', itemNo: 'YOG', qty: 6, batch: 'SOON', expiry: '2026-11-05' });
  w.binPut({ loc: 'Chill-Bin2', itemNo: 'YOG', qty: 6, batch: 'FRESH', expiry: '2026-12-20' });
  order(w, 'SO1', 8);
  assert.throws(() => w.planWave({ orders: ['SO1'] }), /Nothing in stock to pick \(YOG × 8\)/, 'nothing fits: 6 fresh pots are not enough');
  assert.throws(() => w.binTake({ loc: 'Chill-Bin1', itemNo: 'YOG', qty: 2, orderId: 'SO1' }), /has 0 YOG that can go on order SO1, not 2: 6 batch OLD, best before 2026-11-01 expired; 6 batch SOON, best before 2026-11-05 too short-dated \(under 7 days\)/);

  order(w, 'NEAR', 6, { customer: 'Outlet store', minDays: 0 });
  assert.deepEqual(lots(w.planWave({ orders: ['NEAR'] })), [['Chill-Bin1', 6, 'SOON', '2026-11-05']], 'a near-expiry buyer takes the short-dated pots, never the expired ones');

  order(w, 'SUPER', 6, { customer: 'Supermarket', minDays: 60 });
  assert.throws(() => w.planWave({ orders: ['SUPER'] }), /YOG × 6/, 'the supermarket wants 60 days and gets none of the fresh batch');
  assert.throws(() => order(w, 'BAD', 1, { minDays: -1 }), /whole number of 0 or more/);
  assert.deepEqual(w.bestBeforeWatch({ days: 7 }).map((r) => [r.batch, r.daysLeft, r.state]), [['OLD', -1, 'expired'], ['SOON', 3, 'short']]);
  const off = w.binCount({ loc: 'Chill-Bin1', itemNo: 'YOG', batch: 'OLD', counted: 0, reason: 'expiry' });
  assert.deepEqual([off.before, off.after], [6, 0]);
  assert.deepEqual(w.binContents('Chill-Bin1').lines.map((l) => [l.batch, l.qty]), [['SOON', 6]], 'only the expired batch is written off');
  assert.deepEqual(w.stockChanges({}).rows.map((r) => [r.reason, r.change]), [['expiry', -6]]);
});

test('short-dated boxes from a pallet go only to an order that takes them', () => {
  const w = wh();
  w.stockPallet('01-01-0-10', { sscc: sscc(1), itemNo: 'YOG', qty: 960, batch: 'P1', expiry: '2026-11-06', receivedAt: 1 });
  order(w, 'SO1', 24);
  assert.throws(() => w.planWave({ orders: ['SO1'] }), /YOG × 24/);
  order(w, 'SO2', 24, { minDays: 2 });
  assert.deepEqual(w.planWave({ orders: ['SO2'] }).tasks.map((t) => [t.kind, t.qty, t.batch, t.box]), [['case', 24, 'P1', 'whole']]);
});

test('a batch recall stops loose picks and packing, and finds the customers who got it in cartons', () => {
  const w = wh();
  w.binPut({ loc: 'Chill-Bin1', itemNo: 'YOG', qty: 30, batch: 'R1', expiry: '2026-12-10' });
  w.binPut({ loc: 'Chill-Bin2', itemNo: 'YOG', qty: 30, batch: 'OK', expiry: '2026-12-20' });
  order(w, 'SO1', 6, { customer: 'Cafe Uno' });
  w.binTake({ loc: 'Chill-Bin1', itemNo: 'YOG', qty: 6, orderId: 'SO1' });
  const box = w.openCarton({ orderId: 'SO1' });
  w.packIntoCarton({ carton: box.id, code: 'Chill-Bin1', qty: 6 });
  const { slip } = w.closeCarton({ carton: box.id, lengthMm: 300, widthMm: 200, heightMm: 150, weightKg: 1 });
  assert.match(slip.zpl, /\^FDBatch R1  BB 2026-12-10\^FS/);
  assert.match(w.packingSlipHtml(box.id), /<td>R1<\/td><td>2026-12-10<\/td>/);
  w.dispatchCartons({ orderId: 'SO1' });

  order(w, 'SO2', 4, { customer: 'Cafe Due' });
  w.binTake({ loc: 'Chill-Bin1', itemNo: 'YOG', qty: 4, orderId: 'SO2' });
  w.placeBatchHold('YOG', 'r1', 'Supplier recall', 'office');
  const two = w.openCarton({ orderId: 'SO2' });
  assert.throws(() => w.packIntoCarton({ carton: two.id, code: 'Chill-Bin1', qty: 4 }), /batch R1 is on a recall hold/);
  order(w, 'SO3', 6);
  assert.throws(() => w.binTake({ loc: 'Chill-Bin1', itemNo: 'YOG', qty: 1, orderId: 'SO3' }), /on a batch hold/);
  assert.deepEqual(lots(w.planWave({ orders: ['SO3'] })), [['Chill-Bin2', 6, 'OK', '2026-12-20']]);

  const r = w.batchRecall('YOG', 'R1');
  assert.deepEqual(r.customers, ['Cafe Uno']);
  assert.deepEqual(r.cartons.map((c) => [c.carton, c.qty, c.orderId]), [[box.id, 6, 'SO1']]);
  assert.deepEqual(r.inBins, [{ loc: 'Chill-Bin1', itemNo: 'YOG', qty: 20, batch: 'R1', expiry: '2026-12-10' }]);
  assert.deepEqual(r.picked.map((x) => [x.orderId, x.qty]), [['SO2', 4]]);
  assert.deepEqual(r.openOrders.map((o) => o.id), ['SO2']);
});

test('the delivery note lists batch and best-before per carton and pallet', () => {
  const w = wh();
  w.binPut({ loc: 'Chill-Bin1', itemNo: 'YOG', qty: 8, batch: 'D1', expiry: '2026-12-01' });
  w.binPut({ loc: 'Chill-Bin1', itemNo: 'YOG', qty: 8, batch: 'D2', expiry: '2026-12-15' });
  order(w, 'SO1', 10);
  w.binTake({ loc: 'Chill-Bin1', itemNo: 'YOG', qty: 10, orderId: 'SO1' });
  const box = w.openCarton({ orderId: 'SO1' });
  w.packIntoCarton({ carton: box.id, code: 'Chill-Bin1', qty: 8 });
  w.packIntoCarton({ carton: box.id, code: 'Chill-Bin1', qty: 2 });
  w.closeCarton({ carton: box.id, lengthMm: 300, widthMm: 200, heightMm: 150, weightKg: 2 });
  w.stageShipment({ orderId: 'SO1' });
  const note = w.deliveryNote('SO1');
  assert.match(note, /<h2>Batches and best-before<\/h2>/);
  assert.match(note, new RegExp(`<td>${box.id}</td><td>YOG</td><td>D1</td><td>2026-12-01</td><td>8</td>`));
  assert.match(note, new RegExp(`<td>${box.id}</td><td>YOG</td><td>D2</td><td>2026-12-15</td><td>2</td>`));
});

test('an order\'s minimum days left is journaled and replays', () => {
  const site = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'server', 'site.blank.json'), 'utf8'));
  const store = new Store({ site });
  try {
    store.exec('applyPreset', { id: 'home-garage' }, 'test');
    store.exec('addItem', { itemNo: 'Y', name: 'Yoghurt', category: 'HOME', palletQty: 10, uom: 'pot' }, 'test');
    store.exec('addOrder', { id: 'O1', customer: 'Outlet', lane: 'OUT-01', lines: [{ itemNo: 'Y', units: 2 }], minDays: 1 }, 'test');
    store.load();
    assert.equal(store.wh.orders.O1.minDays, 1);
  } finally {
    store.close();
  }
});
