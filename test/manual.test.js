const test = require('node:test');
const assert = require('node:assert/strict');
const GS1 = require('../src/gs1');
const { Warehouse } = require('../src/engine');

const T0 = Date.UTC(2026, 9, 7, 6, 0);

function setup(config = {}) {
  let t = T0;
  const wh = new Warehouse({ aisles: [31, 32, 33, 34], bays: 6, levels: 3, clock: () => t, config: { groundNextPerItem: 0, checkAfterPick: false, ...config } });
  wh.addItem({ itemNo: 'Y1', gtin: GS1.makeGtin13('20000', 1), name: 'Yoghurt', category: 'YOG', palletQty: 96 });
  wh.addItem({ itemNo: 'C1', gtin: GS1.makeGtin13('20000', 3), name: 'Gouda', category: 'CHE', palletQty: 80 });
  wh.setAisleCell(33, 'B'); wh.setAisleCell(34, 'B');
  return { wh, tick: (min) => { t += min * 60000; } };
}

test('template by range in the proposed naming: AA to AD is cell A, BA to BD is cell B', () => {
  const { wh } = setup();
  const a = wh.selectLocations('AA01A1', 'AD03C3');
  assert.equal(a.length, 2 * 6 * 3 * 3, 'aisles 31–32, both sides, 3 bays per row, 3 levels, 3 positions');
  assert.ok(a.every((c) => ['31', '32'].includes(c.slice(0, 2))));
  const r = wh.applyTemplate(a, 'CHE');
  assert.equal(r.changed, a.length);
  const b = wh.selectLocations('BA', 'BD'); // partial codes: whole racks
  wh.applyTemplate(b, 'YOG');
  assert.equal(wh.locations['33-01-0-10'].category, 'YOG');
  assert.equal(wh.locations['31-01-0-10'].category, 'CHE');
});

test('template selection works on one level or one bay range too', () => {
  const { wh } = setup();
  assert.equal(wh.selectLocations('AA01A', 'AZ99A').length, 4 * 3 * 3, 'ground level of cell A only (2 aisles × 2 racks × 3 bays × 3 positions)');
  assert.equal(wh.selectLocations('31-01', '31-02').length, 2 * 3 * 3, 'current naming: aisle 31 bays 01–02');
  assert.throws(() => wh.selectLocations('AA01A1', '31-01-0-10'), /same naming/);
});

test('template preview says how many pallets would end up in the wrong category', () => {
  const { wh } = setup();
  wh.applyTemplate(wh.selectLocations('AA', 'AD'), 'YOG');
  wh.stockPallet('31-01-0-10', { itemNo: 'Y1', batch: 'B1', expiry: '2026-11-01' });
  const sel = wh.selectLocations('AA01A1', 'AA01A1');
  const pv = wh.previewTemplate(sel, 'CHE');
  assert.deepEqual([pv.locations, pv.changed, pv.palletsToMove], [1, 1, 1]);
  assert.equal(wh.applyTemplate(sel, 'CHE').moves, 1, 'relocation job created');
});

test('transfer mode: scan pallet, scan location — recorded as it is', () => {
  const { wh } = setup();
  wh.applyTemplate(wh.selectLocations('AA', 'BD'), 'YOG');
  const p = wh.stockPallet('31-01-0-10', { itemNo: 'Y1', batch: 'B1', expiry: '2026-11-01' });
  wh.addTruck('RT1', { mode: 'transfer' });
  assert.match(wh.scan('RT1', p.sscc).text, /Scan the location/);
  assert.match(wh.scan('RT1', 'AB02B3').text, /Recorded at 31-04-1-70/);
  assert.equal(p.loc, '31-04-1-70');
  assert.equal(wh.locations['31-01-0-10'].sscc, null);
  assert.equal(wh.transfers[0].from, '31-01-0-10');
});

test('transfer onto a spot the system thinks is taken: the other pallet goes on the unknown-location list', () => {
  const { wh } = setup();
  const a = wh.stockPallet('31-01-0-10', { itemNo: 'Y1', batch: 'B1', expiry: '2026-11-01' });
  const b = wh.stockPallet('31-02-0-10', { itemNo: 'Y1', batch: 'B2', expiry: '2026-11-02' });
  const r = wh.transferPallet(a.sscc, '31-02-0-10', { by: 'RT1' });
  assert.match(r.text, /unknown-location list/);
  assert.equal(b.status, 'missing');
  assert.deepEqual(wh.lostPallets().map((p) => p.sscc), [b.sscc]);
  wh.transferPallet(b.sscc, '31-03-0-10'); // found it elsewhere
  assert.equal(b.status, 'available');
  assert.equal(wh.lostPallets().length, 0);
});

test('a planned pick follows a transferred pallet; a pallet on the forks cannot be transferred', () => {
  const { wh } = setup();
  const p = wh.stockPallet('31-01-0-10', { itemNo: 'Y1', batch: 'B1', expiry: '2026-11-01' });
  const o = wh.addOrder({ id: 'O1', customer: 'Shop', lane: 'OUT-01', lines: [{ itemNo: 'Y1', pallets: 1 }] });
  const pick = Object.values(wh.tasks).find((t) => t.orderId === o.id);
  wh.transferPallet(p.sscc, '31-05-1-40');
  assert.equal(pick.from, '31-05-1-40');
  wh.addTruck('RT1');
  wh.scan('RT1', p.sscc);
  assert.equal(wh.transferPallet(p.sscc, '31-03-0-10').ok, false);
});

test('manual pick: scan an order, get only its picks', () => {
  const { wh } = setup();
  wh.stockPallet('31-01-0-10', { itemNo: 'Y1', batch: 'B1', expiry: '2026-11-01' });
  wh.stockPallet('31-02-0-10', { itemNo: 'Y1', batch: 'B2', expiry: '2026-11-02' });
  wh.addOrder({ id: '4501', customer: 'Shop', lane: 'OUT-01', lines: [{ itemNo: 'Y1', pallets: 1 }] });
  wh.addOrder({ id: '4502', customer: 'Deli', lane: 'OUT-02', lines: [{ itemNo: 'Y1', pallets: 1 }] });
  wh.addTruck('RT1', { mode: 'pick' });
  assert.equal(wh.trucks.RT1.taskId, null, 'nothing until an order is chosen');
  assert.match(wh.scan('RT1', 'O4502').text, /Order 4502: pick/);
  assert.equal(wh.tasks[wh.trucks.RT1.taskId].orderId, '4502');
});

test('manual put-away: scan a pallet at the dock, get its slot', () => {
  const { wh } = setup();
  wh.applyTemplate(wh.selectLocations('AA', 'BD'), 'YOG');
  const p = wh.stockPallet('DOCK-IN', { itemNo: 'Y1', batch: 'B1', expiry: '2026-11-01' });
  wh.addTruck('RT1', { mode: 'putaway' });
  const r = wh.scan('RT1', p.sscc);
  assert.match(r.text, /Put it away at/);
  const task = wh.tasks[wh.trucks.RT1.taskId];
  assert.ok(wh.scan('RT1', task.to).ok);
  assert.equal(wh.locations[p.loc].category, 'YOG');
});

test('find mode answers what is where, and changes nothing', () => {
  const { wh } = setup();
  const p = wh.stockPallet('31-01-0-10', { itemNo: 'Y1', batch: 'B1', expiry: '2026-11-01' });
  wh.addTruck('RT1', { mode: 'find' });
  assert.match(wh.scan('RT1', 'AA01A1').text, /…\w{6} Y1 .* B1/);
  assert.match(wh.scan('RT1', p.sscc).text, /At 31-01-0-10/);
});

test('trace a batch: received from, in stock, shipped to whom', () => {
  const { wh } = setup();
  wh.addDelivery({ id: 'D1', supplier: 'Dairy', category: 'YOG', pallets: 2, at: 'desk' });
  wh.addDesk('DESK1');
  wh.deskStart('DESK1');
  const s1 = GS1.makeSscc(3, '8712345', 1);
  const s2 = GS1.makeSscc(3, '8712345', 2);
  for (const s of [s1, s2]) wh.scan('DESK1', `(00)${s}(02)${GS1.gtin14(wh.items.Y1.gtin)}(15)261101(10)LOT7(37)96`);
  wh.transferPallet(s1, 'OUT-01');
  wh.addOrder({ id: 'O1', customer: 'Corner Shop', lane: 'OUT-01', lines: [] });
  const o = wh.orders.O1;
  o.lines.push({ itemNo: 'Y1', pallets: 1, allocated: [s1], short: 0 });
  wh.pallets[s1].orderId = 'O1';
  wh.pallets[s1].checked = true;
  o.status = 'ready';
  wh.shipOrder('O1');
  const tr = wh.trace('lot7');
  assert.deepEqual(tr.received.map((d) => d.id), ['D1']);
  assert.deepEqual(tr.customers, ['Corner Shop']);
  assert.equal(tr.inStock.length, 1);
});

test('save and restore gives the same warehouse', () => {
  const { wh } = setup();
  wh.stockPallet('31-01-0-10', { itemNo: 'Y1', batch: 'B1', expiry: '2026-11-01' });
  wh.addOrder({ id: 'O1', customer: 'Shop', lane: 'OUT-01', lines: [{ itemNo: 'Y1', pallets: 1 }] });
  const copy = Warehouse.restore(JSON.parse(JSON.stringify(wh)), { clock: () => T0 });
  assert.deepEqual(JSON.parse(JSON.stringify(copy)), JSON.parse(JSON.stringify(wh)));
  copy.addTruck('RT1');
  assert.equal(copy.tasks[copy.trucks.RT1.taskId].type, 'PICK', 'and it keeps working');
});

test('categories can be set for the site', () => {
  const wh = new Warehouse({ aisles: 1, bays: 2, levels: 1, categories: { FRZ: 'Frozen' }, clock: () => T0 });
  wh.addItem({ itemNo: 'F1', name: 'Ice', category: 'FRZ', palletQty: 10 });
  assert.throws(() => wh.addItem({ itemNo: 'Y1', name: 'Yoghurt', category: 'YOG', palletQty: 10 }), /Unknown category/);
});
