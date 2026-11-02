const test = require('node:test');
const assert = require('node:assert/strict');
const GS1 = require('../src/gs1');
const { Warehouse } = require('../src/engine');

const sscc = (n) => { const body = String(n).padStart(17, '0'); return body + GS1.checkDigit(body); };
const sns = (prefix, n) => Array.from({ length: n }, (_, i) => `${prefix}-${String(i + 1).padStart(3, '0')}`);

// Routers come 4 to a box, 8 to a pallet. Pallets stand in the racks; one shelf of bins.
function wh() {
  const w = new Warehouse({ aisles: [1], bays: 2, levels: 2, positions: [10], outLanes: 1, clock: () => Date.UTC(2026, 10, 3, 8) });
  w.addItem({ itemNo: 'RTR', name: 'Wifi router', category: 'GEN', palletQty: 8, uom: 'piece' });
  w.addItem({ itemNo: 'CABLE', name: 'Cable', category: 'GEN', palletQty: 100, uom: 'piece' });
  w.setItemUnits('RTR', { packs: [{ unit: 'box', per: 4 }] });
  w.setItemSerials('RTR', true);
  w.generateGuided({ sections: { count: 1, name: 'Shelf' }, layouts: [{ type: 'shelf', positions: { count: 2, name: 'Bin 1' } }] });
  return w;
}

test('a pallet carries one serial per piece; its serials stand where it stands', () => {
  const w = wh();
  const p = w.stockPallet('01-01-0-10', { sscc: sscc(1), itemNo: 'RTR', qty: 8, receivedAt: 1 });
  const c = w.stockPallet('01-02-0-10', { sscc: sscc(2), itemNo: 'CABLE', qty: 100, receivedAt: 1 });
  assert.throws(() => w.palletSerials({ sscc: c.sscc, serials: ['X-1'] }), /CABLE is not traced/);
  assert.throws(() => w.palletSerials({ sscc: p.sscc, serials: sns('R', 7) }), /8 pieces of RTR: scan 8 serial numbers, not 7/);
  w.binPut({ loc: 'Shelf-Bin1', itemNo: 'RTR', qty: 1, serials: ['LOOSE-1'] });
  assert.throws(() => w.palletSerials({ sscc: p.sscc, serials: [...sns('R', 7), 'LOOSE-1'] }), /LOOSE-1 is already in stock at Shelf-Bin1/);
  w.palletSerials({ sscc: p.sscc, serials: sns('R', 8) });
  assert.deepEqual([w.serialTrace('R-003').loc, w.serialTrace('R-003').sscc], ['01-01-0-10', p.sscc]);
  w.transferPallet(p.sscc, '01-02-1-10');
  assert.equal(w.serialTrace('R-003').loc, '01-02-1-10', 'the serials follow the pallet');
  assert.equal(w.serialsIn({ loc: '01-02-1-10' }).length, 8);
  const again = w.palletSerials({ sscc: p.sscc, serials: [...sns('R', 7), 'R-099'] });
  assert.deepEqual(again.dropped, ['R-008'], 'booking the list again marks one no longer on it missing');
  assert.equal(w.serialTrace('R-008').status, 'missing');
  assert.deepEqual(w.palletSerialList(p.sscc).serials.slice(-1), ['R-099']);
});

test('a whole pallet ships with its serials, unscanned, to the order and customer; they can come back', () => {
  const w = wh();
  const p = w.stockPallet('01-01-0-10', { sscc: sscc(3), itemNo: 'RTR', qty: 8, receivedAt: 1 });
  w.palletSerials({ sscc: p.sscc, serials: sns('S', 8) });
  w.addOrder({ id: 'SO1', customer: 'Telco shop', lane: 'OUT-01', lines: [{ itemNo: 'RTR', units: 8 }] });
  const wave = w.planWave({ orders: ['SO1'] });
  assert.deepEqual(wave.tasks.map((t) => t.kind), ['pallet']);
  w.confirmWaveTask({ task: wave.tasks[0].id });
  assert.equal(w.serialTrace('S-001').loc, 'OUT-01', 'on the dock lane with its pallet');
  w.stageShipment({ orderId: 'SO1' });
  w.scanShipment({ orderId: 'SO1', code: p.sscc });
  w.dispatchShipment({ orderId: 'SO1' });
  const t = w.serialTrace('S-005');
  assert.deepEqual([t.status, t.orderId, t.customer], ['shipped', 'SO1', 'Telco shop']);
  assert.equal(t.history[0].event, 'shipped');
  assert.deepEqual(w.serialsForOrder('SO1').map((s) => s.carton), Array(8).fill(p.sscc));
  assert.match(w.deliveryNote('SO1'), new RegExp(`<td>${p.sscc}</td><td>RTR</td><td[^>]*>S-001, S-002`));
  assert.deepEqual(w.returnable('SO1').lines[0].serials, sns('S', 8));
  const rma = w.receiveReturn({ orderId: 'SO1', itemNo: 'RTR', qty: 1, serials: ['S-002'] });
  w.gradeReturn({ id: rma.id, grade: 'restock', to: 'Shelf-Bin2' });
  assert.deepEqual([w.serialTrace('S-002').loc, w.serialTrace('S-002').sscc], ['Shelf-Bin2', null]);
});

test('boxes picked from a pallet scan serials that are on that pallet; the rest stay on it', () => {
  const w = wh();
  const p = w.stockPallet('01-01-0-10', { sscc: sscc(4), itemNo: 'RTR', qty: 8, receivedAt: 1 });
  w.palletSerials({ sscc: p.sscc, serials: sns('B', 8) });
  w.binPut({ loc: 'Shelf-Bin1', itemNo: 'RTR', qty: 1, serials: ['LOOSE-1'] });
  w.addOrder({ id: 'SO2', customer: 'Shop', lane: 'OUT-01', lines: [{ itemNo: 'RTR', units: 4 }] });
  const [task] = w.planWave({ orders: ['SO2'] }).tasks;
  assert.deepEqual([task.kind, task.box], ['case', 'whole']);
  assert.throws(() => w.confirmWaveTask({ task: task.id, serials: ['B-001', 'B-002', 'B-003', 'LOOSE-1'] }), /LOOSE-1 is booked at Shelf-Bin1, not 01-01-0-10/);
  w.confirmWaveTask({ task: task.id, serials: ['B-001', 'B-002', 'B-003', 'B-004'] });
  assert.deepEqual([w.serialTrace('B-001').status, w.serialTrace('B-001').sscc], ['picked', null]);
  assert.deepEqual(w.palletSerialList(p.sscc).serials, ['B-005', 'B-006', 'B-007', 'B-008']);
});

test('a pallet taken out of stock takes its serials out too', () => {
  const w = wh();
  const p = w.stockPallet('01-01-0-10', { sscc: sscc(5), itemNo: 'RTR', qty: 8, receivedAt: 1 });
  w.palletSerials({ sscc: p.sscc, serials: sns('D', 8) });
  w.deleteStock({ sscc: p.sscc, reason: 'damage' });
  assert.equal(w.serialTrace('D-008').status, 'removed');
  assert.equal(w.serialsIn({ itemNo: 'RTR' }).length, 0);
});

test('serials on the supplier\'s pallet list are booked when the pallet is received', () => {
  const w = wh();
  w.setItemSerials('RTR', true);
  const s1 = GS1.makeSscc(3, '0614141', 1);
  const s2 = GS1.makeSscc(3, '0614141', 2);
  w.addDelivery({ id: 'D1', supplier: 'Net Co', category: 'GEN', list: [
    { sscc: s1, itemNo: 'RTR', batch: 'B1', expiry: '2027-11-01', qty: 8, serials: sns('ASN', 8) },
    { sscc: s2, itemNo: 'RTR', batch: 'B1', expiry: '2027-11-01', qty: 8, serials: sns('BAD', 3) },
  ] });
  w.addTruck('RT1');
  assert.match(w.scan('RT1', s1).text, /Pallet 1 of 2 registered · 8 serials/);
  assert.equal(w.serialTrace('ASN-008').loc, 'DOCK-IN');
  assert.match(w.scan('RT1', s2).text, /serials not booked: 8 pieces of RTR: scan 8 serial numbers, not 3/, 'a wrong list does not stop receiving');
  assert.equal(w.pallets[s2].loc, 'DOCK-IN');
});
