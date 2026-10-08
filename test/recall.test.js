const test = require('node:test');
const assert = require('node:assert/strict');
const { Warehouse } = require('../src/engine');
const { buildWarehouse } = require('../server/site');
const { Store } = require('../server/store');
const { createApi } = require('../server/api');
const { Walkthrough } = require('../src/walkthrough');
const site = require('../server/site.example.json');
const now = () => Date.UTC(2026, 9, 8, 6);

function setup() {
  const wh = buildWarehouse(site, now);
  wh.setConfig({ groundNextPerItem: 0, checkAfterPick: false });
  const add = (code, batch, expiry = '2026-11-20', itemNo = 'Y1001') => wh.stockPallet(wh.resolve(code), { itemNo, batch, expiry });
  return { wh, add };
}

test('recall validation is atomic, including duplicate holds and missing release reasons', () => {
  const { wh, add } = setup();
  add('AA01A1', 'A');
  const before = JSON.stringify(wh);
  for (const args of [['UNKNOWN', 'A', 'Notice'], ['Y1001', ' ', 'Notice'], ['Y1001', 'A', ' ']]) {
    assert.throws(() => wh.placeBatchHold(...args));
    assert.equal(JSON.stringify(wh), before);
  }
  wh.placeBatchHold('Y1001', ' a ', 'Supplier notice', 'office');
  const held = JSON.stringify(wh);
  assert.throws(() => wh.placeBatchHold('Y1001', 'A', 'Duplicate'));
  assert.throws(() => wh.releaseBatchHold('Y1001', 'A', ' '));
  assert.equal(JSON.stringify(wh), held);
});

test('all batch pallets are excluded before replacements; same batch on another item is unaffected', () => {
  const { wh, add } = setup();
  const first = add('AA01A1', 'A');
  const second = add('AB01A1', 'a');
  const clear = add('AA02A1', 'B', '2026-12-20');
  const otherItem = Object.keys(wh.items).find((id) => id !== 'Y1001');
  const other = add('AB02A1', 'A', '2026-11-20', otherItem);
  wh.addOrder({ id: 'R1', customer: 'Shop', lane: 'OUT-01', lines: [{ itemNo: 'Y1001', pallets: 2 }] });
  wh.addTruck('RT1', { categories: ['YOG'] });
  const oldTasks = Object.values(wh.tasks).filter((t) => t.type === 'PICK');
  wh.placeBatchHold('Y1001', 'A', 'Notice');
  assert.equal(wh.shipState(first), 'blocked');
  assert.equal(wh.shipState(second), 'blocked');
  assert.equal(wh.shipState(other), 'ok');
  assert.deepEqual(wh.orders.R1.lines[0].allocated, [clear.sscc]);
  assert.equal(wh.orders.R1.lines[0].short, 1);
  assert.equal(wh.tasks[wh.trucks.RT1.taskId].sscc, clear.sscc);
  assert.ok(oldTasks.every((t) => t.status === 'held'));
  for (const task of oldTasks) wh.releaseTask(task.id);
  assert.ok(oldTasks.every((t) => t.status === 'cancelled'), 'removed allocations cannot be resurrected');
  const r = wh.batchRecall('Y1001', 'A');
  assert.equal(r.openOrders[0].id, 'R1');
  assert.equal(r.openOrders[0].heldPallets.length, 0, 'replaced orders remain visible in the report');
});

test('recall holds apply to future receipts and survive snapshots, without clearing independent holds', () => {
  const { wh, add } = setup();
  wh.placeBatchHold('Y1001', 'FUTURE', 'Supplier notice before arrival', 'office');
  const p = add('DOCK-IN', 'future');
  assert.equal(wh.shipState(p), 'blocked');
  wh.setPalletStatus(p.sscc, 'available');
  wh.allowShortShip(p.sscc);
  assert.equal(wh.shipState(p), 'blocked');
  wh.recordTemperature(p.sscc, 9, 2, 6, 'Independent quality hold');
  wh.setPalletStatus(p.sscc, 'blocked', 'Damaged');
  const restored = Warehouse.restore(wh.toJSON(), { clock: now });
  assert.equal(restored.shipState(restored.pallets[p.sscc]), 'blocked');
  wh.releaseBatchHold('Y1001', 'future', 'Supplier withdrew notice', 'quality');
  assert.equal(wh.shipState(p), 'blocked');
  assert.ok(p.qualityHold);
  assert.equal(p.blockReason, 'Damaged');
  wh.releaseQualityHold(p.sscc, 'Quality accepted');
  assert.equal(wh.shipState(p), 'blocked');
  wh.setPalletStatus(p.sscc, 'available');
  assert.equal(wh.shipState(p), 'ok');
  wh.placeBatchHold('Y1001', 'FUTURE', 'New notice');
  assert.equal(wh.shipState(p), 'blocked');
  assert.deepEqual(wh.batchRecall('Y1001', 'FUTURE').history.map((e) => e.kind), ['hold', 'release', 'hold']);
});

test('a recalled pallet on the forks can be dropped but not checked or shipped', () => {
  const { wh, add } = setup();
  wh.setConfig({ checkAfterPick: true });
  const p = add('AA01A1', 'A');
  wh.addOrder({ id: 'R1', customer: 'Shop', lane: 'OUT-01', lines: [{ itemNo: 'Y1001', pallets: 1 }] });
  wh.addTruck('RT1', { categories: ['YOG'] });
  assert.ok(wh.scan('RT1', p.sscc).ok);
  wh.placeBatchHold('Y1001', 'A', 'Notice');
  assert.equal(wh.trucks.RT1.load, p.sscc);
  assert.ok(wh.scan('RT1', 'OUT-01').ok);
  assert.equal(wh.scan('RT1', p.sscc).ok, false);
  assert.match(wh.trucks.RT1.message.text, /Batch recall/);
  assert.equal(wh.printQueue.length, 0);
  wh.releaseBatchHold('Y1001', 'A', 'Review accepted');
  assert.ok(wh.scan('RT1', p.sscc).ok);
  assert.ok(wh.scan('RT1', wh.instruction('RT1').target).ok);
  wh.shipOrder('R1');
  assert.equal(p.status, 'shipped');
});

test('recall API journals decisions and rebuilds item-scoped reports with stock and shipped recipients', () => {
  const store = new Store({ site, now });
  try {
    const api = createApi({ store, printers: { flush() {}, results: [] } });
    const post = (path, body, by = 'office') => api.handle('POST', path, body, by);
    store.exec('importStock', { rows: [{ code: 'AA01A1', sscc: '387999990000091016', itemNo: 'Y1001', batch: 'A', expiry: '2026-11-20' }] }, 'setup');
    store.exec('setConfig', { patch: { groundNextPerItem: 0, checkAfterPick: false } });
    store.exec('addOrder', { id: 'R1', customer: 'Fresh Market', lane: 'OUT-01', lines: [{ itemNo: 'Y1001', pallets: 1 }] });
    store.exec('addTruck', { id: 'RT1', categories: ['YOG'] });
    store.exec('scan', { id: 'RT1', code: '387999990000091016' });
    store.exec('scan', { id: 'RT1', code: 'OUT-01' });
    store.exec('shipOrder', { id: 'R1' });
    assert.equal(post('/api/recalls', { itemNo: 'Y1001', batch: 'A', reason: 'Notice' }, 'recall-desk').status, 200);
    assert.equal(post('/api/recalls/release', { itemNo: 'Y1001', batch: 'A', reason: '' }).status, 400);
    let r = api.handle('GET', '/api/recalls/preview?itemNo=Y1001&batch=a').body;
    assert.equal(r.active, true);
    assert.equal(r.shipped[0].customer, 'Fresh Market');
    assert.equal(r.shipped[0].qty, 96);
    assert.equal(r.inStock.length, 0);
    assert.equal(post('/api/recalls/release', { itemNo: 'Y1001', batch: 'A', reason: 'Review accepted' }, 'quality').status, 200);
    const before = JSON.stringify(store.wh);
    store.load();
    assert.equal(JSON.stringify(store.wh), before);
    r = api.handle('GET', '/api/recalls').body[0];
    assert.equal(r.active, false);
    assert.deepEqual(r.history.map((e) => e.by), ['recall-desk', 'quality']);
  } finally { store.db.close(); }
});

test('a hold placed after label printing prevents label confirmation until release', () => {
  const { wh, add } = setup();
  wh.setConfig({ checkAfterPick: true });
  const p = add('AA01A1', 'A');
  wh.addOrder({ id: 'R1', customer: 'Shop', lane: 'OUT-01', lines: [{ itemNo: 'Y1001', pallets: 1 }] });
  wh.addTruck('RT1', { categories: ['YOG'] });
  wh.scan('RT1', p.sscc);
  wh.scan('RT1', 'OUT-01');
  wh.scan('RT1', p.sscc);
  const label = wh.instruction('RT1').target;
  wh.placeBatchHold('Y1001', 'A', 'Late notice');
  assert.equal(wh.scan('RT1', label).ok, false);
  assert.equal(p.checked, false);
  assert.notEqual(wh.orders.R1.status, 'ready');
  const api = createApi({ store: { wh }, printers: { flush() {}, results: [] } });
  assert.match(api.handle('GET', '/api/orders').body[0].shippingHolds[0].reason, /Batch recall/);
  wh.releaseBatchHold('Y1001', 'A', 'Review accepted');
  assert.equal(wh.scan('RT1', label).ok, true);
  assert.equal(wh.orders.R1.status, 'ready');
  assert.deepEqual(api.handle('GET', '/api/orders').body[0].shippingHolds, []);
  assert.equal(wh.printQueue.length, 1, 'the existing label is not printed twice');
});

test('guided recall catches ready, uncollected and late stock, then releases only the batch hold', () => {
  const demo = new Walkthrough(site, 'recall');
  while (demo.index < 15) demo.next();
  assert.equal(demo.wh.orders['4802'].status, 'ready');
  assert.deepEqual(demo.wh.orders['4803'].lines[0].allocated, [demo.fourth]);
  const before = JSON.stringify(demo.wh);
  assert.throws(() => demo.wh.shipOrder('4802'), /Batch recall/);
  assert.equal(JSON.stringify(demo.wh), before);
  while (demo.index < 19) demo.next();
  assert.equal(demo.wh.shipState(demo.wh.pallets[demo.fifth]), 'blocked');
  assert.match(demo.wh.desks.DESK1.message.text, /BLOCKED: Batch recall/);
  assert.deepEqual(demo.trace.customers, ['Fresh Market']);
  assert.equal(demo.trace.inStock.length, 3);
  while (demo.step) demo.next();
  assert.equal(demo.wh.orders['4802'].status, 'shipped');
  assert.equal(demo.wh.shipState(demo.wh.pallets[demo.third]), 'blocked');
  assert.equal(demo.wh.shipState(demo.wh.pallets[demo.fifth]), 'ok');
  assert.equal(demo.wh.batchRecall('Y1001', 'YOG-RECALL').active, false);
});
