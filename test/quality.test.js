const test = require('node:test');
const assert = require('node:assert/strict');
const { buildWarehouse } = require('../server/site');
const { Store } = require('../server/store');
const { createApi } = require('../server/api');
const { Walkthrough } = require('../src/walkthrough');
const site = require('../server/site.example.json');
const now = () => Date.UTC(2026, 9, 8, 6);

function setup() {
  const wh = buildWarehouse(site, now);
  wh.setConfig({ groundNextPerItem: 0, checkAfterPick: false });
  const first = wh.stockPallet(wh.resolve('AA01A1'), { itemNo: 'Y1001', batch: 'A', expiry: '2026-11-20' });
  const second = wh.stockPallet(wh.resolve('AB01A1'), { itemNo: 'Y1001', batch: 'B', expiry: '2026-12-20' });
  return { wh, first, second };
}

test('invalid inspections and release reasons leave quality state unchanged', () => {
  const { wh, first } = setup();
  const before = JSON.stringify(wh);
  for (const values of [[null, 2, 6, 'Note'], [NaN, 2, 6, 'Note'], [Infinity, 2, 6, 'Note'], [4, 6, 2, 'Note'], [4, 2, 6, ' ']]) {
    assert.throws(() => wh.recordTemperature(first.sscc, ...values));
    assert.equal(JSON.stringify(wh), before);
  }
  wh.recordTemperature(first.sscc, 9, 2, 6, 'Probe outside limits', 'receiver');
  const held = JSON.stringify(wh);
  assert.throws(() => wh.releaseQualityHold(first.sscc, ' '));
  assert.equal(JSON.stringify(wh), held);
});

test('normal readings do not clear holds and quality release does not clear damage', () => {
  const { wh, first } = setup();
  wh.recordTemperature(first.sscc, 9, 2, 6, 'Receiving concern', 'receiver');
  wh.setPalletStatus(first.sscc, 'available');
  assert.equal(wh.shipState(first), 'blocked', 'generic stock release cannot bypass a quality hold');
  wh.recordTemperature(first.sscc, 4, 2, 6, 'Follow-up', 'receiver');
  assert.equal(wh.shipState(first), 'blocked');
  assert.equal(first.qualityHold.temperature, 9);
  wh.setPalletStatus(first.sscc, 'blocked', 'Damaged packaging');
  wh.releaseQualityHold(first.sscc, 'Reviewed and accepted', 'quality');
  assert.equal(wh.shipState(first), 'blocked');
  assert.equal(first.blockReason, 'Damaged packaging');
  assert.equal(first.qualityHistory.length, 3);
  assert.equal(first.qualityHistory[2].by, 'quality');
  wh.setPalletStatus(first.sscc, 'available');
  assert.equal(wh.shipState(first), 'ok');
});

test('a new hold replaces a pick already assigned but not collected', () => {
  const { wh, first, second } = setup();
  wh.addOrder({ id: 'Q1', customer: 'Shop', lane: 'OUT-01', lines: [{ itemNo: 'Y1001', pallets: 1 }] });
  wh.addTruck('RT1', { categories: ['YOG'] });
  const old = wh.tasks[wh.trucks.RT1.taskId];
  assert.equal(old.sscc, first.sscc);
  wh.recordTemperature(first.sscc, 9, 2, 6, 'Quality concern');
  assert.equal(old.status, 'held');
  assert.equal(wh.tasks[wh.trucks.RT1.taskId].sscc, second.sscc);
  assert.deepEqual(wh.orders.Q1.lines[0].allocated, [second.sscc]);
});

test('shipment rechecks all pallets before changing any stock', () => {
  const { wh, first, second } = setup();
  wh.addOrder({ id: 'Q1', customer: 'Shop', lane: 'OUT-01', lines: [{ itemNo: 'Y1001', pallets: 2 }] });
  wh.addTruck('RT1', { categories: ['YOG'] });
  for (let i = 0; i < 2; i++) {
    const ins = wh.instruction('RT1');
    assert.ok(wh.scan('RT1', ins.pallet.sscc).ok);
    assert.ok(wh.scan('RT1', wh.instruction('RT1').target).ok);
  }
  assert.equal(wh.orders.Q1.status, 'ready');
  wh.recordTemperature(second.sscc, 9, 2, 6, 'Loading inspection');
  const held = JSON.stringify(wh);
  assert.throws(() => wh.shipOrder('Q1'), /quality hold/);
  assert.equal(JSON.stringify(wh), held);
  assert.equal(first.loc, 'OUT-01');
  wh.releaseQualityHold(second.sscc, 'Reviewed and accepted');
  wh.shipOrder('Q1');
  assert.equal(first.status, 'shipped');
  assert.equal(second.status, 'shipped');
  assert.throws(() => wh.recordTemperature(first.sscc, 4, 2, 6, 'Late check'), /shipped/);
});

test('quality API journals readings and decisions and rebuilds their history', () => {
  const store = new Store({ site, now });
  try {
    store.exec('importStock', { rows: [{ code: 'AA01A1', sscc: '387999990000091016', itemNo: 'Y1001', batch: 'Q', expiry: '2026-11-20' }] }, 'setup');
    const api = createApi({ store, printers: { flush() {}, results: [] } });
    const path = '/api/pallets/387999990000091016';
    assert.equal(api.handle('POST', `${path}/temperature`, { temperature: 9, min: 2, max: 6, reason: 'Outside limits' }, 'receiver').status, 200);
    assert.equal(api.handle('POST', `${path}/quality-release`, { reason: '' }, 'quality').status, 400);
    assert.equal(api.handle('GET', '/api/quality').body[0].qualityHold.by, 'receiver');
    assert.equal(api.handle('POST', `${path}/quality-release`, { reason: 'Investigation complete' }, 'quality').status, 200);
    const before = JSON.stringify(store.wh);
    store.load();
    assert.equal(JSON.stringify(store.wh), before);
    assert.equal(api.handle('GET', '/api/quality').body[0].qualityHistory[1].by, 'quality');
  } finally { store.db.close(); }
});

test('quality walkthrough retains a hold after a normal reading and allocates only after review', () => {
  const demo = new Walkthrough(site, 'quality');
  while (demo.index < 9) demo.next();
  assert.deepEqual(demo.wh.orders['4701'].lines[0].allocated, [demo.second]);
  demo.next();
  assert.equal(demo.wh.shipState(demo.wh.pallets[demo.first]), 'blocked');
  demo.next();
  assert.equal(demo.wh.shipState(demo.wh.pallets[demo.first]), 'ok');
  demo.next();
  assert.deepEqual(demo.wh.orders['4702'].lines[0].allocated, [demo.first]);
  assert.equal(demo.wh.pallets[demo.first].qualityHistory.length, 3);
  assert.equal(demo.step, null);
});
