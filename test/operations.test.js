const test = require('node:test');
const assert = require('node:assert/strict');
const { Warehouse } = require('../src/engine');

function wh() {
  const w = new Warehouse({ aisles: [1], bays: 2, levels: 1, positions: [10], outLanes: 1, clock: () => Date.UTC(2026, 9, 8, 8) });
  w.setFeatures({ lotExpiry: true, fefo: true });
  w.addClient({ id: 'CL-1', name: 'North Shop' });
  w.addItem({ itemNo: 'SKU1', name: 'Mug', category: 'YOG', palletQty: 10, clientId: 'CL-1' });
  w.addItem({ itemNo: 'BASE', name: 'Laptop', category: 'YOG', palletQty: 1, clientId: 'CL-1' });
  w.addItem({ itemNo: 'PLUG', name: 'Plug', category: 'YOG', palletQty: 1, clientId: 'CL-1' });
  w.addItem({ itemNo: 'KITSKU', name: 'Laptop with plug', category: 'YOG', palletQty: 1, clientId: 'CL-1' });
  w.createLocation({ code: 'MEZZ-A1', kind: 'mezzanine', name: 'Mezzanine' });
  w.createLocation({ code: 'RETURNS', kind: 'virtual', role: 'return', name: 'Returns' });
  w.createLocation({ code: 'QRET', kind: 'virtual', role: 'quarantine', name: 'Return quarantine' });
  return w;
}

test('a mezzanine pick consumes the sales-order line and the pick face', () => {
  const w = wh();
  w.issueSeries({ series: 'ST', itemNo: 'SKU1', qty: 6, loc: 'MEZZ-A1' });
  const order = w.addOrder({ id: 'SO1', customer: 'North Shop', lane: 'OUT-01', lines: [{ itemNo: 'SKU1', units: 4 }] });
  assert.equal(order.lines[0].kind, 'each');
  assert.equal(order.lines[0].picked, 0);
  w.pickHolder({ id: 'ST0000001', orderId: 'SO1', qty: 4, by: 'omar' });
  assert.equal(order.lines[0].picked, 4);
  assert.equal(order.status, 'ready');
  assert.equal(w.holders.ST0000001.contents[0].qty, 2);
  assert.equal(w.movementsFor({ holder: 'ST0000001' })[0].event, 'picked');
  assert.throws(() => w.pickHolder({ id: 'ST0000001', orderId: 'SO1', qty: 1 }), /no open line/);
});

test('a work order builds a kit from component stock and fulfils the order', () => {
  const w = wh();
  w.addKit({ id: 'KIT-PLUG', name: 'Laptop with plug', output: 'KITSKU', base: { itemNo: 'BASE', qty: 1 }, components: [{ itemNo: 'PLUG', qty: 1 }] });
  w.addValStation({ id: 'VAL-01', name: 'Bench', kitId: 'KIT-PLUG' });
  w.issueSeries({ series: 'ST', itemNo: 'BASE', qty: 2, loc: 'MEZZ-A1' });
  w.issueSeries({ series: 'ST', itemNo: 'PLUG', qty: 2, loc: 'MEZZ-A1' });
  w.addOrder({ id: 'SO2', customer: 'North Shop', lane: 'OUT-01', lines: [{ kitId: 'KIT-PLUG', units: 2 }] });
  const wo = w.addWorkOrder({ id: 'WO-1', kitId: 'KIT-PLUG', qty: 2, orderId: 'SO2' });
  w.startVal({ stationId: 'VAL-01', workOrderId: wo.id, by: 'omar' });
  assert.throws(() => w.scanVal({ stationId: 'VAL-01', code: 'BASE' }), /license plate/);
  w.scanVal({ stationId: 'VAL-01', code: 'ST0000001', by: 'omar' });
  w.scanVal({ stationId: 'VAL-01', code: 'ST0000002', by: 'omar' });
  assert.equal(w.workOrders['WO-1'].built, 1);
  assert.equal(w.workOrders['WO-1'].status, 'open');
  w.scanVal({ stationId: 'VAL-01', code: 'ST0000001', by: 'omar' });
  const done = w.scanVal({ stationId: 'VAL-01', code: 'ST0000002', by: 'omar' });
  assert.equal(done.status, 'done');
  assert.equal(w.workOrders['WO-1'].status, 'done');
  assert.equal(w.orders.SO2.lines[0].picked, 2);
  assert.equal(w.holders.ST0000001.contents[0].qty, 0);
  assert.equal(w.holders.ST0000002.contents[0].qty, 0);
  assert.ok(w.movementsFor({ holder: 'ST0000002' }).some((m) => m.event === 'kitted'));
});

test('packing records the carton, prints an OUT label and a slip, then dispatches', () => {
  const w = wh();
  w.issueSeries({ series: 'ST', itemNo: 'SKU1', qty: 3, loc: 'MEZZ-A1' });
  w.addOrder({ id: 'SO3', customer: 'North Shop', lane: 'OUT-01', lines: [{ itemNo: 'SKU1', units: 2 }] });
  w.pickHolder({ id: 'ST0000001', orderId: 'SO3', qty: 2 });
  const carton = w.openCarton({ orderId: 'SO3', by: 'olivia' });
  assert.equal(carton.series, 'OUT');
  assert.equal(carton.id, 'OUT0000001');
  w.packIntoCarton({ carton: carton.id, code: 'ST0000001', qty: 2, by: 'olivia' });
  const closed = w.closeCarton({ carton: carton.id, lengthMm: 400, widthMm: 300, heightMm: 200, weightKg: 1.5, by: 'olivia' });
  assert.equal(closed.carton.cartonStatus, 'closed');
  assert.match(closed.label.zpl, /OUT LABEL/);
  assert.match(closed.label.zpl, /OUT0000001/);
  assert.match(closed.slip.zpl, /PACKING SLIP/);
  assert.match(closed.slip.zpl, /1.5 kg/);
  const shipped = w.dispatchCartons({ orderId: 'SO3', by: 'olivia' });
  assert.equal(shipped.order.status, 'shipped');
  assert.equal(w.holders.OUT0000001.cartonStatus, 'shipped');
  assert.equal(w.holders.OUT0000001.loc, 'OUT-01');
  assert.ok(w.movementsFor({ holder: 'OUT0000001' }).some((m) => m.event === 'shipped'));
  assert.throws(() => w.shipOrder('SO3'), /packed cartons/);
});

test('pick faces queue a replenishment move when stock falls to the trigger', () => {
  const w = wh();
  w.stockPallet('01-01-0-10', { itemNo: 'SKU1', batch: 'B', expiry: '2027-01-01', qty: 10 });
  w.issueSeries({ series: 'ST', itemNo: 'SKU1', qty: 5, loc: 'MEZZ-A1' });
  w.setPickFace({ code: 'MEZZ-A1', itemNo: 'SKU1', min: 2, max: 12, trigger: 4 });
  w.addOrder({ id: 'SO4', customer: 'North Shop', lane: 'OUT-01', lines: [{ itemNo: 'SKU1', units: 2 }] });
  w.pickHolder({ id: 'ST0000001', orderId: 'SO4', qty: 2 });
  const task = Object.values(w.tasks).find((t) => t.reason === 'replenish' && t.to === 'MEZZ-A1');
  assert.ok(task, 'a replenishment move is in the machine queue');
  assert.equal(task.type, 'SHIFT');
  assert.equal(task.splitQty, 9, 'top up to the maximum, not the whole pallet');
  const again = w.planReplenishment();
  assert.equal(again.length, 0);
});

test('returns are received against an order and graded with history', () => {
  const w = wh();
  w.stockPallet('01-01-0-10', { itemNo: 'SKU1', batch: 'B', expiry: '2027-01-01', qty: 10 });
  const order = w.addOrder({ id: 'SO5', customer: 'North Shop', lane: 'OUT-01', lines: [{ itemNo: 'SKU1', pallets: 1 }] });
  order.status = 'shipped';
  const rma = w.receiveReturn({ id: 'RMA-1', orderId: 'SO5', itemNo: 'SKU1', qty: 2, loc: 'RETURNS', by: 'omar' });
  assert.equal(rma.status, 'received');
  assert.equal(rma.history[0].event, 'received');
  const held = w.gradeReturn({ id: 'RMA-1', grade: 'quarantine', to: 'QRET', by: 'morgan' });
  assert.equal(held.status, 'quarantine');
  assert.equal(w.holders[held.holderId].loc, 'QRET');
  assert.ok(held.history.some((h) => h.event === 'quarantine'));
  const scrap = w.receiveReturn({ id: 'RMA-2', orderId: 'SO5', itemNo: 'SKU1', qty: 1, loc: 'RETURNS' });
  w.gradeReturn({ id: scrap.id, grade: 'scrap', by: 'morgan' });
  assert.equal(w.returns['RMA-2'].status, 'scrapped');
  assert.ok(w.movementsFor({}).some((m) => m.event === 'scrapped'));
  const back = w.receiveReturn({ id: 'RMA-3', orderId: 'SO5', itemNo: 'SKU1', qty: 1, loc: 'RETURNS' });
  const restocked = w.gradeReturn({ id: back.id, grade: 'restock', to: 'MEZZ-A1' });
  assert.equal(restocked.status, 'restocked');
  assert.equal(w.holders[restocked.holderId].loc, 'MEZZ-A1');
});

test('available-to-sell and low stock follow on-hand, allocations and the reorder point', () => {
  const w = wh();
  w.updateItem('SKU1', { reorderPoint: 12 });
  w.stockPallet('01-01-0-10', { itemNo: 'SKU1', batch: 'B', expiry: '2027-01-01', qty: 10 });
  w.addOrder({ id: 'SO6', customer: 'North Shop', lane: 'OUT-01', lines: [{ itemNo: 'SKU1', units: 3 }] });
  const row = w.availability().find((r) => r.sku === 'SKU1');
  assert.equal(row.onHand, 10);
  assert.equal(row.reserved, 3);
  assert.equal(row.available, 7);
  assert.equal(row.low, true);
  assert.equal(w.lowStock()[0].sku, 'SKU1');
});

test('billing totals pallet-days and moves at the client rates', () => {
  const w = wh();
  w.updateClient('CL-1', { storageRate: 2, handlingRate: 0.5 });
  const pallet = w.stockPallet('01-01-0-10', { itemNo: 'SKU1', batch: 'B', expiry: '2027-01-01', qty: 10, clientId: 'CL-1' });
  pallet.receivedAt = w.now() - 2 * 86400000;
  w.recordMovement({ sscc: pallet.sscc, from: 'DOCK-IN', to: '01-01-0-10', qty: 10, event: 'moved', by: 'mina' });
  const report = w.billingReport({ clientId: 'CL-1' });
  assert.equal(report.length, 1);
  assert.ok(report[0].palletDays >= 1.9 && report[0].palletDays <= 2.1);
  assert.equal(report[0].moves, 1);
  assert.equal(report[0].storage, 4);
  assert.equal(report[0].handling, 0.5);
  assert.equal(report[0].total, 4.5);
});
