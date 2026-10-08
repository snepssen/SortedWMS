const test = require('node:test');
const assert = require('node:assert/strict');
const GS1 = require('../src/gs1');
const { Warehouse } = require('../src/engine');

const T0 = Date.UTC(2026, 9, 7, 6, 0);

function setup(config = {}) {
  const wh = new Warehouse({ aisles: [31, 32, 33, 34], bays: 6, levels: 3, clock: () => T0, config: { groundNextPerItem: 0, checkAfterPick: false, ...config } });
  wh.addItem({ itemNo: 'Y1', gtin: GS1.makeGtin13('20000', 1), name: 'Yoghurt', category: 'YOG', palletQty: 96 });
  wh.addItem({ itemNo: 'C1', gtin: GS1.makeGtin13('20000', 3), name: 'Gouda', category: 'CHE', palletQty: 80 });
  wh.applyTemplate(wh.selectLocations('31', '32'), 'YOG');
  wh.applyTemplate(wh.selectLocations('33', '34'), 'CHE');
  const put = (code, itemNo, batch, expiry) => wh.stockPallet(code, { itemNo, batch, expiry });
  return { wh, put };
}

// ---- Stock check -------------------------------------------------------------------

test('stock check: an item lists every pallet with location and SSCC, next to ship first', () => {
  const { wh, put } = setup();
  const later = put('31-02-0-10', 'Y1', 'B2', '2026-12-01');
  const first = put('31-04-1-40', 'Y1', 'B1', '2026-11-01');
  for (const code of ['Y1', 'y1', wh.items.Y1.gtin, wh.items.Y1.gtin.slice(1), `(02)${wh.items.Y1.gtin}(37)96`]) {
    const r = wh.lookup(code);
    assert.equal(r.kind, 'item', code);
    assert.deepEqual(r.pallets.map((p) => p.sscc), [first.sscc, later.sscc], code);
  }
  const r = wh.lookup('Y1');
  assert.match(r.lines[1], new RegExp(`^31-04-1-40 · ${first.sscc} · B1 · BB 01-11-2026`));
  assert.match(r.lines[0], /2 pallet\(s\) · 2 free to ship/);
  assert.equal(wh.lookup('C1').lines[0], 'No stock');
});

test('stock check: a location shows what is in it; a pallet shows where it is and where it belongs', () => {
  const { wh, put } = setup();
  const p = put('31-02-0-10', 'Y1', 'B1', '2026-11-01');
  const loc = wh.lookup('31-02-0-10');
  assert.equal(loc.kind, 'location');
  assert.match(loc.lines[0], /Y1 Yoghurt · B1 · BB 01-11-2026/);
  assert.equal(wh.lookup('31-02-0-40').lines[0], 'Empty');
  const pal = wh.lookup(p.sscc);
  assert.equal(pal.kind, 'pallet');
  assert.equal(pal.belongsAt, '31-02-0-10');
  assert.match(pal.text, /At 31-02-0-10/);
  assert.equal(wh.lookup('NOTHING'), null);
});

test('stock check: a pallet on the forks says where it is going (the driver forgot)', () => {
  const { wh, put } = setup();
  const p = put('31-02-1-10', 'Y1', 'B1', '2026-11-01');
  wh.addOrder({ id: 'O1', customer: 'Shop', lane: 'OUT-01', lines: [{ itemNo: 'Y1', pallets: 1 }] });
  wh.addTruck('RT1');
  wh.scan('RT1', p.sscc);
  const r = wh.lookup(p.sscc);
  assert.equal(r.belongsAt, 'OUT-01');
  assert.match(r.text, /On RT1's forks/);
  assert.match(r.text, /Goes to OUT-01/);
  // And on the handheld: scanning the pallet it carries tells the driver again.
  assert.match(wh.scan('RT1', p.sscc).text, /You're carrying it: take it to OUT-01/);
  assert.equal(wh.tasks[wh.trucks.RT1.taskId].step, 1, 'nothing changed');
});

test('Auto: scanning an item or a location while carrying only asks, and the drop still works', () => {
  const { wh, put } = setup();
  const p = put('31-02-1-10', 'Y1', 'B1', '2026-11-01');
  const other = put('31-04-0-10', 'Y1', 'B2', '2026-12-01');
  wh.addOrder({ id: 'O1', customer: 'Shop', lane: 'OUT-01', lines: [{ itemNo: 'Y1', pallets: 1 }] });
  wh.addTruck('RT1');
  wh.scan('RT1', p.sscc);
  assert.match(wh.scan('RT1', 'Y1').text, /Y1 Yoghurt/);
  const r = wh.scan('RT1', other.sscc);
  assert.match(r.text, /At 31-04-0-10\n[\s\S]*You're carrying …\w{6} to OUT-01/);
  assert.equal(wh.pallets[other.sscc].loc, '31-04-0-10');
  assert.ok(wh.scan('RT1', 'OUT-01').ok);
  assert.equal(wh.pallets[p.sscc].loc, 'OUT-01');
});

// ---- Auto: a pallet the handheld wasn't asking for ----------------------------------

test('Auto: a pallet with its own job: pick it, and the shown job goes back to the queue', () => {
  const { wh, put } = setup();
  const a = put('31-02-1-10', 'Y1', 'B1', '2026-11-01');
  const b = put('31-04-1-10', 'Y1', 'B2', '2026-11-05');
  wh.addOrder({ id: 'O1', customer: 'Shop', lane: 'OUT-01', lines: [{ itemNo: 'Y1', pallets: 2 }] });
  wh.addTruck('RT1');
  const shown = wh.tasks[wh.trucks.RT1.taskId];
  const other = shown.sscc === a.sscc ? b : a;
  const r = wh.scan('RT1', other.sscc);
  assert.ok(r.ok, r.text);
  assert.match(r.text, /^Pick it: job #\d+ Pick\. Take it to OUT-01\. Job #\d+ went back to the queue/);
  const now = wh.tasks[wh.trucks.RT1.taskId];
  assert.equal(now.sscc, other.sscc);
  assert.equal(now.step, 1);
  assert.equal(wh.trucks.RT1.load, other.sscc);
  assert.equal(shown.status, 'open');
});

test('Auto: a pallet in the wrong category with no job: relocate it', () => {
  const { wh, put } = setup();
  const misplaced = put('33-02-0-10', 'Y1', 'B1', '2026-11-01'); // yoghurt in a cheese location, no job yet
  wh.addTruck('RT1', { categories: ['YOG'] });
  const r = wh.scan('RT1', misplaced.sscc);
  assert.match(r.text, /^Relocate it: job #\d+ Shift\. Take it to 3[12]-/);
  const t = wh.tasks[wh.trucks.RT1.taskId];
  assert.equal(wh.locations[t.to].category, 'YOG');
  assert.equal(t.reason, 'template');
});

test('Auto: a pallet waiting at the dock with no job: put it away', () => {
  const { wh } = setup();
  const p = wh.stockPallet('DOCK-IN', { itemNo: 'Y1', batch: 'B1', expiry: '2026-11-01' });
  wh.addTruck('RT1');
  const r = wh.scan('RT1', p.sscc);
  assert.match(r.text, /^Put it away: job #\d+ Put-away\. Take it to 31-/);
  assert.equal(wh.trucks.RT1.load, p.sscc);
});

test('Auto: a pallet with nothing to do: the truck stays empty, a location scan corrects where it stands', () => {
  const { wh, put } = setup();
  const job = put('31-02-1-10', 'Y1', 'B1', '2026-11-01');
  const stray = put('31-04-0-10', 'Y1', 'B9', '2026-12-01');
  wh.addOrder({ id: 'O1', customer: 'Shop', lane: 'OUT-01', lines: [{ itemNo: 'Y1', pallets: 1 }] });
  wh.addTruck('RT1');
  const task = wh.tasks[wh.trucks.RT1.taskId];
  const r = wh.scan('RT1', stray.sscc);
  assert.match(r.text, /Scan the location it stands at to correct it, or scan it again to move it\. Job #\d+ is still yours/);
  assert.equal(wh.trucks.RT1.load, null);
  assert.equal(wh.instruction('RT1').pending.pallet.sscc, stray.sscc);
  const t = wh.scan('RT1', '32-03-2-70');
  assert.ok(t.ok, t.text);
  assert.match(t.text, /Recorded at 32-03-2-70\. Back to job #\d+: Pick at 31-02-1-10/);
  assert.equal(wh.pallets[stray.sscc].loc, '32-03-2-70');
  assert.equal(wh.instruction('RT1').pending, undefined);
  assert.equal(wh.trucks.RT1.taskId, task.id, 'still the same job');
  assert.ok(wh.scan('RT1', job.sscc).ok, 'and the job carries on');
});

test('Auto: the held pallet scanned at its recorded location is confirmed, nothing moves', () => {
  const { wh, put } = setup();
  const p = put('31-04-0-10', 'Y1', 'B1', '2026-12-01');
  wh.addTruck('RT1');
  wh.scan('RT1', p.sscc);
  const r = wh.scan('RT1', wh.rowName('31-04-0-10'));
  assert.match(r.text, /already recorded at 31-04-0-10/);
  assert.equal(wh.transfers === undefined || wh.transfers.length === 0, true);
});

test('Auto: a lost pallet found by a driver goes back on the map with one location scan', () => {
  const { wh, put } = setup();
  const p = put('31-04-0-10', 'Y1', 'B1', '2026-12-01');
  const intruder = put('31-02-0-10', 'Y1', 'B2', '2026-12-02');
  wh.transferPallet(intruder.sscc, '31-04-0-10'); // p is pushed out: location unknown
  assert.equal(wh.pallets[p.sscc].status, 'missing');
  wh.addTruck('RT1');
  assert.match(wh.scan('RT1', p.sscc).text, /Location unknown: last recorded at 31-04-0-10\nScan the location it stands at to put it back on the map/);
  assert.ok(wh.scan('RT1', '32-01-0-40').ok);
  assert.equal(wh.pallets[p.sscc].status, 'available');
  assert.equal(wh.lostPallets().length, 0);
});

test('Auto: scanning the held pallet again moves it; the buttons can move it or let it go', () => {
  const { wh, put } = setup();
  const p = put('31-04-0-10', 'Y1', 'B1', '2026-12-01');
  const q = put('31-06-0-10', 'Y1', 'B2', '2026-12-05');
  wh.addTruck('RT1');
  wh.scan('RT1', p.sscc);
  const r = wh.scan('RT1', p.sscc);
  assert.match(r.text, /^Auto-Shift: take it to/);
  assert.equal(wh.tasks[wh.trucks.RT1.taskId].reason, 'driver');
  assert.ok(wh.scan('RT1', wh.tasks[wh.trucks.RT1.taskId].to).ok);

  wh.scan('RT1', q.sscc);
  assert.equal(wh.pendingAction('RT1', 'cancel').text, 'OK');
  assert.equal(wh.instruction('RT1').pending, undefined);
  wh.scan('RT1', q.sscc);
  assert.match(wh.pendingAction('RT1', 'move').text, /^Auto-Shift: take it to/);
  assert.equal(wh.trucks.RT1.load, q.sscc);
});

test('Auto: a pallet on another truck is only reported', () => {
  const { wh, put } = setup();
  const p = put('31-02-1-10', 'Y1', 'B1', '2026-11-01');
  wh.addOrder({ id: 'O1', customer: 'Shop', lane: 'OUT-01', lines: [{ itemNo: 'Y1', pallets: 1 }] });
  wh.addTruck('RT1');
  wh.addTruck('RT2');
  const r = wh.scan('RT2', p.sscc);
  assert.equal(r.ok, false);
  assert.match(r.text, /job #\d+ on RT1/);
});
