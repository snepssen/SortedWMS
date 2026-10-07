const test = require('node:test');
const assert = require('node:assert/strict');
const GS1 = require('../src/gs1');
const { Warehouse } = require('../src/engine');

const MIN = 60000;
const T0 = Date.UTC(2026, 9, 7, 6, 0); // 7 Oct 2026

// 4 aisles × 6 bays × 3 levels × 3 positions. Aisles 01–02 yoghurt, 03–04 cheese.
function setup(config = {}) {
  let t = T0;
  const wh = new Warehouse({ aisles: 4, bays: 6, levels: 3, positions: 3, outLanes: 2, clock: () => t, config: { groundNextPerItem: 0, ...config } });
  wh.addItem({ itemNo: 'Y1', gtin: GS1.makeGtin13('20000', 1), name: 'Greek yoghurt', category: 'YOG', palletQty: 96, minShipDays: 10 });
  wh.addItem({ itemNo: 'Y2', gtin: GS1.makeGtin13('20000', 2), name: 'Vanilla quark', category: 'YOG', palletQty: 120, minShipDays: 10 });
  wh.addItem({ itemNo: 'C1', gtin: GS1.makeGtin13('20000', 3), name: 'Young gouda', category: 'CHE', palletQty: 80, minShipDays: 30 });
  wh.addItem({ itemNo: 'P1', gtin: GS1.makeGtin13('20000', 4), name: 'Protein shake', category: 'PRO', palletQty: 60, minShipDays: 60 });
  wh.setLocationCategory({ aisle: 1 }, 'YOG');
  wh.setLocationCategory({ aisle: 2 }, 'YOG');
  wh.setLocationCategory({ aisle: 3 }, 'CHE');
  wh.setLocationCategory({ aisle: 4 }, 'CHE');
  const advance = (mins) => { t += mins * MIN; wh.dispatch(); };
  return { wh, advance };
}

const stock = (wh, code, itemNo, batch, expiry, extra = {}) => wh.stockPallet(code, { itemNo, batch, expiry, ...extra });

// Both scans of the truck's current pallet job.
function complete(wh, truckId) {
  const task = wh.tasks[wh.trucks[truckId].taskId];
  const r1 = wh.scan(truckId, task.sscc);
  assert.ok(r1.ok, r1.text);
  const r2 = wh.scan(truckId, task.to);
  assert.ok(r2.ok, r2.text);
  return task;
}

test('operators only get jobs in their own categories', () => {
  const { wh } = setup();
  stock(wh, '03-01-1-10', 'C1', 'B1', '2027-01-10');
  wh.addOrder({ id: 'O1', customer: 'Shop', lane: 'OUT-01', lines: [{ itemNo: 'C1', pallets: 1 }] });
  wh.addTruck('YOG-1', { categories: ['YOG'] });
  assert.equal(wh.trucks['YOG-1'].taskId, null);
  wh.addTruck('CHE-1', { categories: ['CHE'] });
  assert.equal(wh.tasks[wh.trucks['CHE-1'].taskId].type, 'PICK');
});

test('categories never mix: put-away only goes to a matching location', () => {
  const { wh } = setup();
  wh.addDelivery({ id: 'D1', supplier: 'Dairy Co', category: 'CHE', pallets: 1 });
  wh.addTruck('RT1');
  const sscc = wh.nextSscc();
  wh.scan('RT1', `(00)${sscc}(02)${GS1.gtin14(wh.items.C1.gtin)}(15)270301(10)B7(37)80`);
  const put = wh.tasks[wh.trucks.RT1.taskId];
  assert.equal(put.type, 'PUTAWAY');
  complete(wh, 'RT1');
  assert.equal(wh.locations[wh.pallets[sscc].loc].category, 'CHE');
});

test('receiving asks for batch, expiry, item, SSCC, then quantity — no Enter, one tap', () => {
  const { wh } = setup();
  wh.addDelivery({ id: 'D1', supplier: 'Dairy Co', category: 'YOG', pallets: 2 });
  wh.addTruck('RT1');
  assert.equal(wh.instruction('RT1').field, 'batch');
  assert.ok(wh.scan('RT1', 'L2614').ok);
  assert.equal(wh.instruction('RT1').field, 'expiry');
  assert.equal(wh.scan('RT1', 'L2614').ok, false, 'a second batch scan is not a date');
  assert.ok(wh.scan('RT1', '261031').ok);
  assert.ok(wh.scan('RT1', wh.items.Y1.gtin.slice(1)).ok, 'EAN-13 finds the item');
  const sscc = wh.nextSscc();
  assert.equal(wh.scan('RT1', sscc.slice(0, 17) + ((Number(sscc[17]) + 1) % 10)).ok, false, 'bad check digit');
  assert.ok(wh.scan('RT1', sscc).ok);
  assert.equal(wh.instruction('RT1').field, 'qty');
  const r = wh.confirmQty('RT1');
  assert.ok(r.ok, r.text);
  assert.equal(wh.trucks.RT1.stats.receiveInputs, 7, '4 good scans, 2 wrong ones, 1 tap');
  const p = wh.pallets[sscc];
  assert.deepEqual([p.itemNo, p.batch, p.expiry, p.qty, p.loc, p.status], ['Y1', 'L2614', '2026-10-31', 96, 'DOCK-IN', 'available']);
  assert.equal(wh.instruction('RT1').field, 'batch', 'ready for the next pallet');
  assert.ok(Object.values(wh.tasks).some((t) => t.type === 'PUTAWAY' && t.sscc === sscc));
});

test('a GS1 pallet label with a count registers the whole pallet in one scan', () => {
  const { wh } = setup();
  wh.addDelivery({ id: 'D1', supplier: 'Dairy Co', category: 'YOG', pallets: 1 });
  wh.addTruck('RT1');
  const sscc = wh.nextSscc();
  const r = wh.scan('RT1', `]C100${sscc}02${GS1.gtin14(wh.items.Y2.gtin)}15261101${'10'}Q88${GS1.GS}37120`);
  assert.ok(r.ok, r.text);
  assert.match(r.text, /Delivery complete/);
  assert.equal(wh.trucks.RT1.stats.receiveInputs, 1);
  assert.equal(wh.pallets[sscc].batch, 'Q88');
  assert.equal(wh.deliveries.D1.status, 'received');
});

test('stock under the minimum days to ship is flagged at receiving and put away high', () => {
  const { wh } = setup();
  wh.addDelivery({ id: 'D1', supplier: 'Dairy Co', category: 'YOG', pallets: 1 });
  wh.addTruck('RT1');
  const sscc = wh.nextSscc();
  const r = wh.scan('RT1', `(00)${sscc}(02)${GS1.gtin14(wh.items.Y1.gtin)}(15)261012(10)OLD1(37)96`);
  assert.match(r.text, /short date: 5 days left, minimum to ship is 10/);
  assert.equal(wh.shipState(wh.pallets[sscc]), 'short');
  complete(wh, 'RT1');
  assert.equal(wh.locations[wh.pallets[sscc].loc].level, 2, 'top level');
});

test('FEFO: earliest expiry ships first, oldest received breaks a tie, blocked and expired never ship', () => {
  const { wh } = setup();
  stock(wh, '01-01-0-10', 'Y1', 'LATE', '2026-11-20', { receivedAt: T0 - 9e8 });
  const expired = stock(wh, '01-02-0-10', 'Y1', 'GONE', '2026-10-01');
  const blocked = stock(wh, '01-03-0-10', 'Y1', 'SHORT', '2026-10-10', { status: 'blocked', blockReason: 'Short expiry' });
  const newer = stock(wh, '01-04-0-10', 'Y1', 'EARLY', '2026-10-25', { receivedAt: T0 - 1000 });
  const older = stock(wh, '01-05-0-10', 'Y1', 'EARLY', '2026-10-25', { receivedAt: T0 - 5000 });
  const order = wh.addOrder({ id: 'O1', customer: 'Shop', lane: 'OUT-01', lines: [{ itemNo: 'Y1', pallets: 2 }] });
  assert.deepEqual(order.lines[0].allocated, [older.sscc, newer.sscc]);
  const big = wh.addOrder({ id: 'O2', customer: 'Shop', lane: 'OUT-01', lines: [{ itemNo: 'Y1', pallets: 3 }] });
  assert.equal(big.lines[0].allocated.length, 1);
  assert.equal(big.lines[0].short, 2);
  assert.ok(!big.lines[0].allocated.includes(expired.sscc) && !big.lines[0].allocated.includes(blocked.sscc));
});

test('picking another pallet of the same batch is accepted and swapped', () => {
  const { wh } = setup();
  const a = stock(wh, '01-01-0-10', 'Y1', 'B1', '2026-10-25');
  const b = stock(wh, '01-01-0-40', 'Y1', 'B1', '2026-10-25');
  stock(wh, '01-01-0-70', 'Y1', 'B2', '2026-10-26');
  wh.addOrder({ id: 'O1', customer: 'Shop', lane: 'OUT-01', lines: [{ itemNo: 'Y1', pallets: 1 }] });
  wh.addTruck('RT1');
  const task = wh.tasks[wh.trucks.RT1.taskId];
  assert.equal(task.sscc, a.sscc);
  const r = wh.scan('RT1', b.sscc);
  assert.ok(r.ok, r.text);
  assert.equal(task.sscc, b.sscc);
  assert.equal(a.orderId, null);
  assert.equal(wh.scan('RT1', 'OUT-01').ok, true);
});

test('a pallet of a different batch is refused at pick-up', () => {
  const { wh } = setup();
  stock(wh, '01-01-0-10', 'Y1', 'B1', '2026-10-25');
  const other = stock(wh, '01-01-0-40', 'Y1', 'B2', '2026-10-26');
  wh.addOrder({ id: 'O1', customer: 'Shop', lane: 'OUT-01', lines: [{ itemNo: 'Y1', pallets: 1 }] });
  wh.addTruck('RT1');
  assert.equal(wh.scan('RT1', other.sscc).ok, false);
});

test('missing pallet at pick-up: next pallet by FEFO is allocated straight away', () => {
  const { wh } = setup();
  const first = stock(wh, '01-01-0-10', 'Y1', 'B1', '2026-10-20');
  const second = stock(wh, '01-02-0-10', 'Y1', 'B2', '2026-10-28');
  wh.addOrder({ id: 'O1', customer: 'Shop', lane: 'OUT-01', lines: [{ itemNo: 'Y1', pallets: 1 }] });
  wh.addTruck('RT1');
  const held = wh.tasks[wh.trucks.RT1.taskId];
  const r = wh.reportProblem('RT1', 'missing');
  assert.match(r.text, /Replacement pallet allocated/);
  assert.equal(held.status, 'held');
  assert.equal(first.status, 'missing');
  assert.equal(wh.tasks[wh.trucks.RT1.taskId].sscc, second.sscc);
  wh.releaseTask(held.id);
  assert.equal(held.status, 'cancelled', 'closing a replaced job does not pick twice');
});

test('check & label: scan the pallet, label prints, scan the label, order ready', () => {
  const { wh } = setup();
  const p = stock(wh, '01-01-0-10', 'Y1', 'B1', '2026-10-25');
  wh.addOrder({ id: 'O1', customer: 'Corner Shop', lane: 'OUT-02', lines: [{ itemNo: 'Y1', pallets: 1 }] });
  wh.addTruck('RT1');
  complete(wh, 'RT1');
  const check = wh.tasks[wh.trucks.RT1.taskId];
  assert.equal(check.type, 'CHECK');
  assert.equal(wh.instruction('RT1').kind, 'check-pallet');
  assert.ok(wh.scan('RT1', p.sscc).ok);
  const job = wh.printQueue[0];
  assert.equal(job.printer, 'LP-OUT-02');
  assert.match(job.zpl, /^\^XA[\s\S]*Corner Shop[\s\S]*>;>800\d{18}[\s\S]*\^XZ$/);
  assert.equal(wh.scan('RT1', p.sscc).ok, false, 'needs the new label, not the pallet again');
  assert.ok(wh.scan('RT1', check.labelCode).ok);
  assert.equal(wh.orders.O1.status, 'ready');
  wh.shipOrder('O1');
  assert.equal(p.status, 'shipped');
  assert.equal(wh.locations['OUT-02'].pallets.length, 0);
});

test('every pallet job is two scans, and the next job arrives without any input', () => {
  const { wh } = setup({ checkAfterPick: false });
  stock(wh, '01-01-0-10', 'Y1', 'B1', '2026-10-25');
  stock(wh, '01-03-0-10', 'Y2', 'B2', '2026-10-25');
  wh.addOrder({ id: 'O1', customer: 'Shop', lane: 'OUT-01', lines: [{ itemNo: 'Y1', pallets: 1 }, { itemNo: 'Y2', pallets: 1 }] });
  wh.addTruck('RT1');
  complete(wh, 'RT1');
  assert.ok(wh.trucks.RT1.taskId);
  complete(wh, 'RT1');
  assert.equal(wh.trucks.RT1.stats.scans, 4);
  assert.equal(wh.trucks.RT1.stats.moveInputs / wh.trucks.RT1.stats.moves, 2);
});

test('template change: pallets now in the wrong category get relocation jobs', () => {
  const { wh } = setup();
  const y = stock(wh, '02-05-1-10', 'Y1', 'B1', '2026-11-01');
  const { moves } = wh.setLocationCategory({ aisle: 2, bayFrom: 5, bayTo: 6 }, 'PRO');
  assert.equal(moves, 1);
  wh.addTruck('RT1');
  const task = wh.tasks[wh.trucks.RT1.taskId];
  assert.equal(task.reason, 'template');
  complete(wh, 'RT1');
  const loc = wh.locations[y.loc];
  assert.equal(loc.category, 'YOG');
});

test('the next pallet to ship is brought down to ground level', () => {
  const { wh } = setup({ groundNextPerItem: 1 });
  const next = stock(wh, '01-03-2-40', 'Y1', 'B1', '2026-10-20');
  stock(wh, '01-03-0-10', 'Y1', 'B2', '2026-11-20');
  assert.equal(wh.planGround(), 1);
  wh.addTruck('RT1', { mode: 'shift' });
  const task = wh.tasks[wh.trucks.RT1.taskId];
  assert.equal(task.reason, 'ground');
  complete(wh, 'RT1');
  assert.equal(wh.locations[next.loc].level, 0);
  assert.equal(wh.planGround(), 0, 'nothing left to bring down');
});

test('put-away places a pallet next to the same item, batch and expiry', () => {
  const { wh } = setup();
  stock(wh, '02-04-1-10', 'Y1', 'B9', '2026-11-05');
  wh.addDelivery({ id: 'D1', supplier: 'Dairy Co', category: 'YOG', pallets: 1 });
  wh.addTruck('RT1');
  const sscc = wh.nextSscc();
  wh.scan('RT1', `(00)${sscc}(02)${GS1.gtin14(wh.items.Y1.gtin)}(15)261105(10)B9(37)96`);
  assert.match(wh.tasks[wh.trucks.RT1.taskId].to, /^02-04-1-(40|70)$/);
});

test('grouping moves a pallet that stands alone to the rest of its batch, without swapping pairs', () => {
  const { wh } = setup();
  stock(wh, '01-02-1-10', 'Y1', 'B1', '2026-11-01');
  stock(wh, '01-02-1-40', 'Y1', 'B1', '2026-11-01');
  const lonely = stock(wh, '02-06-2-70', 'Y1', 'B1', '2026-11-01');
  const a = stock(wh, '01-05-1-10', 'Y2', 'Q1', '2026-11-03');
  stock(wh, '02-01-2-10', 'Y2', 'Q1', '2026-11-03');
  assert.equal(wh.planGrouping(), 2, 'one move per batch');
  const shifts = Object.values(wh.tasks).filter((t) => t.reason === 'group');
  const moveB1 = shifts.find((t) => t.sscc === lonely.sscc);
  assert.equal(moveB1.to, '01-02-1-70');
  const moveQ1 = shifts.filter((t) => t.sscc === a.sscc || wh.pallets[t.sscc].batch === 'Q1');
  assert.equal(moveQ1.length, 1, 'the two Q1 pallets are not sent to swap places');
});

test('no more than two trucks are sent into one aisle', () => {
  const { wh } = setup({ checkAfterPick: false });
  for (let b = 1; b <= 3; b++) stock(wh, `01-0${b}-0-10`, 'Y1', `B${b}`, `2026-10-2${b}`);
  wh.addOrder({ id: 'O1', customer: 'Shop', lane: 'OUT-01', lines: [{ itemNo: 'Y1', pallets: 3 }] });
  ['RT1', 'RT2', 'RT3'].forEach((id) => wh.addTruck(id));
  assert.equal(wh.aisleOccupancy()['01'].length, 2);
  assert.equal(wh.trucks.RT3.taskId, null);
  complete(wh, 'RT1');
  assert.equal(wh.aisleOccupancy()['01'].length, 2, 'freed space goes to the next truck');
});

test('Auto-Shift jobs never jump ahead of picks just by waiting', () => {
  const { wh, advance } = setup({ groundNextPerItem: 1 });
  stock(wh, '01-03-2-40', 'Y1', 'B1', '2026-10-20');
  wh.planGround();
  advance(60);
  stock(wh, '03-01-0-10', 'C1', 'K1', '2027-01-01');
  wh.addOrder({ id: 'O1', customer: 'Shop', lane: 'OUT-01', lines: [{ itemNo: 'C1', pallets: 1 }] });
  wh.addTruck('RT1');
  assert.equal(wh.tasks[wh.trucks.RT1.taskId].type, 'PICK');
});

test('a driver can start an Auto-Shift, but only in their own categories', () => {
  const { wh } = setup();
  const cheese = stock(wh, '03-02-1-10', 'C1', 'K1', '2027-01-01');
  const yog = stock(wh, '01-02-1-10', 'Y1', 'B1', '2026-11-01');
  wh.addTruck('RT1', { categories: ['YOG'] });
  assert.match(wh.scan('RT1', cheese.sscc).text, /not one of your categories/);
  const r = wh.scan('RT1', yog.sscc);
  assert.ok(r.ok, r.text);
  const task = wh.tasks[wh.trucks.RT1.taskId];
  assert.equal(wh.locations[task.to].category, 'YOG');
});

test('real location codes: aisle 38, odd bays one side, even the other, positions 10/40/70', () => {
  const wh = new Warehouse({ aisles: [37, 38], bays: 20, levels: 5, clock: () => T0 });
  const loc = wh.locations['38-02-0-10'];
  assert.deepEqual([loc.aisle, loc.bay, loc.level, loc.pos, loc.side], ['38', 2, 0, 10, 'even']);
  assert.equal(wh.locations['38-01-4-70'].side, 'odd');
  assert.equal(wh.locations['38-02-5-10'], undefined, 'levels are 0 (ground) to 4');
  assert.equal(wh.travel('38-01-0-10', '38-02-3-70'), 0, 'bays 01 and 02 face each other');
  assert.deepEqual(wh._bayLevel(loc).map((l) => l.code), ['38-02-0-10', '38-02-0-40', '38-02-0-70']);
});

test('one-way aisles: a bay behind the truck means driving round', () => {
  const wh = new Warehouse({ aisles: [31, 32, 33], bays: 20, levels: 5, clock: () => T0, config: { oneWay: true } });
  // 31 enters from the front, 32 from the back, 33 from the front.
  assert.equal(wh.travel('31-05-0-10', '31-09-0-10'), 2, 'ahead in the same aisle');
  assert.ok(wh.travel('31-09-0-10', '31-05-0-10') > 10, 'behind: out the back and round');
  wh.setConfig({ oneWay: false });
  assert.equal(wh.travel('31-09-0-10', '31-05-0-10'), 2);
});

test('one-way aisles change which job is nearest, and the handheld says where to enter', () => {
  let t = T0;
  const wh = new Warehouse({ aisles: [31, 32], bays: 20, levels: 5, clock: () => t, config: { oneWay: true, groundNextPerItem: 0, checkAfterPick: false } });
  wh.addItem({ itemNo: 'Y1', name: 'Yoghurt', category: 'YOG', palletQty: 96 });
  wh.setLocationCategory({ aisle: 31 }, 'YOG');
  wh.setLocationCategory({ aisle: 32 }, 'YOG');
  const behind = wh.stockPallet('31-03-0-10', { itemNo: 'Y1', batch: 'A', expiry: '2026-11-01' });
  const ahead = wh.stockPallet('31-17-0-10', { itemNo: 'Y1', batch: 'B', expiry: '2026-11-01' });
  wh.addOrder({ id: 'O1', customer: 'Shop', lane: 'OUT-01', lines: [{ itemNo: 'Y1', pallets: 2 }] });
  wh.addTruck('RT1', { mode: 'paused', position: '31-11-0-10' });
  wh.setTruckMode('RT1', 'auto');
  assert.equal(wh.tasks[wh.trucks.RT1.taskId].sscc, ahead.sscc, 'the pallet ahead, not the one just behind');
  assert.equal(wh.entryFor(wh.trucks.RT1, behind.loc), 'front');
  assert.equal(wh.entryFor(wh.trucks.RT1, ahead.loc), null, 'already in the aisle, keep driving');
});

test('manager minimum days to ship: short pallets are skipped, and raising it swaps allocations', () => {
  const { wh } = setup();
  const soon = stock(wh, '01-01-0-10', 'Y1', 'S', '2026-10-20'); // 13 days left
  const later = stock(wh, '01-02-0-10', 'Y1', 'L', '2026-11-20');
  const o = wh.addOrder({ id: 'O1', customer: 'Shop', lane: 'OUT-01', lines: [{ itemNo: 'Y1', pallets: 1 }] });
  assert.deepEqual(o.lines[0].allocated, [soon.sscc], 'minimum is 10, 13 days is fine');
  wh.setMinShipDays('Y1', 14);
  assert.deepEqual(o.lines[0].allocated, [later.sscc], 'now too short: swapped for the next pallet');
  assert.equal(wh.shipState(soon), 'short');
  wh.allowShortShip(soon.sscc);
  assert.equal(wh.shipState(soon), 'ok', 'manager let this one pallet go');
});

test('3-barcode supplier label: scan all three in any order, no typing', () => {
  const { wh } = setup();
  wh.addDelivery({ id: 'D1', supplier: 'Dairy Co', category: 'YOG', pallets: 1 });
  wh.addTruck('RT1');
  const sscc = GS1.makeSscc(3, '8712345', 991);
  assert.ok(wh.scan('RT1', `15261031${'10'}L77`).ok, 'middle: best-before + batch');
  assert.ok(wh.scan('RT1', `00${sscc}`).ok, 'bottom: SSCC');
  const r = wh.scan('RT1', `02${GS1.gtin14(wh.items.Y1.gtin)}3796`);
  assert.match(r.text, /Delivery complete/, 'top: item + count completes the pallet');
  assert.deepEqual([wh.pallets[sscc].batch, wh.pallets[sscc].expiry, wh.pallets[sscc].qty], ['L77', '2026-10-31', 96]);
  assert.equal(wh.trucks.RT1.stats.receiveInputs, 3);
});

test('with a delivery list, the bottom barcode (SSCC) alone registers the pallet', () => {
  const { wh } = setup();
  const s1 = GS1.makeSscc(3, '8712345', 1);
  const s2 = GS1.makeSscc(3, '8712345', 2);
  wh.addDelivery({ id: 'D1', supplier: 'Dairy Co', category: 'YOG', list: [
    { sscc: s1, itemNo: 'Y1', batch: 'B1', expiry: '2026-11-01', qty: 96 },
    { sscc: s2, itemNo: 'Y2', batch: 'Q1', expiry: '2026-11-03', qty: 120 },
  ] });
  wh.addTruck('RT1');
  assert.match(wh.scan('RT1', `(00)${s1}`).text, /Pallet 1 of 2 registered/);
  assert.match(wh.scan('RT1', s2).text, /Delivery complete/, 'a bare 18-digit SSCC works too');
  assert.equal(wh.pallets[s2].itemNo, 'Y2');
});

test('label and delivery list disagreeing is caught', () => {
  const { wh } = setup();
  const s1 = GS1.makeSscc(3, '8712345', 5);
  wh.addDelivery({ id: 'D1', supplier: 'Dairy Co', category: 'YOG', list: [{ sscc: s1, itemNo: 'Y1', batch: 'B1', expiry: '2026-11-01', qty: 96 }] });
  wh.addTruck('RT1');
  wh.scan('RT1', `15261101${'10'}WRONG`);
  const r = wh.scan('RT1', `00${s1}`);
  assert.equal(r.ok, false);
  assert.match(r.text, /disagree on batch/);
});

test('proposed names: cell + rack letter, bay front to back, level letter, position 1–3', () => {
  const wh = new Warehouse({ aisles: [31, 32, 33, 34, 35, 36, 37, 38], bays: 20, levels: 5, clock: () => T0 });
  assert.equal(wh.rowName('31-05-2-40'), 'AA03C2', 'cell A, rack A, bay 03, level C, position 2');
  assert.equal(wh.rowName('31-13-0-10'), 'AA07A1');
  assert.equal(wh.rowName('31-14-0-10'), 'AB07A1', 'the facing rack has the same bay number');
  assert.equal(wh.rowName('32-01-0-10'), 'AC01A1', 'next aisle: racks C and D');
  assert.equal(wh.rowName('38-02-0-10'), 'AP01A1');
  assert.equal(wh.rowName('38-20-4-70'), 'AP10E3');
  assert.deepEqual(wh.spoken('31-05-2-40'), { short: 'A3C2', cell: 'A' });
  assert.equal(wh.resolve('aa03c2'), '31-05-2-40');
  assert.equal(wh.resolve('AA-03-C-2'), '31-05-2-40', 'dashes and spaces are ignored');
  assert.equal(wh.resolve('A3C2', { cell: 'A' }), '31-05-2-40', 'short form in the cell you are in');
  assert.equal(wh.resolve('A3C2'), 'A3C2', 'short form without a cell means nothing');
  assert.equal(wh.resolve('ZZ01A1'), 'ZZ01A1', 'unknown names are left alone');
  wh.setAisleCell(35, 'B'); wh.setAisleCell(36, 'B'); wh.setAisleCell(37, 'B'); wh.setAisleCell(38, 'B');
  assert.equal(wh.rowName('35-01-0-10'), 'BA01A1', 'a second cell starts again at rack A');
  assert.equal(wh.resolve('BH01A1'), '38-02-0-10');
  const list = wh.relabelList(38);
  assert.equal(list.length, 20 * 5 * 3);
  assert.equal(new Set(list.map((r) => r.row)).size, list.length, 'every new name is unique');
});

test('a driver can type the spoken short form; the cell is the one the truck is in', () => {
  const { wh } = setup({ checkAfterPick: false });
  const p = stock(wh, '01-05-2-40', 'Y1', 'B1', '2026-10-25');
  wh.addTruck('RT1', { position: '01-01-0-10' });
  const r = wh.scan('RT1', 'A3C2');
  assert.ok(r.ok, r.text);
  assert.equal(wh.tasks[wh.trucks.RT1.taskId].sscc, p.sscc, 'started an Auto-Shift of that pallet');
});

test('either label scans: racks can be relabelled one aisle at a time', () => {
  const { wh } = setup({ checkAfterPick: false });
  const p = stock(wh, '01-05-0-10', 'Y1', 'B1', '2026-10-25');
  wh.addOrder({ id: 'O1', customer: 'Shop', lane: 'OUT-01', lines: [{ itemNo: 'Y1', pallets: 1 }] });
  wh.addTruck('RT1');
  wh.setNaming('row');
  const r = wh.scan('RT1', wh.rowName(p.loc));
  assert.ok(r.ok, r.text);
  assert.equal(wh.display('Take it from 01-05-0-10'), 'Take it from AA03A1');
  assert.ok(wh.scan('RT1', 'OUT-01').ok);
});

test('template by side and bays along the row', () => {
  const { wh } = setup();
  const { changed } = wh.setLocationCategory({ aisle: 2, side: 'even', rowFrom: 2, rowTo: 3 }, 'PRO');
  assert.equal(changed, 2 * 3 * 3, '2 bays × 3 levels × 3 positions');
  assert.equal(wh.locations['02-04-0-10'].category, 'PRO');
  assert.equal(wh.locations['02-03-0-10'].category, 'YOG', 'odd side untouched');
});
