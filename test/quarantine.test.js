const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { buildWarehouse } = require('../server/site');
const { Warehouse } = require('../src/engine');
const { Store } = require('../server/store');
const { createApi } = require('../server/api');
const { Walkthrough } = require('../src/walkthrough');
const site = require('../server/site.example.json');
const now = () => Date.UTC(2026, 9, 8, 6);

function setup() {
  const wh = buildWarehouse(site, now);
  wh.setConfig({ groundNextPerItem: 0, checkAfterPick: false });
  const add = (code, batch = 'Q', expiry = '2026-11-20') => wh.stockPallet(wh.resolve(code), { itemNo: 'Y1001', batch, expiry });
  const zone = wh.resolve('AH10A1');
  return { wh, add, zone };
}
function move(wh, id) {
  const pickup = wh.instruction(id);
  assert.equal(pickup.kind, 'pickup');
  assert.ok(wh.scan(id, pickup.pallet.sscc).ok);
  const to = wh.instruction(id).target;
  assert.ok(wh.scan(id, to).ok);
  return to;
}

test('quarantine designation validates the entire range before mutation and excludes normal put-away', () => {
  const { wh, add, zone } = setup();
  const occupied = add('AA01A1');
  const before = JSON.stringify(wh);
  assert.throws(() => wh.setQuarantineLocations([zone, occupied.loc], true, 'Area change'), /empty/);
  assert.equal(JSON.stringify(wh), before);
  wh.setQuarantineLocations([zone], true, 'Chilled hold area', 'manager');
  assert.equal(wh.locations[zone].category, 'YOG');
  assert.equal(wh._slotFree(wh.locations[zone], occupied), false);
  const dock = add('DOCK-IN', 'LATE');
  wh.requestQuarantine(dock.sscc, 'Review required');
  wh.addTruck('RT1', { categories: ['YOG'] });
  assert.equal(wh.instruction('RT1').pallet.sscc, dock.sscc);
  assert.equal(wh.tasks[wh.trucks.RT1.taskId].to, zone);
  assert.throws(() => wh.setQuarantineLocations([zone], false, 'Remove area'), /unreserved/);
});

test('quarantine moves reject normal slot overrides, keep independent holds and require a scanned return', () => {
  const { wh, add, zone } = setup();
  wh.setQuarantineLocations([zone], true, 'Hold area');
  const p = add('AA01A1');
  wh.recordTemperature(p.sscc, 9, 2, 6, 'Receiving concern');
  wh.requestQuarantine(p.sscc, 'Physical segregation', 'quality');
  wh.addTruck('RT1', { categories: ['YOG'] });
  assert.ok(wh.scan('RT1', p.sscc).ok);
  assert.equal(wh.scan('RT1', 'AB01A1').ok, false);
  assert.equal(p.loc, null);
  assert.ok(wh.scan('RT1', zone).ok);
  assert.equal(p.quarantine.state, 'stored');
  const before = JSON.stringify(wh);
  assert.throws(() => wh.releaseQuarantine(p.sscc, 'Accepted'), /independent/);
  assert.equal(JSON.stringify(wh), before);
  wh.releaseQualityHold(p.sscc, 'Quality investigation accepted');
  assert.equal(wh.shipState(p), 'blocked');
  wh.releaseQuarantine(p.sscc, 'Return approved', 'quality');
  assert.equal(p.quarantine.state, 'returning');
  assert.equal(wh.shipState(p), 'blocked');
  const normal = move(wh, 'RT1');
  assert.notEqual(normal, zone);
  assert.equal(wh.locations[normal].quarantine, undefined);
  assert.equal(p.quarantine, null);
  assert.equal(wh.shipState(p), 'ok');
  assert.deepEqual(p.quarantineHistory.map((e) => e.kind), ['request', 'stored', 'release', 'returned']);
});

test('a full quarantine area queues the next pallet instead of sending it to ordinary storage', () => {
  const { wh, add, zone } = setup();
  wh.setQuarantineLocations([zone], true, 'One position');
  const first = add('AA01A1');
  const second = add('AB01A1');
  wh.requestQuarantine(first.sscc, 'First');
  wh.addTruck('RT1', { categories: ['YOG'] });
  wh.requestQuarantine(second.sscc, 'Second');
  wh.addTruck('RT2', { categories: ['YOG'] });
  assert.equal(wh.trucks.RT2.taskId, null, 'one exclusive reservation');
  const waiting = wh._liveTaskFor(second.sscc);
  assert.equal(waiting.status, 'open');
  assert.equal(waiting.to, null);
  assert.equal(wh.shipState(second), 'blocked');
  assert.throws(() => wh.cancelTask(waiting.id), /quarantine workflow/);
  move(wh, 'RT1');
  wh.releaseQuarantine(first.sscc, 'Reviewed');
  assert.ok(wh.scan('RT1', first.sscc).ok);
  assert.equal(wh.tasks[wh.trucks.RT2.taskId].sscc, second.sscc);
  assert.equal(wh.tasks[wh.trucks.RT2.taskId].to, zone);
});

test('quarantining checked shipping stock replaces the allocation and invalidates readiness', () => {
  const { wh, add, zone } = setup();
  wh.setQuarantineLocations([zone], true, 'Hold area');
  const first = add('AA01A1', 'A');
  const replacement = add('AB01A1', 'B', '2026-12-20');
  wh.addOrder({ id: 'Q1', customer: 'Shop', lane: 'OUT-01', lines: [{ itemNo: 'Y1001', pallets: 1 }] });
  wh.addTruck('RT1', { categories: ['YOG'] });
  move(wh, 'RT1');
  assert.equal(wh.orders.Q1.status, 'ready');
  wh.requestQuarantine(first.sscc, 'Loading concern');
  assert.deepEqual(wh.orders.Q1.lines[0].allocated, [replacement.sscc]);
  assert.equal(wh.orders.Q1.status, 'open');
  assert.equal(first.orderId, null);
  assert.equal(first.checked, false);
  assert.equal(wh.tasks[wh.trucks.RT1.taskId].reason, 'quarantine');
  assert.throws(() => wh.shipOrder('Q1'), /not ready/);
  move(wh, 'RT1');
  assert.equal(first.loc, zone);
});

test('correction transfers preserve quarantine until an approved return reaches matching storage', () => {
  const { wh, add, zone } = setup();
  wh.setQuarantineLocations([zone], true, 'Hold area');
  const p = add('AA01A1');
  assert.ok(wh.transferPallet(p.sscc, zone).ok);
  assert.equal(p.quarantine.state, 'stored', 'unexpected stock in the zone gains a quarantine restriction');
  assert.ok(wh.transferPallet(p.sscc, wh.resolve('AB01A1')).ok);
  assert.equal(p.quarantine.state, 'requested');
  wh.setPalletStatus(p.sscc, 'available');
  assert.equal(wh.shipState(p), 'blocked');
  assert.ok(wh.transferPallet(p.sscc, zone).ok);
  wh.releaseQuarantine(p.sscc, 'Approved');
  assert.ok(wh.transferPallet(p.sscc, 'DOCK-IN').ok);
  assert.equal(p.quarantine.state, 'returning', 'a dock is not normal storage');
  assert.ok(wh.transferPallet(p.sscc, wh.resolve('AB02A1')).ok);
  assert.equal(p.quarantine, null);
  assert.equal(wh.shipState(p), 'ok');
  const imported = add('AH10A1', 'IMPORT');
  assert.equal(imported.quarantine.state, 'stored');
  assert.equal(wh.shipState(imported), 'blocked');
});

test('quarantine commands and history survive API journal replay and snapshots', () => {
  const store = new Store({ site, now });
  try {
    const api = createApi({ store, printers: { flush() {}, results: [] } });
    const post = (path, body, by = 'quality') => api.handle('POST', path, body, by);
    assert.equal(post('/api/quarantine/locations', { from: 'AH10A1', to: 'AH10A1', enabled: true, reason: 'Hold area' }, 'manager').status, 200);
    store.exec('importStock', { rows: [{ code: 'AA01A1', sscc: '387999990000091016', itemNo: 'Y1001', batch: 'Q', expiry: '2026-11-20' }] });
    assert.equal(post('/api/quarantine/request', { sscc: '387999990000091016', reason: ' ' }).status, 400);
    assert.equal(post('/api/quarantine/request', { sscc: '387999990000091016', reason: 'Review' }).status, 200);
    const before = JSON.stringify(store.wh);
    store.load();
    assert.equal(JSON.stringify(store.wh), before);
    const restored = Warehouse.restore(store.wh.toJSON(), { clock: now });
    assert.equal(restored.shipState(restored.pallets['387999990000091016']), 'blocked');
    const q = api.handle('GET', '/api/quarantine').body;
    assert.equal(q.locations.length, 1);
    assert.equal(q.pallets[0].quarantineHistory[0].by, 'quality');
    assert.equal(q.history[0].by, 'manager');
  } finally { store.db.close(); }
});

test('occupied quarantine categories are protected through templates and location imports', () => {
  const { wh, add, zone } = setup();
  wh.setQuarantineLocations([zone], true, 'Hold area');
  add('AH10A1');
  const before = JSON.stringify(wh);
  assert.throws(() => wh.applyTemplate([wh.resolve('AA01A1'), zone], 'PRO'), /quarantine positions/);
  assert.equal(JSON.stringify(wh), before);
  const loc = wh.locations[zone];
  assert.throws(() => wh.setLocationCategory({ aisle: loc.aisle }, 'PRO'), /quarantine positions/);
  assert.equal(JSON.stringify(wh), before);
  assert.throws(() => wh.importLocations([{ code: 'AA01A1', category: 'PRO' }, { code: zone, category: 'PRO' }]), /quarantine positions/);
  assert.equal(JSON.stringify(wh), before);
});

test('blocked quarantine waits and release refuses damage and recalls without mutating state', () => {
  const { wh, add, zone } = setup();
  wh.setQuarantineLocations([zone], true, 'Hold area');
  wh.locations[zone].blocked = true;
  const p = add('AA01A1');
  wh.requestQuarantine(p.sscc, 'Concern');
  wh.addTruck('RT1', { categories: ['YOG'] });
  assert.equal(wh.trucks.RT1.taskId, null);
  wh.unblockLocation(zone);
  move(wh, 'RT1');
  wh.setPalletStatus(p.sscc, 'blocked', 'Damage');
  let before = JSON.stringify(wh);
  assert.throws(() => wh.releaseQuarantine(p.sscc, 'Review'), /independent/);
  assert.equal(JSON.stringify(wh), before);
  wh.setPalletStatus(p.sscc, 'available');
  wh.placeBatchHold('Y1001', 'Q', 'Recall');
  before = JSON.stringify(wh);
  assert.throws(() => wh.releaseQuarantine(p.sscc, 'Review'), /independent/);
  assert.equal(JSON.stringify(wh), before);
  wh.releaseBatchHold('Y1001', 'Q', 'Withdrawn');
  wh.releaseQuarantine(p.sscc, 'Approved');
  assert.equal(p.quarantine.state, 'returning');
});

test('office and walkthrough inline scripts parse', () => {
  for (const path of ['server/public/admin.html', 'server/public/handheld.html', 'walkthrough.html']) {
    for (const m of fs.readFileSync(path, 'utf8').matchAll(/<script>([\s\S]*?)<\/script>/g)) assert.doesNotThrow(() => new vm.Script(m[1]), path);
  }
});

test('guided quarantine keeps stock unavailable until both review and physical return are complete', () => {
  const d = new Walkthrough(site, 'quarantine');
  while (d.index < 9) d.next();
  const p = d.wh.pallets[d.first];
  assert.equal(p.qualityHold, null);
  assert.equal(p.quarantine.state, 'stored');
  assert.equal(d.wh.shipState(p), 'blocked');
  assert.deepEqual(d.wh.orders['4901'].lines[0].allocated, [d.second]);
  d.next();
  assert.equal(p.quarantine.state, 'returning');
  assert.equal(d.wh.shipState(p), 'blocked');
  while (d.step) d.next();
  assert.equal(p.quarantine, null);
  assert.deepEqual(d.wh.orders['4902'].lines[0].allocated, [d.first]);
  assert.equal(d.wh.locations[d.wh.resolve('AH10A1')].sscc, null);
});
