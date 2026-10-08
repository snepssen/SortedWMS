const test = require('node:test');
const assert = require('node:assert/strict');
const { Walkthrough, steps } = require('../src/walkthrough');
const site = require('../server/site.example.json');

test('guided shift receives, replaces damage, processes, labels and traces a shipment', () => {
  const demo = new Walkthrough(site);
  for (let i = 0; i < steps.length; i++) {
    assert.equal(demo.index, i);
    demo.next();
    if (i === 9) assert.ok(Object.values(demo.wh.pallets).every((p) => demo.wh.locations[p.loc].category === 'PRO'));
    if (i === 10) assert.deepEqual(demo.wh.orders['DEMO-OUT'].lines[0].allocated, [demo.first]);
    if (i === 11) {
      assert.equal(demo.wh.pallets[demo.first].status, 'blocked');
      assert.deepEqual(demo.wh.orders['DEMO-OUT'].lines[0].allocated, [demo.second]);
    }
  }
  assert.equal(demo.wh.orders['DEMO-OUT'].status, 'shipped');
  assert.equal(demo.wh.pallets[demo.second].status, 'shipped');
  assert.equal(demo.wh.processLog[0].minutes, 5);
  assert.equal(demo.trace.shipped[0].customer, 'Fresh Market');
  assert.ok(demo.wh.printQueue.length >= 2);
  assert.equal(demo.step, null);
});

test('restarting a guided shift does not mutate the site or another shift', () => {
  const before = JSON.stringify(site);
  const a = new Walkthrough(site);
  a.next();
  a.next();
  const b = new Walkthrough(site);
  assert.equal(b.index, 0);
  assert.equal(Object.keys(b.wh.trucks).length, 0);
  assert.equal(JSON.stringify(site), before);
});

test('Auto-Shift brings down only next-out stock and relocates it after repartitioning', () => {
  const demo = new Walkthrough(site, 'shift');
  for (let i = 0; i < 3; i++) demo.next();
  const task = () => demo.wh.tasks[demo.wh.trucks[demo.truckId].taskId];
  assert.equal(task().type, 'SHIFT');
  assert.equal(task().reason, 'ground');
  assert.equal(task().sscc, demo.first);
  demo.next();
  demo.next();
  const oldLocation = demo.wh.pallets[demo.first].loc;
  assert.equal(demo.wh.locations[oldLocation].level, 0);
  demo.next();
  assert.equal(task().reason, 'template');
  assert.equal(demo.wh.locations[oldLocation].category, 'PRO');
  demo.next();
  demo.next();
  assert.equal(demo.wh.locations[oldLocation].sscc, null);
  assert.equal(demo.wh.locations[demo.wh.pallets[demo.first].loc].category, 'YOG');
  assert.equal(demo.wh.locations[demo.wh.pallets[demo.first].loc].level, 0);
  assert.equal(demo.wh.locations[demo.wh.pallets[demo.second].loc].level, 3);
  assert.equal(demo.step, null);
});

test('manual scenario isolates an order, puts away dock stock and reconciles displaced stock', () => {
  const demo = new Walkthrough(site, 'manual');
  while (demo.index < 4) demo.next();
  const active = demo.wh.tasks[demo.wh.trucks[demo.truckId].taskId];
  assert.equal(active.orderId, '4602');
  assert.equal(active.sscc, demo.second);
  while (demo.index < 8) demo.next();
  assert.equal(demo.wh.orders['4602'].status, 'ready');
  assert.notEqual(demo.wh.orders['4601'].status, 'ready');
  while (demo.index < 12) demo.next();
  assert.equal(demo.wh.locations[demo.wh.pallets[demo.third].loc].category, 'YOG');
  while (demo.index < 15) demo.next();
  assert.deepEqual(demo.wh.lostPallets().map((p) => p.sscc), [demo.fourth]);
  const pendingPick = Object.values(demo.wh.tasks).find((t) => t.orderId === '4601' && t.type === 'PICK');
  assert.equal(pendingPick.from, demo.wh.resolve('AA02A1'));
  assert.equal(demo.wh.pallets[demo.fourth].loc, null);
  while (demo.step) demo.next();
  assert.equal(demo.wh.lostPallets().length, 0);
  assert.equal(demo.wh.pallets[demo.fourth].loc, demo.wh.resolve('AA03A1'));
  assert.equal(demo.wh.transfers.length, 2);
  assert.ok(demo.wh.transfers.every((t) => t.by === demo.truckId));
});

test('stock count scenario: blind counts find a swap and correct it, with the scan codes the page shows', () => {
  const demo = new Walkthrough(site, 'counts');
  const seen = [];
  while (demo.step) {
    if (demo.step.role === 'scanner') seen.push(demo.scanCode);
    demo.next();
  }
  const R = (c) => demo.wh.resolve(c);
  assert.deepEqual(seen, [R('AA01A1'), demo.first, R('AA01A2'), demo.third, R('AA01A3'), demo.second]);
  assert.deepEqual(demo.wh.counts.map((c) => c.result).reverse(), ['ok', 'corrected', 'corrected']);
  assert.equal(demo.wh.lostPallets().length, 0);
  assert.equal(demo.wh.pallets[demo.third].loc, R('AA01A2'));
  assert.equal(demo.wh.pallets[demo.second].loc, R('AA01A3'));
  assert.ok(demo.journal.every((j) => j.by));
});

test('switching scenarios starts an independent warehouse and uses the correct scan commands', () => {
  const manual = new Walkthrough(site, 'manual');
  while (manual.index < 3) manual.next();
  assert.equal(manual.scanCode, 'O4602');
  const shift = new Walkthrough(site, 'shift');
  assert.equal(Object.keys(shift.wh.pallets).length, 0);
  assert.equal(shift.journal.length, 0);
  assert.equal(shift.steps.length, 8);
  assert.throws(() => new Walkthrough(site, 'unknown'), /Unknown scenario/);
});
