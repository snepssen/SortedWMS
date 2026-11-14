const test = require('node:test');
const assert = require('node:assert/strict');
const { Warehouse } = require('../src/engine');
const { COMMANDS } = require('../server/commands');

function warehouse({ kind = 'bin', stock = 5 } = {}) {
  const w = new Warehouse({
    aisles: [1], bays: 3, levels: 1, positions: [10], outLanes: 1,
    clock: () => Date.UTC(2026, 10, 13, 8),
  });
  w.setFeatures({ lotExpiry: false, fefo: false });
  w.addItem({ itemNo: 'PART', name: 'Workshop part', category: 'GEN', palletQty: 100, uom: 'piece' });
  w.setItemUnits('PART', { packs: [{ unit: 'box', per: 10 }] });
  w.createLocation({ code: 'FACE', kind, name: 'Pick face' });
  const source = w.stockPallet('01-01-0-10', { itemNo: 'PART', qty: 100 });
  if (stock && kind === 'bin') w.binPut({ loc: 'FACE', itemNo: 'PART', qty: stock });
  if (stock && kind === 'mezzanine') w.issueSeries({ series: 'ST', itemNo: 'PART', qty: stock, loc: 'FACE' });
  w.setPickFace({ code: 'FACE', itemNo: 'PART', min: 2, trigger: 2, max: 20, mode: 'units' });
  return { w, source };
}

function order(w, id = 'SO1', units = 8) {
  return w.addOrder({ id, customer: 'Workshop', lane: 'OUT-01', lines: [{ itemNo: 'PART', units }] });
}

function complete(w, task) {
  w.addTruck('R1');
  assert.equal(w.trucks.R1.taskId, task.id);
  w.scan('R1', task.sscc);
  w.scan('R1', task.to);
  assert.equal(task.status, 'done');
}

test('order entry replenishes before the face reaches its trigger and records the demand', () => {
  const { w } = warehouse();
  order(w);
  const [task] = w._liveTasks().filter((t) => t.reason === 'replenish');
  assert.ok(task);
  assert.equal(task.splitQty, 15, 'the physical face maximum still bounds the drop');
  assert.equal(task.planning.onHand, 5);
  assert.equal(task.planning.committed, 8);
  assert.deepEqual(task.planning.orders, [{ orderId: 'SO1', qty: 8 }]);
  assert.deepEqual(w.planReplenishment(), [], 'retries retain the existing transport');
  const before = JSON.stringify(w);
  w.replenishmentStatus();
  assert.equal(JSON.stringify(w), before, 'reading status does not mutate journalled state');
});

test('bin picks wait for the physical drop and reservations survive restore', () => {
  const { w } = warehouse();
  order(w);
  const wave = w.planWave({ orders: ['SO1'] });
  const waiting = wave.tasks.find((t) => t.replenishmentId);
  assert.ok(waiting);
  assert.equal(waiting.qty, 3);
  assert.throws(() => w.confirmWaveTask({ task: waiting.id, scan: 'FACE' }), /Waiting for/);
  assert.throws(() => w.claimWaveTask({ task: waiting.id, by: 'picker' }), /Waiting for/);
  assert.ok(!w.waveTasks({ readyOnly: true }).some((t) => t.id === waiting.id));
  const restored = Warehouse.restore(JSON.parse(JSON.stringify(w)), { clock: () => w.now() });
  assert.equal(restored.waveTaskReadiness(restored._waveTask(waiting.id).task).ready, false);
  const transport = w.tasks[waiting.replenishmentId];
  complete(w, transport);
  assert.equal(w.waveTaskReadiness(waiting).ready, true);
  assert.equal(w.binContents('FACE').lines[0].qty, 20);
  for (const task of wave.tasks) w.confirmWaveTask({ task: task.id, scan: 'FACE' });
  assert.equal(w.orders.SO1.lines[0].picked, 8);
  assert.equal(w.binContents('FACE').lines[0].qty, 12);
});

test('mezzanine replenishment plates become pickable through the normal wave confirmation', () => {
  const { w } = warehouse({ kind: 'mezzanine', stock: 0 });
  order(w);
  const wave = w.planWave({ orders: ['SO1'] });
  const waiting = wave.tasks.find((t) => t.replenishmentId);
  const transport = w.tasks[waiting.replenishmentId];
  complete(w, transport);
  assert.ok(transport.replenishedHolder);
  w.confirmWaveTask({ task: waiting.id, scan: 'FACE' });
  assert.equal(w.orders.SO1.lines[0].picked, 8);
  assert.equal(w.holders[transport.replenishedHolder].contents[0].qty, 12);
});

test('missing stock is explained and a normal tick retries after stock arrives', () => {
  const { w, source } = warehouse({ stock: 0 });
  w._remove(source);
  source.status = 'shipped';
  assert.equal(w.replenishmentStatus()[0].reason, 'no-source');
  w.planReplenishment();
  assert.equal(w.locations.FACE.replenishmentState.reason, 'no-source');
  w.stockPallet('01-02-0-10', { itemNo: 'PART', qty: 100 });
  COMMANDS.tick(w);
  assert.equal(w._liveTasks().filter((t) => t.reason === 'replenish').length, 1);
});

test('one planning pass never reserves the same source for two pick faces', () => {
  const { w } = warehouse({ stock: 0 });
  w.createLocation({ code: 'FACE2', kind: 'bin' });
  w.setPickFace({ code: 'FACE2', itemNo: 'PART', min: 2, max: 20 });
  const tasks = w.planReplenishment();
  assert.equal(tasks.length, 1);
  assert.equal(w.replenishmentStatus().find((r) => r.code === 'FACE2').reason, 'no-source');
});

test('a held destination rejects a drop before consuming or placing stock', () => {
  const { w, source } = warehouse({ stock: 0 });
  const [task] = w.planReplenishment();
  w.addTruck('R1');
  w.scan('R1', task.sscc);
  w.locations.FACE.blocked = true;
  const before = JSON.stringify(w);
  assert.throws(() => w.applySplitDrop(w.trucks.R1, task), /blocked or held/);
  assert.equal(JSON.stringify(w), before);
  assert.equal(source.qty, 100);
});

test('a cancelled transport releases waiting picks for automatic replanning', () => {
  const { w } = warehouse();
  order(w);
  const wave = w.planWave({ orders: ['SO1'] });
  const waiting = wave.tasks.find((t) => t.replenishmentId);
  w._cancelQuiet(w.tasks[waiting.replenishmentId]);
  COMMANDS.tick(w);
  assert.equal(waiting.status, 'cancelled');
  assert.ok(!w.waveTasks({ readyOnly: true }).some((t) => t.replenishmentId === waiting.replenishmentId));
});

test('batch holds are rechecked before a replenished plate is consumed', () => {
  const { w, source } = warehouse({ kind: 'mezzanine', stock: 0 });
  source.batch = 'LOT1';
  order(w);
  const wave = w.planWave({ orders: ['SO1'] });
  const waiting = wave.tasks.find((t) => t.replenishmentId);
  const transport = w.tasks[waiting.replenishmentId];
  complete(w, transport);
  w.placeBatchHold('PART', 'LOT1', 'Supplier hold', 'supervisor');
  assert.throws(() => w.confirmWaveTask({ task: waiting.id, scan: 'FACE' }), /held, expired or too short-dated/);
  assert.equal(w.orders.SO1.lines[0].picked, 0);
});

test('a whole source is consumed once when the unit top-up needs all its stock', () => {
  const { w, source } = warehouse({ stock: 0 });
  source.qty = 12;
  const [transport] = w.planReplenishment();
  complete(w, transport);
  assert.equal(source.qty, 0);
  assert.equal(source.status, 'shipped');
  assert.equal(w.trucks.R1.load, null);
  assert.equal(w.binContents('FACE').lines[0].qty, 12);
  assert.ok(!w._liveTasks().some((t) => t.reason === 'return-split'));
});

test('older snapshots replay order entry before a journalled planner activation', () => {
  const { Store } = require('../server/store');
  const site = require('../server/site.blank.json');
  const { w } = warehouse();
  delete w.replenishmentVersion;
  const store = new Store({ site, now: () => w.now() });
  try {
    store.wh = w;
    store.snapshot();
    const args = { id: 'SO1', customer: 'Workshop', lane: 'OUT-01', lines: [{ itemNo: 'PART', units: 8 }] };
    store.db.prepare('INSERT INTO journal (t, op, args, by) VALUES (?, ?, ?, ?)').run(w.now(), 'addOrder', JSON.stringify(args), 'office');
    store.load();
    assert.deepEqual(store.replayErrors, []);
    assert.equal(store.wh._liveTasks().filter((t) => t.reason === 'replenish').length, 0);
    store.exec('tick');
    assert.equal(store.wh.replenishmentVersion, 1);
    const tasks = JSON.stringify(store.wh.tasks);
    store.load();
    assert.deepEqual(store.replayErrors, []);
    assert.equal(JSON.stringify(store.wh.tasks), tasks);
  } finally {
    store.db.close();
  }
});


test('whole-box demand keeps its source ahead of speculative small-pick replenishment', () => {
  const { w } = warehouse({ stock: 0 });
  order(w, 'SO1', 18);
  assert.equal(w._liveTasks().filter((t) => t.reason === 'replenish').length, 0);
  const wave = w.planWave({ orders: ['SO1'] });
  assert.deepEqual(wave.tasks.map((t) => [t.kind, t.qty, t.box]), [
    ['case', 10, 'whole'], ['case', 8, 'new'],
  ]);
});

test('demand larger than the face capacity can progress through successive small-pick waves', () => {
  const { w } = warehouse({ stock: 0 });
  w.setItemUnits('PART', { packs: [] });
  order(w, 'SO1', 25);
  const wave = w.planWave({ orders: ['SO1'] });
  assert.equal(wave.tasks[0].qty, 20);
  assert.deepEqual(wave.short, [{ orderId: 'SO1', itemNo: 'PART', qty: 5 }]);
  complete(w, w.tasks[wave.tasks[0].replenishmentId]);
  w.confirmWaveTask({ task: wave.tasks[0].id, scan: 'FACE' });
  assert.equal(w.orders.SO1.lines[0].picked, 20);
  assert.equal(w.orders.SO1.status, 'picking');
  const returning = w.tasks[w.trucks.R1.taskId];
  assert.equal(returning.reason, 'return-split');
  w.scan('R1', returning.to);
  COMMANDS.tick(w);
  const next = w.activeWave();
  assert.ok(next);
  assert.equal(next.tasks[0].qty, 5);
  assert.ok(next.tasks[0].replenishmentId);
});

test('manual replenishment cannot take a source reserved by the automatic planner', () => {
  const { w } = warehouse({ stock: 0 });
  w.planReplenishment();
  w.createLocation({ code: 'OTHER', kind: 'bin' });
  assert.throws(() => w.replenish('PART', 'OTHER'), /No free stock/);
  assert.equal(w._liveTasks().filter((t) => t.reason === 'replenish').length, 1);
});
