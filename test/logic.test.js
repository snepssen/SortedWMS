// What a fuzz run (drivers mostly right, sometimes wrong, the office meddling) found, kept as regressions.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const GS1 = require('../src/gs1');
const { Warehouse } = require('../src/engine');
const Site = require('../server/site');
const { COMMANDS } = require('../server/commands');
const { seedDemo } = require('../server/seed');
const Drivers = require('../src/drivers');

const T0 = Date.UTC(2026, 9, 9, 6, 0);

function setup(config = {}) {
  const wh = new Warehouse({ aisles: [31, 32], bays: 6, levels: 3, clock: () => T0, config: { groundNextPerItem: 0, checkAfterPick: true, ...config } });
  wh.addItem({ itemNo: 'Y1', gtin: GS1.makeGtin13('20000', 1), name: 'Yoghurt', category: 'YOG', palletQty: 96, minShipDays: 5 });
  wh.applyTemplate(wh.selectLocations('31', '32'), 'YOG');
  return wh;
}

test('count mode never sends a third truck into an aisle', () => {
  const wh = setup();
  for (const id of ['RT1', 'RT2', 'RT3']) { wh.addTruck(id, { position: '31-01-0-10' }); wh.setTruckMode(id, 'count'); }
  const occ = wh.aisleOccupancy();
  for (const [aisle, trucks] of Object.entries(occ)) assert.ok(trucks.length <= wh.capOf(aisle), `aisle ${aisle}: ${trucks}`);
  assert.equal(Object.values(wh.trucks).filter((t) => t.taskId).length, 3, 'the third counts in the other aisle');
});

test('receiving: a location label is not a batch number, and CANCEL starts the pallet again', () => {
  const wh = setup();
  const s1 = GS1.makeSscc(3, '8712345', 5);
  wh.addDelivery({ id: 'D1', supplier: 'Dairy', category: 'YOG', list: [{ sscc: s1, itemNo: 'Y1', batch: 'B1', expiry: '2026-11-01', qty: 96 }] });
  wh.addTruck('RT1');
  const r = wh.scan('RT1', 'DOCK-IN');
  assert.equal(r.ok, false);
  assert.match(r.text, /label of DOCK-IN, not a batch number/);
  // A typo that does get in: the list disagrees, and CANCEL is the way out.
  wh.scan('RT1', 'WRONG1');
  assert.match(wh.scan('RT1', `00${s1}`).text, /disagree on batch.*Scan CANCEL to start this pallet again/);
  assert.match(wh.scan('RT1', 'CMD-CANCEL').text, /This pallet starts again/);
  assert.ok(wh.scan('RT1', `00${s1}`).ok);
  assert.equal(wh.pallets[s1].batch, 'B1');
});

test('put-away mode puts away: a check or a pick waiting for the pallet is Auto\'s', () => {
  const wh = setup();
  const p = wh.stockPallet('31-02-0-10', { itemNo: 'Y1', batch: 'B1', expiry: '2026-12-01' });
  wh.addOrder({ id: 'O1', customer: 'Shop', lane: 'OUT-01', lines: [{ itemNo: 'Y1', pallets: 1 }] });
  wh.addTruck('RT1', { mode: 'putaway' });
  const r = wh.scan('RT1', p.sscc);
  assert.equal(r.ok, false);
  assert.match(r.text, /pick for shipping job .* Scan AUTO to do it/i);
  assert.equal(wh.trucks.RT1.taskId, null);
});

test('a held check whose pallet went missing is not sent to the trucks again', () => {
  const wh = setup();
  const p = wh.stockPallet('31-02-0-10', { itemNo: 'Y1', batch: 'B1', expiry: '2026-12-01' });
  wh.addOrder({ id: 'O1', customer: 'Shop', lane: 'OUT-01', lines: [{ itemNo: 'Y1', pallets: 1 }] });
  wh.addTruck('RT1');
  wh.scan('RT1', p.sscc); wh.scan('RT1', 'OUT-01'); // picked; the check is next
  assert.equal(wh.instruction('RT1').kind, 'check-pallet');
  wh.scan('RT1', 'CMD-MISSING'); wh.scan('RT1', 'CMD-MISSING');
  const check = Object.values(wh.tasks).find((t) => t.type === 'CHECK');
  assert.equal(check.status, 'held');
  assert.equal(wh.pallets[p.sscc].status, 'missing');
  // No replacement stock: the pallet left the order, so releasing the check just closes it.
  wh.releaseTask(check.id);
  assert.equal(check.status, 'cancelled');
  assert.ok(wh.lostPallets().some((x) => x.sscc === p.sscc), 'still on the location-unknown list');
});

test('a held move for a pallet nobody can find stays held until it is found', () => {
  const wh = setup();
  const p = wh.stockPallet('31-02-0-10', { itemNo: 'Y1', batch: 'B1', expiry: '2026-12-01' });
  wh.addTruck('RT1', { mode: 'shift' });
  const task = wh._newTask({ type: 'SHIFT', reason: 'driver', category: 'YOG', sscc: p.sscc, from: '31-02-0-10', to: null });
  wh.dispatch();
  wh.scan('RT1', 'CMD-MISSING'); wh.scan('RT1', 'CMD-MISSING');
  assert.equal(task.status, 'held');
  assert.throws(() => wh.releaseTask(task.id), /location-unknown list/);
  // Found again: the old job is closed and the pallet is back in the plan.
  wh.transferPallet(p.sscc, '31-03-0-10', { by: 'office' });
  assert.notEqual(task.status, 'held');
  assert.equal(wh.pallets[p.sscc].status, 'available');
});

// The fuzz itself, small: every step must leave the warehouse consistent.
test('fuzz: hundreds of right and wrong scans and office actions keep the warehouse consistent', () => {
  const site = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'server', 'site.example.json'), 'utf8'));
  for (const seed of [3, 7]) {
    let a = seed;
    const rnd = () => { a = (a * 16807) % 2147483647; return a / 2147483647; };
    const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
    let t = Date.UTC(2026, 9, 9, 6);
    const wh = Site.buildWarehouse(site, () => t);
    const exec = (op, args, by = 'office') => COMMANDS[op](wh, args, by);
    seedDemo({ wh, now: () => t, exec });
    exec('addTruck', { id: 'HH05', categories: null });
    exec('dropWorkload', { seed, picks: 60, inbound: 40 });
    for (let step = 0; step < 2500; step++) {
      t += 3000;
      const id = pick(Object.keys(wh.trucks));
      const r = rnd();
      try {
        if (r < 0.75) { const act = Drivers.next(wh, id, rnd); if (act) (act.qty ? exec('confirmQty', { id, qty: null }, id) : exec('scan', { id, code: act.code }, id)); }
        else if (r < 0.82) exec('scan', { id, code: pick([pick(Object.keys(wh.pallets)), pick(wh._racks()).code, 'DOCK-IN', 'OUT-01', '12', 'Y1001']) }, id);
        else if (r < 0.85) { const c = pick(['CMD-MISSING', 'CMD-DAMAGED', 'CMD-BLOCKED']); exec('scan', { id, code: c }, id); exec('scan', { id, code: c }, id); }
        else if (r < 0.88) exec('scan', { id, code: pick(['CMD-AUTO', 'CMD-TRANSFER', 'CMD-PUTAWAY', 'CMD-COUNT', 'CMD-CANCEL', 'CMD-AUTO']) }, id);
        else if (r < 0.90) { const tk = pick(Object.values(wh.tasks).filter((x) => x.status === 'held' || x.status === 'open')); if (tk) exec(pick(['releaseTask', 'cancelTask']), { taskId: tk.id }); }
        else if (r < 0.91) exec('transferPallet', { sscc: pick(Object.keys(wh.pallets)), to: pick(wh._racks()).code });
        else if (r < 0.92) for (const o of Object.values(wh.orders)) if (o.status === 'ready') exec('shipOrder', { id: o.id });
      } catch (e) {
        if (e instanceof TypeError || e instanceof ReferenceError) throw e; // a crash, not a refusal
      }
      for (const p of Object.values(wh.pallets)) {
        if (p.loc) {
          const l = wh.locations[p.loc];
          assert.ok(l.kind === 'rack' ? l.sscc === p.sscc : l.pallets.includes(p.sscc), `seed ${seed} step ${step}: ${p.sscc} not in ${p.loc}`);
        } else if (p.status !== 'missing' && p.status !== 'shipped') {
          assert.ok(Object.values(wh.trucks).some((tr) => tr.load === p.sscc), `seed ${seed} step ${step}: ${p.sscc} is nowhere (${p.status})`);
        }
      }
      for (const tr of Object.values(wh.trucks)) if (tr.taskId) assert.equal(wh.tasks[tr.taskId].truckId, tr.id, `seed ${seed} step ${step}: ${tr.id}'s job`);
      for (const [aisle, list] of Object.entries(wh.aisleOccupancy())) {
        const sent = list.filter((x) => !TRUCK_STARTED.has(wh.tasks[wh.trucks[x].taskId].reason));
        assert.ok(sent.length <= wh.capOf(aisle), `seed ${seed} step ${step}: aisle ${aisle} ${list}`);
      }
    }
  }
});
// Moves a driver starts on their own are where they are; the limit is about where the system sends trucks.
const TRUCK_STARTED = new Set(['driver']);

// From the simulated shift: two picks from block lane BL01-02 waited six hours while everything else went ahead.
function blockLane() {
  const site = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'server', 'site.example.json'), 'utf8'));
  const t = Date.UTC(2026, 9, 9, 6);
  const wh = Site.buildWarehouse(site, () => t);
  const lane = wh.layout.blocks[0];
  const item = Object.values(wh.items).find((i) => i.storage === 'block');
  const expiry = '2026-12-08';
  let n = 1;
  for (let i = 0; i < 5; i++) wh.stockPallet(wh.nextBlockSpot(lane), { sscc: GS1.makeSscc(1, '8700000', n++), itemNo: item.itemNo, batch: 'BX', expiry });
  wh.addOrder({ id: 'O1', customer: 'Shop', lane: 'OUT-01', lines: [{ itemNo: item.itemNo, pallets: 2 }] });
  return { wh, lane, item, expiry };
}

test('block lanes: a put-away never sets a pallet down in front of pallets waiting to be picked', () => {
  const { wh, lane, item, expiry } = blockLane();
  const p = wh.stockPallet('DOCK-IN', { sscc: GS1.makeSscc(1, '8700000', 99), itemNo: item.itemNo, batch: 'BX', expiry });
  const slot = wh._findSlot(p, 'DOCK-IN');
  assert.ok(slot, 'it goes somewhere');
  assert.notEqual(slot.lane, lane, 'not into the lane being picked');
});

test('block lanes: a pick whose pallet got buried takes the same-batch pallet in front of it, and goes out straight away', () => {
  const { wh, lane, item, expiry } = blockLane();
  const picks = Object.values(wh.tasks).filter((t) => t.type === 'PICK');
  const p = wh.stockPallet(wh.nextBlockSpot(lane), { sscc: GS1.makeSscc(1, '8700000', 99), itemNo: item.itemNo, batch: 'BX', expiry });
  wh.addTruck('RT1', { categories: [item.category] });
  const ins = wh.instruction('RT1');
  assert.equal(ins.kind, 'pickup');
  assert.equal(ins.pallet.sscc, p.sscc, 'the pallet in front');
  assert.ok(picks.some((t) => t.sscc === p.sscc));
  assert.equal(wh.orders.O1.lines[0].allocated.length, 2);
  assert.ok(wh.orders.O1.lines[0].allocated.includes(p.sscc));
  assert.ok(wh.events.some((e) => /is buried in .*picking .* in front of it instead/.test(e.text)));
  // A newer batch in front is not swapped in: that's a dig-out, not a pick.
  const { wh: wh2, lane: lane2, item: item2 } = blockLane();
  const newer = wh2.stockPallet(wh2.nextBlockSpot(lane2), { sscc: GS1.makeSscc(1, '8700000', 98), itemNo: item2.itemNo, batch: 'BY', expiry: '2027-01-30' });
  wh2.dispatch();
  assert.equal(newer.orderId, null);
});

test('picks go order by order: an older order is not overtaken by a newer one nearby', () => {
  const wh = setup();
  const far = wh.stockPallet('32-06-0-70', { itemNo: 'Y1', batch: 'B1', expiry: '2026-11-01' });
  const near = wh.stockPallet('31-01-0-10', { itemNo: 'Y1', batch: 'B2', expiry: '2026-12-01' });
  wh.addOrder({ id: 'OLD', customer: 'Shop', lane: 'OUT-01', lines: [{ itemNo: 'Y1', pallets: 1 }] });
  wh.addOrder({ id: 'NEW', customer: 'Deli', lane: 'OUT-02', lines: [{ itemNo: 'Y1', pallets: 1 }] });
  assert.equal(far.orderId, 'OLD');
  assert.equal(near.orderId, 'NEW');
  wh.addTruck('RT1', { position: '31-01-0-10' });
  assert.equal(wh.instruction('RT1').task.orderId, 'OLD', 'the older order first, even though the newer one is right here');
});
