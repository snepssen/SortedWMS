const test = require('node:test');
const assert = require('node:assert/strict');
const GS1 = require('../src/gs1');
const { Warehouse } = require('../src/engine');
const { createApi } = require('../server/api');
const { COMMANDS } = require('../server/commands');

const T0 = Date.UTC(2026, 9, 8, 6, 0);

function setup(config = {}) {
  const wh = new Warehouse({ aisles: [31, 32], bays: 4, levels: 2, clock: () => T0, config: { groundNextPerItem: 0, checkAfterPick: false, ...config } });
  wh.addItem({ itemNo: 'Y1', gtin: GS1.makeGtin13('20000', 1), name: 'Yoghurt', category: 'YOG', palletQty: 96 });
  wh.applyTemplate(wh.selectLocations('31', '32'), 'YOG');
  const put = (code, batch = 'B1') => wh.stockPallet(code, { itemNo: 'Y1', batch, expiry: '2026-12-01' });
  return { wh, put };
}

const countAt = (wh, code) => Object.values(wh.tasks).find((t) => t.type === 'COUNT' && t.from === code && t.status !== 'done' && t.status !== 'cancelled');

test('count: a planned location goes to an idle truck, blind, and a match is just OK', () => {
  const { wh, put } = setup();
  const p = put('31-02-0-10');
  assert.equal(wh.planCounts({ codes: ['31-02-0-10'] }), 1);
  wh.addTruck('RT1');
  const ins = wh.instruction('RT1');
  assert.equal(ins.kind, 'count');
  assert.equal(ins.target, '31-02-0-10');
  assert.equal(ins.pallet, undefined, 'blind: the handheld is not told what to expect');
  assert.equal(wh.scan('RT1', p.sscc).ok, false, 'the location label comes first');
  assert.match(wh.scan('RT1', '31-02-0-10').text, /Scan the pallet in 31-02-0-10/);
  const r = wh.scan('RT1', p.sscc);
  assert.ok(r.ok);
  assert.match(r.text, /Count OK/);
  assert.equal(wh.counts[0].result, 'ok');
  assert.ok(wh.locations['31-02-0-10'].countedAt);
  assert.equal(wh.instruction('RT1').kind, 'idle');
});

test('count: an empty location counted empty is OK', () => {
  const { wh } = setup();
  wh.planCounts({ codes: ['31-03-0-10'] });
  wh.addTruck('RT1');
  wh.scan('RT1', '31-03-0-10');
  assert.match(wh.scan('RT1', '31-03-0-10').text, /Count OK: empty/);
  assert.equal(wh.counts[0].result, 'ok');
});

test('count: a different pallet found corrects the system; the one expected goes on the location-unknown list', () => {
  const { wh, put } = setup();
  const expected = put('31-02-0-10');
  const other = put('31-04-1-40', 'B2');
  wh.planCounts({ codes: ['31-02-0-10'] });
  wh.addTruck('RT1');
  wh.scan('RT1', '31-02-0-10');
  const r = wh.scan('RT1', `00${other.sscc}`);
  assert.equal(r.ok, false, 'a difference is shown as one');
  assert.match(r.text, /Corrected/);
  assert.equal(wh.pallets[other.sscc].loc, '31-02-0-10');
  assert.equal(wh.locations['31-04-1-40'].sscc, null);
  assert.ok(wh.lostPallets().some((p) => p.sscc === expected.sscc));
  assert.deepEqual({ ...wh.counts[0], t: 0 }, { t: 0, code: '31-02-0-10', expected: expected.sscc, found: other.sscc, result: 'corrected', by: 'RT1' });
});

test('count: counted empty where a pallet should be puts it on the location-unknown list and holds its pick', () => {
  const { wh, put } = setup();
  const p = put('31-02-0-10');
  wh.planCounts({ codes: ['31-02-0-10'] });
  wh.addTruck('RT1');
  wh.addOrder({ id: 'O1', customer: 'Shop', lane: 'OUT-01', lines: [{ itemNo: 'Y1', pallets: 1 }] });
  // RT1 was idle when the count was planned, so it already has the count.
  assert.equal(wh.instruction('RT1').kind, 'count');
  wh.scan('RT1', '31-02-0-10');
  const r = wh.scan('RT1', '31-02-0-10');
  assert.match(r.text, /should be here. It's on the location-unknown list/);
  assert.equal(wh.pallets[p.sscc].status, 'missing');
  assert.equal(wh.pallets[p.sscc].missingFrom, '31-02-0-10');
  const pick = Object.values(wh.tasks).find((t) => t.type === 'PICK');
  assert.equal(pick.status, 'held');
  assert.equal(wh.counts[0].result, 'missing');
});

test('count: real work goes first; counts only go to a truck with nothing else to do', () => {
  const { wh, put } = setup();
  const p = put('31-02-0-10');
  wh.planCounts({ codes: ['31-03-0-10'] });
  wh.addOrder({ id: 'O1', customer: 'Shop', lane: 'OUT-01', lines: [{ itemNo: 'Y1', pallets: 1 }] });
  wh.addTruck('RT1');
  assert.equal(wh.instruction('RT1').kind, 'pickup');
  assert.equal(wh.instruction('RT1').pallet.sscc, p.sscc);
});

test('count: a waiting count never jumps the queue, and can be switched off', () => {
  const { wh } = setup({ escalateAfterMin: 1 });
  wh.planCounts({ codes: ['31-03-0-10'] });
  const task = countAt(wh, '31-03-0-10');
  assert.equal(wh.isUrgent({ ...task, createdAt: T0 - 3600e3 }), false);
  wh.setConfig({ enabled: { ...wh.config.enabled, COUNT: false } });
  wh.addTruck('RT1');
  assert.equal(wh.instruction('RT1').kind, 'idle');
});

test('count: without a range, locations with corrections and lost pallets are counted first', () => {
  const { wh, put } = setup();
  const a = put('32-04-1-40');
  put('31-01-0-10', 'B2');
  wh.transferPallet(a.sscc, '32-03-1-40', { by: 'office' });
  const n = wh.planCounts({ limit: 2 });
  assert.equal(n, 2);
  const planned = Object.values(wh.tasks).filter((t) => t.type === 'COUNT').map((t) => t.from).sort();
  assert.deepEqual(planned, ['32-03-1-40', '32-04-1-40']);
  assert.equal(wh.planCounts({ codes: ['32-03-1-40'] }), 0, 'no second count on a location with one open');
});

test('count duty respects disabled counts, including after finishing an already assigned count', () => {
  const { wh } = setup({ enabled: { COUNT: false } });
  wh.addTruck('RT1', { mode: 'count' });
  assert.equal(wh.instruction('RT1').kind, 'idle');
  assert.equal(Object.values(wh.tasks).length, 0);
  wh.setConfig({ enabled: { COUNT: true } });
  const code = wh.instruction('RT1').target;
  wh.setConfig({ enabled: { COUNT: false } });
  wh.scan('RT1', code); wh.scan('RT1', code);
  assert.equal(wh.instruction('RT1').kind, 'idle');
  assert.equal(Object.values(wh.tasks).filter((t) => t.type === 'COUNT').length, 1);
});

test('count: a job order saved before counts existed still works; counts go last', () => {
  const { wh } = setup();
  const old = wh.config.priority.filter((t) => t !== 'COUNT');
  wh.setConfig({ priority: old });
  assert.equal(wh.config.priority.at(-1), 'COUNT');
  assert.throws(() => wh.setConfig({ priority: ['PICK', 'PICK'] }), /exactly once/);
  assert.throws(() => wh.setConfig({ priority: ['PICK', 'NOPE'] }), /exactly once/);
});

test('count: the office plans counts by range and sees the results', async () => {
  const { wh, put } = setup();
  const p = put('31-02-0-10');
  const store = { wh, exec: (op, args, by) => COMMANDS[op](wh, args, by), journal: () => [] };
  const api = createApi({ store, printers: { results: [], flush() {} } });
  const plan = await api.handle('POST', '/api/plan/counts', { from: '31-02-0-10', to: '31-02-0-10' });
  assert.equal(plan.status, 200);
  assert.equal(plan.body, 1);
  wh.addTruck('RT1');
  const dev = await api.handle('GET', '/api/devices/RT1');
  assert.equal(dev.body.instruction.kind, 'count');
  assert.equal(dev.body.instruction.step, 0);
  assert.equal(dev.body.instruction.task.typeLabel, 'Stock count');
  wh.scan('RT1', '31-02-0-10');
  wh.scan('RT1', p.sscc);
  const counts = (await api.handle('GET', '/api/counts')).body;
  assert.equal(counts.open, 0);
  assert.equal(counts.done, 1);
  assert.equal(counts.accuracy, 100);
  assert.equal(counts.results[0].result, 'ok');
});

test('count mode: a driver on inventory duty gets count after count, places that need it first, then nearest', () => {
  const { wh, put } = setup();
  const a = put('32-04-1-40');
  wh.transferPallet(a.sscc, '32-03-1-40', { by: 'office' });
  wh.addTruck('RT1', { position: '31-01-0-10' });
  wh.setTruckMode('RT1', 'count');
  const first = wh.instruction('RT1');
  assert.equal(first.kind, 'count');
  assert.match(first.target, /^32-0[34]-1-40$/, 'a corrected place first, even though it is further away');
  wh.scan('RT1', first.target);
  wh.scan('RT1', wh.locations[first.target].sscc || first.target);
  const second = wh.instruction('RT1');
  assert.match(second.target, /^32-0[34]-1-40$/);
  assert.notEqual(second.target, first.target);
  wh.scan('RT1', second.target);
  const r = wh.scan('RT1', wh.locations[second.target].sscc || second.target);
  assert.match(r.text, /Next: Count at/);
  // Then the walk goes on from where the truck is: the nearest location not counted this week.
  const third = wh.instruction('RT1').target;
  const near = wh._racks().filter((l) => !l.countedAt).map((l) => wh.travel(second.target, l.code));
  assert.equal(wh.travel(second.target, third), Math.min(...near));
  assert.equal(wh.counts.length, 2);
  // Real jobs don't go to a truck on count duty.
  wh.addOrder({ id: 'O1', customer: 'Shop', lane: 'OUT-01', lines: [{ itemNo: 'Y1', pallets: 1 }] });
  assert.equal(wh.instruction('RT1').kind, 'count');
});

test('count mode: the command barcode switches to it, and a count-mode truck only counts its own categories', () => {
  const { wh } = setup();
  wh.addItem({ itemNo: 'C1', gtin: GS1.makeGtin13('20000', 3), name: 'Gouda', category: 'CHE', palletQty: 80 });
  wh.applyTemplate(wh.selectLocations('32', '32'), 'CHE');
  wh.addTruck('RT1', { categories: ['CHE'] });
  assert.ok(wh.scan('RT1', 'CMD-COUNT').ok);
  assert.equal(wh.trucks.RT1.mode, 'count');
  assert.equal(wh.locations[wh.instruction('RT1').target].category, 'CHE');
});
