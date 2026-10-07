const test = require('node:test');
const assert = require('node:assert/strict');
const { Warehouse } = require('../engine');

const MIN = 60000;

function setup(opts = {}) {
  let t = 0;
  const wh = new Warehouse({ aisles: 6, bays: 10, levels: 3, clock: () => t, ...opts });
  const advance = (mins) => {
    t += mins * MIN;
    wh.dispatch();
  };
  return { wh, advance };
}

// Do both scans of the truck's current job.
function complete(wh, truckId) {
  const task = wh.tasks[wh.trucks[truckId].taskId];
  assert.ok(wh.scan(truckId, task.from).ok);
  assert.ok(wh.scan(truckId, task.to).ok);
  return task;
}

test('Auto hands out jobs in the admin priority order', () => {
  const { wh } = setup();
  wh.addPallet('01-001-1', { sku: 'A', qty: 40 });
  wh.addPallet('01-002-1', { sku: 'B', qty: 40 });
  wh.addTask({ type: 'PICK', from: '01-001-1', to: 'DOCK-OUT' });
  wh.addTask({ type: 'REPLEN', from: '01-002-1', to: '01-002-0' });
  wh.addTruck('RT1');
  assert.equal(wh.tasks[wh.trucks.RT1.taskId].type, 'REPLEN');
});

test('changing the priority order changes what the next truck gets', () => {
  const { wh } = setup();
  wh.setConfig({ priority: ['PICK', 'REPLEN', 'PUTAWAY', 'SHIFT'] });
  wh.addPallet('01-001-1', { sku: 'A', qty: 40 });
  wh.addPallet('01-002-1', { sku: 'B', qty: 40 });
  wh.addTask({ type: 'REPLEN', from: '01-002-1', to: '01-002-0' });
  wh.addTask({ type: 'PICK', from: '01-001-1', to: 'DOCK-OUT' });
  wh.addTruck('RT1');
  assert.equal(wh.tasks[wh.trucks.RT1.taskId].type, 'PICK');
});

test('a switched-off job type is never dispatched', () => {
  const { wh } = setup();
  wh.setConfig({ enabled: { PUTAWAY: false } });
  wh.addTask({ type: 'PUTAWAY', from: 'DOCK-IN', sku: 'A', qty: 10 });
  wh.addTruck('RT1');
  assert.equal(wh.trucks.RT1.taskId, null);
  wh.setConfig({ enabled: { PUTAWAY: true } });
  assert.ok(wh.trucks.RT1.taskId);
});

test('urgent jobs jump the queue, and old jobs escalate on their own', () => {
  const { wh, advance } = setup();
  wh.setConfig({ escalateAfterMin: 20 });
  wh.addPallet('02-001-1', { sku: 'S', qty: 1 });
  wh.addPallet('01-001-1', { sku: 'A', qty: 40 });
  const shift = wh.addTask({ type: 'SHIFT', from: '02-001-1' });
  advance(25);
  wh.addTask({ type: 'REPLEN', from: '01-001-1', to: '01-001-0' });
  wh.addTruck('RT1');
  assert.equal(wh.trucks.RT1.taskId, shift.id, 'the 25-minute-old shift beats a fresh replen');
  assert.match(shift.reason, /Waited 25 min/);
});

test('no more than two trucks are sent into one aisle', () => {
  const { wh } = setup();
  for (let b = 1; b <= 3; b++) {
    wh.addPallet(`03-00${b}-1`, { sku: 'A', qty: 1 });
    wh.addTask({ type: 'PICK', from: `03-00${b}-1`, to: 'DOCK-OUT' });
  }
  wh.addPallet('05-001-1', { sku: 'B', qty: 1 });
  wh.addTask({ type: 'PUTAWAY', from: 'DOCK-IN', sku: 'C', qty: 1 }); // lower priority, other aisle
  ['RT1', 'RT2', 'RT3'].forEach((id) => wh.addTruck(id));

  assert.deepEqual(wh.aisleOccupancy()['03'].sort(), ['RT1', 'RT2']);
  assert.equal(wh.tasks[wh.trucks.RT3.taskId].type, 'PUTAWAY', 'third truck goes elsewhere');

  // RT1 leaves aisle 03 for the dock, so the third pick can now be dispatched.
  complete(wh, 'RT1');
  assert.equal(wh.aisleOccupancy()['03'].length, 2);
});

test('the aisle limit is configurable', () => {
  const { wh } = setup();
  wh.setConfig({ aisleCap: 1 });
  for (let b = 1; b <= 2; b++) {
    wh.addPallet(`03-00${b}-1`, { sku: 'A', qty: 1 });
    wh.addTask({ type: 'PICK', from: `03-00${b}-1`, to: 'DOCK-OUT' });
  }
  wh.addTruck('RT1');
  wh.addTruck('RT2');
  assert.equal(wh.trucks.RT2.taskId, null);
});

test('a truck carrying a pallet into a full aisle waits at the entry, then gets let in', () => {
  const { wh } = setup();
  wh.addPallet('04-001-1', { sku: 'A', qty: 1 });
  wh.addPallet('04-002-1', { sku: 'B', qty: 1 });
  wh.addTask({ type: 'PICK', from: '04-001-1', to: 'DOCK-OUT' });
  wh.addTask({ type: 'PICK', from: '04-002-1', to: 'DOCK-OUT' });
  wh.addTruck('RT1');
  wh.addTruck('RT2');

  wh.addPallet('01-001-1', { sku: 'C', qty: 1 });
  const replen = wh.addTask({ type: 'REPLEN', from: '01-001-1', to: '04-005-0' });
  wh.addTruck('RT3');
  assert.equal(wh.trucks.RT3.taskId, replen.id);

  wh.scan('RT3', '01-001-1');
  assert.equal(wh.trucks.RT3.waiting, true);
  assert.equal(wh.instruction('RT3').kind, 'wait');
  assert.equal(wh.scan('RT3', '04-005-0').ok, false, 'cannot drop while the aisle is full');

  wh.scan('RT1', '04-001-1');
  wh.scan('RT1', 'DOCK-OUT');
  assert.equal(wh.trucks.RT3.waiting, false);
  assert.ok(wh.scan('RT3', '04-005-0').ok);
});

test('every job is exactly two scans, and the next job arrives without any input', () => {
  const { wh } = setup();
  wh.addPallet('01-001-1', { sku: 'A', qty: 1 });
  wh.addPallet('01-003-1', { sku: 'B', qty: 1 });
  wh.addTask({ type: 'PICK', from: '01-001-1', to: 'DOCK-OUT' });
  wh.addTask({ type: 'PICK', from: '01-003-1', to: 'DOCK-OUT' });
  wh.addTruck('RT1');
  complete(wh, 'RT1');
  assert.ok(wh.trucks.RT1.taskId, 'second job assigned straight away');
  complete(wh, 'RT1');
  assert.deepEqual(wh.trucks.RT1.stats, { jobs: 2, scans: 4, wrongScans: 0 });
});

test('a wrong scan changes nothing', () => {
  const { wh } = setup();
  wh.addPallet('01-001-1', { sku: 'A', qty: 1 });
  wh.addTask({ type: 'PICK', from: '01-001-1', to: 'DOCK-OUT' });
  wh.addTruck('RT1');
  const r = wh.scan('RT1', '01-002-1');
  assert.equal(r.ok, false);
  assert.match(r.text, /Go to 01-001-1/);
  assert.equal(wh.tasks[wh.trucks.RT1.taskId].step, 0);
  assert.ok(wh.scan('RT1', '01-001-1').ok);
});

test('Auto-Shift: idle driver scans a pallet, system picks the nearest free slot', () => {
  const { wh } = setup();
  wh.addPallet('02-005-1', { sku: 'A', qty: 12 });
  wh.addPallet('02-005-2', { sku: 'X', qty: 1 }); // occupied neighbour
  wh.addTruck('RT1');

  const r = wh.scan('RT1', '02-005-1');
  assert.ok(r.ok, r.text);
  const task = wh.tasks[wh.trucks.RT1.taskId];
  assert.equal(task.type, 'SHIFT');
  assert.equal(task.step, 1, 'the pick-up scan already counted');
  assert.match(task.to, /^02-00[46]-1$/, 'same aisle, next bay, lowest level');

  assert.ok(wh.scan('RT1', task.to).ok);
  assert.equal(wh.locations[task.to].pallet.sku, 'A');
  assert.equal(wh.locations['02-005-1'].pallet, null);
});

test('Auto-Shift slots are reserved so two trucks never get the same one', () => {
  const { wh } = setup({ aisles: 1, bays: 2, levels: 2 });
  wh.addPallet('01-001-1', { sku: 'A', qty: 1 });
  wh.addTask({ type: 'SHIFT', from: '01-001-1' });
  wh.addTask({ type: 'PUTAWAY', from: 'DOCK-IN', sku: 'B', qty: 1 });
  wh.addTruck('RT1');
  wh.addTruck('RT2');
  // Only one free reserve slot (01-002-1): one job gets it, the other waits in the queue.
  const assigned = Object.values(wh.tasks).filter((t) => t.status === 'active');
  assert.equal(assigned.length, 1);
  assert.equal(assigned[0].to, '01-002-1');
});

test('driver may drop an Auto-Shift pallet in a different free slot', () => {
  const { wh } = setup();
  wh.addPallet('02-005-1', { sku: 'A', qty: 1 });
  wh.addTruck('RT1');
  wh.scan('RT1', '02-005-1');
  const task = wh.tasks[wh.trucks.RT1.taskId];
  assert.ok(wh.scan('RT1', '02-009-2').ok);
  assert.equal(task.to, '02-009-2');
  assert.equal(wh.locations['02-009-2'].pallet.sku, 'A');

  wh.setConfig({ allowSlotOverride: false });
  wh.addPallet('03-005-1', { sku: 'B', qty: 1 });
  wh.scan('RT1', '03-005-1');
  assert.equal(wh.scan('RT1', '03-009-2').ok, false);
});

test('a switched-off job type cannot be started by scanning its pallet either', () => {
  const { wh } = setup();
  wh.addPallet('05-001-1', { sku: 'A', qty: 1 });
  wh.setConfig({ enabled: { PICK: false } });
  const pick = wh.addTask({ type: 'PICK', from: '05-001-1', to: 'DOCK-OUT' });
  wh.addTruck('RT1');
  const r = wh.scan('RT1', '05-001-1');
  assert.equal(r.ok, false);
  assert.match(r.text, /switched off/);
  assert.equal(pick.status, 'open');
});

test('Auto-Shift-only trucks get only shift jobs', () => {
  const { wh } = setup();
  wh.addPallet('01-001-1', { sku: 'A', qty: 1 });
  wh.addPallet('01-002-1', { sku: 'B', qty: 1 });
  wh.addTask({ type: 'REPLEN', from: '01-001-1', to: '01-001-0' });
  const shift = wh.addTask({ type: 'SHIFT', from: '01-002-1' });
  wh.addTruck('RT1', { mode: 'shift' });
  assert.equal(wh.trucks.RT1.taskId, shift.id);
});

test('reporting a blocked location holds the job and moves the driver on', () => {
  const { wh } = setup();
  wh.addPallet('01-001-1', { sku: 'A', qty: 1 });
  wh.addPallet('01-002-1', { sku: 'B', qty: 1 });
  const first = wh.addTask({ type: 'REPLEN', from: '01-001-1', to: '01-001-0' });
  const second = wh.addTask({ type: 'PICK', from: '01-002-1', to: 'DOCK-OUT' });
  wh.addTruck('RT1');
  wh.reportProblem('RT1', 'blocked');
  assert.equal(first.status, 'held');
  assert.equal(wh.locations['01-001-1'].blocked, true);
  assert.equal(wh.trucks.RT1.taskId, second.id);

  wh.releaseTask(first.id);
  assert.equal(first.status, 'open');
  assert.equal(wh.locations['01-001-1'].blocked, false);
});

test('a blocked Auto-Shift slot is swapped for another without the driver doing anything', () => {
  const { wh } = setup();
  wh.addPallet('02-005-1', { sku: 'A', qty: 1 });
  wh.addTruck('RT1');
  wh.scan('RT1', '02-005-1');
  const task = wh.tasks[wh.trucks.RT1.taskId];
  const firstSlot = task.to;
  wh.reportProblem('RT1', 'blocked');
  assert.notEqual(task.to, firstSlot);
  assert.ok(wh.scan('RT1', task.to).ok);
});

test('a driver cannot pause with a pallet on the forks', () => {
  const { wh } = setup();
  wh.addPallet('01-001-1', { sku: 'A', qty: 1 });
  wh.addTask({ type: 'PICK', from: '01-001-1', to: 'DOCK-OUT' });
  wh.addTruck('RT1');
  wh.scan('RT1', '01-001-1');
  assert.throws(() => wh.setTruckMode('RT1', 'paused'), /carrying a pallet/);
  wh.scan('RT1', 'DOCK-OUT');
  wh.setTruckMode('RT1', 'paused');
  assert.equal(wh.trucks.RT1.mode, 'paused');
});

test('pausing before pick-up puts the job back in the queue for someone else', () => {
  const { wh } = setup();
  wh.addPallet('01-001-1', { sku: 'A', qty: 1 });
  const task = wh.addTask({ type: 'PICK', from: '01-001-1', to: 'DOCK-OUT' });
  wh.addTruck('RT1');
  wh.addTruck('RT2');
  wh.setTruckMode('RT1', 'paused');
  assert.equal(task.truckId, 'RT2');
});

test('within the same priority the nearest job wins, if travel optimisation is on', () => {
  const { wh } = setup();
  wh.addPallet('06-001-1', { sku: 'A', qty: 1 });
  wh.addPallet('01-001-1', { sku: 'B', qty: 1 });
  const far = wh.addTask({ type: 'PICK', from: '06-001-1', to: 'DOCK-OUT' });
  const near = wh.addTask({ type: 'PICK', from: '01-001-1', to: 'DOCK-OUT' });
  wh.addTruck('RT1', { mode: 'paused', position: '01-005-1' });
  wh.setTruckMode('RT1', 'auto');
  assert.equal(wh.trucks.RT1.taskId, near.id);

  wh.setTruckMode('RT1', 'paused');
  wh.setConfig({ travelOptimise: false });
  wh.setTruckMode('RT1', 'auto');
  assert.equal(wh.trucks.RT1.taskId, far.id, 'oldest first when off');
});

test('cancelling a job before pick-up frees the truck', () => {
  const { wh } = setup();
  wh.addPallet('01-001-1', { sku: 'A', qty: 1 });
  const task = wh.addTask({ type: 'PICK', from: '01-001-1', to: 'DOCK-OUT' });
  wh.addTruck('RT1');
  wh.cancelTask(task.id);
  assert.equal(task.status, 'cancelled');
  assert.equal(wh.trucks.RT1.taskId, null);
});
