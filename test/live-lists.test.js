const test = require('node:test');
const assert = require('node:assert/strict');
const GS1 = require('../src/gs1');
const { Warehouse } = require('../src/engine');

const sscc = (n) => { const body = String(n).padStart(17, '0'); return body + GS1.checkDigit(body); };
const LIVE = ['open', 'active', 'held'];

// What the in-memory lists must always equal: a full walk of the data.
function same(w, label) {
  assert.deepEqual(w._livePallets().map((p) => p.sscc), Object.values(w.pallets).filter((p) => p.status !== 'shipped').map((p) => p.sscc), `${label}: pallets`);
  assert.deepEqual(w._liveTasks().map((t) => t.id), Object.values(w.tasks).filter((t) => LIVE.includes(t.status)).map((t) => t.id), `${label}: tasks`);
  assert.deepEqual(w._liveOrders().map((o) => o.id).sort(), Object.values(w.orders).filter((o) => o.status !== 'shipped').map((o) => o.id).sort(), `${label}: orders`);
}

test('the in-memory lists of what is still in play match the data through shipping, deleting, transfers and a restart', () => {
  const w = new Warehouse({ aisles: [1], bays: 3, levels: 2, positions: [10], outLanes: 1, clock: () => Date.UTC(2026, 10, 4, 8) });
  w.addItem({ itemNo: 'BOX', name: 'Box', category: 'YOG', palletQty: 10, uom: 'piece' });
  w.generateGuided({ sections: { count: 1, name: 'Shelf' }, layouts: [{ type: 'shelf', positions: { count: 2, name: 'Bin 1' } }] });
  same(w, 'empty');
  const codes = ['01-01-0-10', '01-01-1-10', '01-02-0-10', '01-02-1-10', '01-03-0-10'];
  codes.forEach((code, i) => w.stockPallet(code, { sscc: sscc(i + 1), itemNo: 'BOX', qty: 10, receivedAt: i }));
  same(w, 'stocked');

  w.addOrder({ id: 'SO1', customer: 'A', lane: 'OUT-01', lines: [{ itemNo: 'BOX', units: 10 }] });
  same(w, 'order added');
  const wave = w.planWave({ orders: ['SO1'] });
  w.confirmWaveTask({ task: wave.tasks[0].id });
  w.stageShipment({ orderId: 'SO1' });
  w.scanShipment({ orderId: 'SO1', code: wave.tasks[0].sscc });
  w.dispatchShipment({ orderId: 'SO1' });
  assert.equal(w._liveOrders().some((o) => o.id === 'SO1'), false, 'a shipped order drops out');
  assert.equal(w._livePallets().some((p) => p.sscc === wave.tasks[0].sscc), false, 'a shipped pallet drops out');
  same(w, 'shipped');

  w.deleteStock({ sscc: sscc(4), reason: 'damage' });
  w.exportStock({ itemNo: 'BOX', qty: 10, toSite: 'NORTH' });
  w.stockPallet('01-02-1-10', { sscc: sscc(9), itemNo: 'BOX', qty: 10, receivedAt: 9 });
  w.addOrder({ id: 'SO2', customer: 'B', lane: 'OUT-01', lines: [{ itemNo: 'BOX', pallets: 1 }] });
  same(w, 'deleted, transferred, new pallet and order');

  const restored = Warehouse.restore(JSON.parse(JSON.stringify(w)), { clock: () => Date.UTC(2026, 10, 4, 9) });
  assert.equal(JSON.stringify(w).includes('"_live"'), false, 'the lists are never saved');
  same(restored, 'after a restart');
  assert.deepEqual(restored._livePallets().map((p) => p.sscc), w._livePallets().map((p) => p.sscc));
});
