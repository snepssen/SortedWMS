const test = require('node:test');
const assert = require('node:assert/strict');
const GS1 = require('../src/gs1');
const { Warehouse } = require('../src/engine');

const MIN = 60000;
const T0 = Date.UTC(2026, 9, 7, 6, 0);

// Racking aisles 01–02 (cheese), two block lanes of 3 stacks × 6 high, and the process stations.
function setup(config = {}) {
  let t = T0;
  const wh = new Warehouse({
    aisles: 2, bays: 6, levels: 3, clock: () => t,
    config: { groundNextPerItem: 0, ...config },
    blocks: [{ id: 'BL01', stacks: 3, height: 6, category: 'CHE' }, { id: 'BL02', stacks: 3, height: 6, category: 'CHE' }],
    stations: [
      { id: 'PRESS', name: 'Pallet change', machine: 'Flip press', minutes: 5, sop: ['Flip', 'Swap pallet', 'Flip back', 'Seal'] },
      { id: 'PLATE', name: 'Plate press', machine: 'Plate press', minutes: 3 },
      { id: 'WARM', name: 'Warm room', dwell: true, capacity: 10 },
    ],
  });
  wh.addItem({ itemNo: 'C1', gtin: GS1.makeGtin13('20000', 3), name: 'Gouda slices', category: 'CHE', palletQty: 80 });
  wh.addItem({ itemNo: 'W1', gtin: GS1.makeGtin13('20000', 5), name: 'Gouda wheels (crates)', category: 'CHE', palletQty: 24, storage: 'block' });
  wh.setLocationCategory({ aisle: 1 }, 'CHE');
  wh.setLocationCategory({ aisle: 2 }, 'CHE');
  wh.addRoute({ id: 'CHANGE', name: 'Pallet change', steps: [{ station: 'PRESS', op: 'Change pallet', reprint: true }] });
  wh.addRoute({ id: 'HOLES', name: 'Hole forming', steps: [
    { station: 'PLATE', op: 'Apply plate' },
    { station: 'WARM', dwellMin: 120 },
    { station: 'PLATE', op: 'Remove plate' },
  ] });
  const advance = (mins) => { t += mins * MIN; wh.dispatch(); };
  return { wh, advance };
}

function stockBlock(wh, lane, n, batch, expiry) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(wh.stockPallet(wh.nextBlockSpot(lane), { itemNo: 'W1', batch, expiry }));
  return out;
}

// Both scans of a truck's pallet job.
function move(wh, truckId) {
  const task = wh.tasks[wh.trucks[truckId].taskId];
  assert.ok(wh.scan(truckId, task.sscc).ok, 'pick-up');
  const r = wh.scan(truckId, task.to);
  assert.ok(r.ok, r.text);
  return task;
}

test('block lanes fill from the back and empty from the front, 6 high', () => {
  const { wh } = setup();
  const ps = stockBlock(wh, 'BL01', 8, 'K1', '2027-01-01');
  assert.equal(wh.locations['BL01-03'].pallets.length, 6, 'back stack full first');
  assert.equal(wh.locations['BL01-02'].pallets.length, 2);
  assert.equal(wh.locations['BL01-01'].pallets.length, 0);
  assert.equal(wh._reachable(ps[7]), true, 'top of the front-most stack');
  assert.equal(wh._reachable(ps[0]), false, 'bottom of the back stack is buried');
});

test('crate pallets are put away in a block lane of the same batch, never in the racks', () => {
  const { wh } = setup();
  stockBlock(wh, 'BL01', 2, 'K1', '2027-01-01');
  stockBlock(wh, 'BL02', 1, 'K2', '2027-02-01');
  wh.addDelivery({ id: 'D1', supplier: 'Dairy', category: 'CHE', pallets: 1 });
  wh.addTruck('RT1');
  const sscc = wh.nextSscc();
  wh.scan('RT1', `(00)${sscc}(02)${GS1.gtin14(wh.items.W1.gtin)}(15)270101(10)K1(37)24`);
  const put = wh.tasks[wh.trucks.RT1.taskId];
  assert.match(put.to, /^BL01-/, 'joins its own batch, not the K2 lane');
  move(wh, 'RT1');
  assert.equal(wh.pallets[sscc].loc, 'BL01-03');
});

test('picks from a block take the reachable pallet; the next one waits until it is uncovered', () => {
  const { wh } = setup({ checkAfterPick: false });
  const ps = stockBlock(wh, 'BL01', 3, 'K1', '2027-01-01');
  const o = wh.addOrder({ id: 'O1', customer: 'Shop', lane: 'OUT-01', lines: [{ itemNo: 'W1', pallets: 2 }] });
  assert.deepEqual(o.lines[0].allocated, [ps[2].sscc, ps[1].sscc], 'top first, then the one under it');
  wh.addTruck('RT1');
  wh.addTruck('RT2');
  assert.equal(wh.trucks.RT2.taskId, null, 'second pick waits: buried, and one truck per lane');
  move(wh, 'RT1');
  assert.ok(wh.trucks.RT1.taskId || wh.trucks.RT2.taskId, 'now uncovered, it is dispatched');
});

test('pallet change on an order: pick to the press, scan to start and finish, then to the shipping lane', () => {
  const { advance, wh } = setup();
  const p = wh.stockPallet('01-01-0-10', { itemNo: 'C1', batch: 'B1', expiry: '2027-01-01' });
  wh.addOrder({ id: 'O1', customer: 'Shop', lane: 'OUT-02', lines: [{ itemNo: 'C1', pallets: 1, process: 'CHANGE' }] });
  wh.addTruck('RT1');
  const pick = move(wh, 'RT1');
  assert.equal(pick.to, 'ST-PRESS');
  assert.equal(p.proc.state, 'queued');
  assert.match(wh.stationScan('PRESS', p.sscc).text, /Started/);
  advance(6);
  const done = wh.stationScan('PRESS', `(00)${p.sscc}`);
  assert.match(done.text, /Done in 6 min\. New pallet label printed/);
  assert.equal(wh.printQueue[0].printer, 'LP-ST-PRESS');
  const moveOut = wh.tasks[wh.trucks.RT1.taskId];
  assert.equal(moveOut.type, 'MOVE');
  assert.equal(moveOut.to, 'OUT-02');
  move(wh, 'RT1');
  assert.equal(wh.tasks[wh.trucks.RT1.taskId].type, 'CHECK', 'then check & label as usual');
  assert.equal(wh.processLog[0].minutes, 6);
  assert.equal(wh.processLog[0].standard, 5);
});

test('warm room: the system times it and calls the move out, flagged urgent', () => {
  const { advance, wh } = setup();
  const [p] = stockBlock(wh, 'BL01', 1, 'E1', '2027-03-01');
  wh.startProcess(p.sscc, 'HOLES');
  wh.addTruck('RT1');
  move(wh, 'RT1'); // to the plate press
  wh.stationScan('PLATE', p.sscc);
  advance(3);
  wh.stationScan('PLATE', p.sscc);
  move(wh, 'RT1'); // into the warm room
  assert.equal(p.proc.state, 'dwelling');
  assert.match(wh.stationScan('WARM', p.sscc).text, /2 h to go/);
  advance(119);
  assert.equal(wh.trucks.RT1.taskId, null, 'nothing yet');
  advance(1);
  const out = wh.tasks[wh.trucks.RT1.taskId];
  assert.equal(out.urgent, true);
  assert.equal(out.alert, 'Time up in Warm room');
  move(wh, 'RT1'); // back to the plate press
  wh.stationScan('PLATE', p.sscc);
  advance(2);
  wh.stationScan('PLATE', p.sscc);
  const home = move(wh, 'RT1');
  assert.match(home.to, /^BL0/, 'back into a block lane');
  assert.equal(p.proc, null);
  assert.deepEqual(p.trail.map((e) => e.station), ['PLATE', 'WARM', 'PLATE']);
});

test('receiving desk: the screen calls out BATCH, PALLET, GS1; the keyboard fills the rest', () => {
  const { wh } = setup();
  wh.addDesk('DESK1', { name: 'Receiving desk' });
  wh.addDelivery({ id: 'D1', supplier: 'Dairy', category: 'CHE', pallets: 1, at: 'desk' });
  wh.addTruck('RT1');
  assert.equal(wh.trucks.RT1.taskId, null, 'desk deliveries are not sent to truck handhelds');
  wh.deskStart('DESK1');
  assert.equal(wh.deskCallout('DESK1').word, 'BATCH');
  assert.match(wh.scan('DESK1', 'K77').text, /Call out PALLET/);
  assert.equal(wh.deskCallout('DESK1').word, 'PALLET');
  const sscc = GS1.makeSscc(3, '8712345', 77);
  assert.ok(wh.scan('DESK1', `00${sscc}`).ok);
  assert.equal(wh.deskCallout('DESK1').word, 'GS1');
  assert.ok(wh.scan('DESK1', `02${GS1.gtin14(wh.items.C1.gtin)}15270101`).ok, 'item + date, no count on this label');
  const r = wh.deskEnter('DESK1', 'qty', '80');
  assert.match(r.text, /Delivery complete/);
  assert.equal(wh.pallets[sscc].batch, 'K77');
  assert.ok(Object.values(wh.tasks).some((t) => t.type === 'PUTAWAY' && t.sscc === sscc), 'put-away goes to the trucks');
});

test('desk keyboard entry checks what is typed', () => {
  const { wh } = setup();
  wh.addDesk('DESK1');
  wh.addDelivery({ id: 'D1', supplier: 'Dairy', category: 'CHE', pallets: 1, at: 'desk' });
  wh.deskStart('DESK1');
  assert.equal(wh.deskEnter('DESK1', 'expiry', '31-02-2027').ok, false);
  assert.equal(wh.deskEnter('DESK1', 'sscc', '123').ok, false);
  assert.ok(wh.deskEnter('DESK1', 'expiry', '28-02-2027').ok);
});

test('"next out on the ground" leaves block stacks alone', () => {
  const { wh } = setup({ groundNextPerItem: 1 });
  stockBlock(wh, 'BL01', 3, 'K1', '2027-01-01');
  assert.equal(wh.planGround(), 0);
});
