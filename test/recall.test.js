const test = require('node:test');
const assert = require('node:assert/strict');
const { Warehouse } = require('../src/engine');
const { buildWarehouse } = require('../server/site');
const { Store } = require('../server/store');
const { createApi } = require('../server/api');
const site = require('./fixtures/site.json');
const now = () => Date.UTC(2026, 9, 8, 6);

function setup() {
  const wh = buildWarehouse(site, now);
  wh.setConfig({ groundNextPerItem: 0, checkAfterPick: false });
  const add = (code, batch, expiry = '2026-11-20', itemNo = 'W1001') => wh.stockPallet(wh.resolve(code), { itemNo, batch, expiry });
  return { wh, add };
}

test('recall validation is atomic, including duplicate holds and missing release reasons', () => {
  const { wh, add } = setup();
  add('AA01A1', 'A');
  const before = JSON.stringify(wh);
  for (const args of [['UNKNOWN', 'A', 'Notice'], ['W1001', ' ', 'Notice'], ['W1001', 'A', ' ']]) {
    assert.throws(() => wh.placeBatchHold(...args));
    assert.equal(JSON.stringify(wh), before);
  }
  wh.placeBatchHold('W1001', ' a ', 'Supplier notice', 'office');
  const held = JSON.stringify(wh);
  assert.throws(() => wh.placeBatchHold('W1001', 'A', 'Duplicate'));
  assert.throws(() => wh.releaseBatchHold('W1001', 'A', ' '));
  assert.equal(JSON.stringify(wh), held);
});

test('all batch pallets are excluded before replacements; same batch on another item is unaffected', () => {
  const { wh, add } = setup();
  const first = add('AA01A1', 'A');
  const second = add('AB01A1', 'a');
  const clear = add('AA02A1', 'B', '2026-12-20');
  const otherItem = Object.keys(wh.items).find((id) => id !== 'W1001');
  const other = add('AB02A1', 'A', '2026-11-20', otherItem);
  wh.addOrder({ id: 'R1', customer: 'Shop', lane: 'OUT-01', lines: [{ itemNo: 'W1001', pallets: 2 }] });
  wh.addTruck('RT1', { categories: ['GEN'] });
  const oldTasks = Object.values(wh.tasks).filter((t) => t.type === 'PICK');
  wh.placeBatchHold('W1001', 'A', 'Notice');
  assert.equal(wh.shipState(first), 'blocked');
  assert.equal(wh.shipState(second), 'blocked');
  assert.equal(wh.shipState(other), 'ok');
  assert.deepEqual(wh.orders.R1.lines[0].allocated, [clear.sscc]);
  assert.equal(wh.orders.R1.lines[0].short, 1);
  assert.equal(wh.tasks[wh.trucks.RT1.taskId].sscc, clear.sscc);
  assert.ok(oldTasks.every((t) => t.status === 'held'));
  for (const task of oldTasks) wh.releaseTask(task.id);
  assert.ok(oldTasks.every((t) => t.status === 'cancelled'), 'removed allocations cannot be resurrected');
  const r = wh.batchRecall('W1001', 'A');
  assert.equal(r.openOrders[0].id, 'R1');
  assert.equal(r.openOrders[0].heldPallets.length, 0, 'replaced orders remain visible in the report');
});

test('recall holds apply to future receipts and survive snapshots, without clearing independent holds', () => {
  const { wh, add } = setup();
  wh.placeBatchHold('W1001', 'FUTURE', 'Supplier notice before arrival', 'office');
  const p = add('DOCK-IN', 'future');
  assert.equal(wh.shipState(p), 'blocked');
  wh.setPalletStatus(p.sscc, 'available');
  wh.allowShortShip(p.sscc);
  assert.equal(wh.shipState(p), 'blocked');
  wh.recordTemperature(p.sscc, 9, 2, 6, 'Independent quality hold');
  wh.setPalletStatus(p.sscc, 'blocked', 'Damaged');
  const restored = Warehouse.restore(wh.toJSON(), { clock: now });
  assert.equal(restored.shipState(restored.pallets[p.sscc]), 'blocked');
  wh.releaseBatchHold('W1001', 'future', 'Supplier withdrew notice', 'quality');
  assert.equal(wh.shipState(p), 'blocked');
  assert.ok(p.qualityHold);
  assert.equal(p.blockReason, 'Damaged');
  wh.releaseQualityHold(p.sscc, 'Quality accepted');
  assert.equal(wh.shipState(p), 'blocked');
  wh.setPalletStatus(p.sscc, 'available');
  assert.equal(wh.shipState(p), 'ok');
  wh.placeBatchHold('W1001', 'FUTURE', 'New notice');
  assert.equal(wh.shipState(p), 'blocked');
  assert.deepEqual(wh.batchRecall('W1001', 'FUTURE').history.map((e) => e.kind), ['hold', 'release', 'hold']);
});

test('a recalled pallet on the forks can be dropped but not checked or shipped', () => {
  const { wh, add } = setup();
  wh.setConfig({ checkAfterPick: true });
  const p = add('AA01A1', 'A');
  wh.addOrder({ id: 'R1', customer: 'Shop', lane: 'OUT-01', lines: [{ itemNo: 'W1001', pallets: 1 }] });
  wh.addTruck('RT1', { categories: ['GEN'] });
  assert.ok(wh.scan('RT1', p.sscc).ok);
  wh.placeBatchHold('W1001', 'A', 'Notice');
  assert.equal(wh.trucks.RT1.load, p.sscc);
  assert.ok(wh.scan('RT1', 'OUT-01').ok);
  assert.equal(wh.scan('RT1', p.sscc).ok, false);
  assert.match(wh.trucks.RT1.message.text, /Batch recall/);
  assert.equal(wh.printQueue.length, 0);
  wh.releaseBatchHold('W1001', 'A', 'Review accepted');
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
    store.exec('importStock', { rows: [{ code: 'AA01A1', sscc: '387999990000091016', itemNo: 'W1001', batch: 'A', expiry: '2026-11-20' }] }, 'setup');
    store.exec('setConfig', { patch: { groundNextPerItem: 0, checkAfterPick: false } });
    store.exec('addOrder', { id: 'R1', customer: 'Harbour Hardware', lane: 'OUT-01', lines: [{ itemNo: 'W1001', pallets: 1 }] });
    store.exec('addTruck', { id: 'RT1', categories: ['GEN'] });
    store.exec('scan', { id: 'RT1', code: '387999990000091016' });
    store.exec('scan', { id: 'RT1', code: 'OUT-01' });
    store.exec('shipOrder', { id: 'R1' });
    assert.equal(post('/api/recalls', { itemNo: 'W1001', batch: 'A', reason: 'Notice' }, 'recall-desk').status, 200);
    assert.equal(post('/api/recalls/release', { itemNo: 'W1001', batch: 'A', reason: '' }).status, 400);
    let r = api.handle('GET', '/api/recalls/preview?itemNo=W1001&batch=a').body;
    assert.equal(r.active, true);
    assert.equal(r.shipped[0].customer, 'Harbour Hardware');
    assert.equal(r.shipped[0].qty, 96);
    assert.equal(r.inStock.length, 0);
    assert.equal(post('/api/recalls/release', { itemNo: 'W1001', batch: 'A', reason: 'Review accepted' }, 'quality').status, 200);
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
  wh.addOrder({ id: 'R1', customer: 'Shop', lane: 'OUT-01', lines: [{ itemNo: 'W1001', pallets: 1 }] });
  wh.addTruck('RT1', { categories: ['GEN'] });
  wh.scan('RT1', p.sscc);
  wh.scan('RT1', 'OUT-01');
  wh.scan('RT1', p.sscc);
  const label = wh.instruction('RT1').target;
  wh.placeBatchHold('W1001', 'A', 'Late notice');
  assert.equal(wh.scan('RT1', label).ok, false);
  assert.equal(p.checked, false);
  assert.notEqual(wh.orders.R1.status, 'ready');
  const api = createApi({ store: { wh }, printers: { flush() {}, results: [] } });
  assert.match(api.handle('GET', '/api/orders').body[0].shippingHolds[0].reason, /Batch recall/);
  wh.releaseBatchHold('W1001', 'A', 'Review accepted');
  assert.equal(wh.scan('RT1', label).ok, true);
  assert.equal(wh.orders.R1.status, 'ready');
  assert.deepEqual(api.handle('GET', '/api/orders').body[0].shippingHolds, []);
  assert.equal(wh.printQueue.length, 1, 'the existing label is not printed twice');
});
