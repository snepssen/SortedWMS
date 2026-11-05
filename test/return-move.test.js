const test = require('node:test');
const assert = require('node:assert/strict');
const { Warehouse } = require('../src/engine');

function wh() {
  const w = new Warehouse({ aisles: [1], bays: 2, levels: 1, positions: [10], outLanes: 1, clock: () => Date.UTC(2026, 9, 8, 8) });
  w.setFeatures({ lotExpiry: true, fefo: true });
  w.addItem({ itemNo: 'SKU1', name: 'Mug', category: 'GEN', palletQty: 10 });
  w.createLocation({ code: 'MEZZ-A1', kind: 'mezzanine', name: 'Mezzanine' });
  w.addTruck('RT1', { position: '01-01-0-10' });
  return w;
}

test('a split replenishment leaves a return task on the machine operator, then the drop puts the remainder away', () => {
  const w = wh();
  assert.equal(w.module('return-move'), true);
  const source = w.stockPallet('01-01-0-10', { itemNo: 'SKU1', batch: 'B', expiry: '2027-01-01', qty: 20 });
  w.issueSeries({ series: 'ST', itemNo: 'SKU1', qty: 1, loc: 'MEZZ-A1' });
  w.setPickFace({ code: 'MEZZ-A1', itemNo: 'SKU1', min: 1, max: 5, trigger: 1, mode: 'units' });
  const task = w.planReplenishment()[0];
  assert.equal(task.splitQty, 4);
  const truck = w.trucks.RT1;
  w._remove(source);
  truck.load = source.sscc;
  truck.taskId = task.id;
  task.status = 'active';
  task.truckId = 'RT1';
  task.step = 1;
  const done = w.applySplitDrop(truck, task);
  assert.equal(source.qty, 16);
  assert.equal(source.loc, null, 'the remainder is still on the forks');
  assert.equal(done.holder.loc, 'MEZZ-A1');
  assert.equal(done.holder.contents[0].qty, 4);
  assert.equal(done.returnTask.reason, 'return-split');
  assert.equal(done.returnTask.status, 'active');
  assert.equal(done.returnTask.step, 1);
  assert.equal(done.returnTask.to, '01-01-0-10');
  assert.equal(truck.taskId, done.returnTask.id);
  assert.equal(truck.load, source.sscc);
  w.addTruck('RT2', { position: 'DOCK-IN' });
  w.dispatch();
  assert.equal(w.trucks.RT2.taskId, null, 'another truck does not take the plate that is already on the forks');
  assert.equal(truck.taskId, done.returnTask.id);
  const view = w.instruction('RT1');
  assert.equal(view.kind, 'drop');
  assert.equal(view.task.to, '01-01-0-10');
  assert.ok(w.events.some((e) => /Return/.test(e.text)));
  w.scan('RT1', '01-01-0-10');
  assert.equal(source.loc, '01-01-0-10');
  assert.equal(w.tasks[done.returnTask.id].status, 'done');
  assert.equal(truck.load, null);
});

test('with the module off the remainder is put back at the drop, as before', () => {
  const w = wh();
  w.setModules({ 'return-move': false });
  const source = w.stockPallet('01-01-0-10', { itemNo: 'SKU1', batch: 'B', expiry: '2027-01-01', qty: 20 });
  w.issueSeries({ series: 'ST', itemNo: 'SKU1', qty: 1, loc: 'MEZZ-A1' });
  w.setPickFace({ code: 'MEZZ-A1', itemNo: 'SKU1', min: 1, max: 5, trigger: 1, mode: 'units' });
  const task = w.planReplenishment()[0];
  w._remove(source);
  const truck = { id: 'RT1', load: source.sscc, stats: { jobs: 0, moves: 0, moveInputs: 0 } };
  const done = w.applySplitDrop(truck, task);
  assert.equal(done.returnTask, null);
  assert.equal(source.loc, '01-01-0-10');
  assert.equal(source.qty, 16);
});
