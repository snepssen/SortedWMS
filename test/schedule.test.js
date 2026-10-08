const test = require('node:test');
const assert = require('node:assert/strict');
const GS1 = require('../src/gs1');
const { Warehouse } = require('../src/engine');

// 07:30 and 11:00 in Brussels on 9 October 2026 (summer time, UTC+2).
const AT_0730 = Date.UTC(2026, 9, 9, 5, 30);
const AT_1100 = Date.UTC(2026, 9, 9, 9, 0);

function setup(now) {
  const clock = { t: now };
  const wh = new Warehouse({ aisles: [31, 32], bays: 6, levels: 3, clock: () => clock.t, config: { groundNextPerItem: 0, checkAfterPick: false } });
  wh.addItem({ itemNo: 'Y1', gtin: GS1.makeGtin13('20000', 1), name: 'Yoghurt', category: 'YOG', palletQty: 96, minShipDays: 5 });
  wh.applyTemplate(wh.selectLocations('31', '32'), 'YOG');
  return { wh, clock };
}

test('job order by time of day: receiving first in the morning window, the normal order after it', () => {
  const { wh, clock } = setup(AT_0730);
  wh.setConfig({ schedule: [{ from: '6:00', to: '10:00', priority: ['RECEIVE', 'PUTAWAY'] }] });
  assert.equal(wh.localTime(), '07:30');
  assert.deepEqual(wh.config.schedule[0].named, ['RECEIVE', 'PUTAWAY']);
  assert.deepEqual(wh.activePriority().slice(0, 4), ['RECEIVE', 'PUTAWAY', 'CHECK', 'PICK'], 'named first, then the normal order');
  wh.stockPallet('31-02-0-10', { itemNo: 'Y1', batch: 'B1', expiry: '2026-12-01' });
  wh.addOrder({ id: 'O1', customer: 'Shop', lane: 'OUT-01', lines: [{ itemNo: 'Y1', pallets: 1 }] });
  wh.addDelivery({ id: 'D1', supplier: 'Dairy', category: 'YOG', pallets: 1 });
  wh.addTruck('RT1');
  assert.equal(wh.instruction('RT1').kind, 'receive', 'at 07:30 receiving goes before the pick');
  assert.match(wh.tasks[wh.trucks.RT1.taskId].dispatchReason, /Priority 1 \(06:00-10:00\)/);
  clock.t = AT_1100;
  assert.equal(wh.activeWindow(), null);
  wh.setTruckMode('RT1', 'paused'); wh.setTruckMode('RT1', 'auto');
  assert.equal(wh.instruction('RT1').kind, 'pickup', 'at 11:00 the pick goes first again');
});

test('job order by time of day: a window can run past midnight, and bad windows are refused', () => {
  const { wh, clock } = setup(Date.UTC(2026, 9, 9, 21, 30)); // 23:30 in Brussels
  wh.setConfig({ schedule: [{ from: '22:00', to: '06:00', priority: ['SHIFT', 'COUNT'] }] });
  assert.equal(wh.activePriority()[0], 'SHIFT');
  clock.t = Date.UTC(2026, 9, 10, 2, 0); // 04:00
  assert.equal(wh.activePriority()[0], 'SHIFT');
  clock.t = Date.UTC(2026, 9, 10, 6, 0); // 08:00
  assert.equal(wh.activePriority()[0], 'CHECK');
  assert.throws(() => wh.setConfig({ schedule: [{ from: '25:00', to: '06:00', priority: ['PICK'] }] }), /HH:MM/);
  assert.throws(() => wh.setConfig({ schedule: [{ from: '06:00', to: '10:00', priority: ['NOPE'] }] }), /job types/);
  assert.throws(() => wh.setConfig({ timeZone: 'Mars/Olympus' }), /Unknown time zone/);
});

test('drivers this shift: moves, scans per move, wrong scans and idle time, paused time not counted', () => {
  const { wh, clock } = setup(AT_0730);
  const p = wh.stockPallet('31-02-0-10', { itemNo: 'Y1', batch: 'B1', expiry: '2026-12-01' });
  wh.addTruck('RT1');
  clock.t += 10 * 60000; // ten minutes with nothing to do
  wh.addOrder({ id: 'O1', customer: 'Shop', lane: 'OUT-01', lines: [{ itemNo: 'Y1', pallets: 1 }] });
  wh.scan('RT1', 'Y-WRONG');
  wh.scan('RT1', p.sscc); wh.scan('RT1', 'OUT-01');
  let d = wh.driverStats().find((x) => x.id === 'RT1');
  assert.equal(d.moves, 1);
  assert.equal(d.wrongScans, 1);
  assert.equal(Math.round(d.idleMs / 60000), 10);
  wh.setTruckMode('RT1', 'paused');
  clock.t += 30 * 60000; // a break
  wh.setTruckMode('RT1', 'auto');
  clock.t += 5 * 60000;
  d = wh.driverStats().find((x) => x.id === 'RT1');
  assert.equal(Math.round(d.idleMs / 60000), 15, 'the break is not idle time');
  wh.startShift();
  d = wh.driverStats().find((x) => x.id === 'RT1');
  assert.deepEqual([d.moves, d.wrongScans, d.idleMs, d.since], [0, 0, 0, clock.t]);
});
