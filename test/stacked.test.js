const test = require('node:test');
const assert = require('node:assert/strict');
const GS1 = require('../src/gs1');
const { Warehouse } = require('../src/engine');

const T0 = Date.UTC(2026, 10, 10, 6, 0);

// Two items in different categories, so two pallets from one stack go to different aisles.
function setup(config = {}, { heights = [1000, 1100] } = {}) {
  const t = T0;
  const wh = new Warehouse({ aisles: 4, bays: 6, levels: 3, positions: 3, outLanes: 2, clock: () => t, config: { groundNextPerItem: 0, ...config } });
  wh.addItem({ itemNo: 'Y1', gtin: GS1.makeGtin13('20000', 1), name: 'Wall paint', category: 'GEN', palletQty: 96, heightMm: heights[0] });
  wh.addItem({ itemNo: 'C1', gtin: GS1.makeGtin13('20000', 3), name: 'Potting soil', category: 'BULK', palletQty: 80, heightMm: heights[1] });
  wh.setLocationCategory({ aisle: 1 }, 'GEN');
  wh.setLocationCategory({ aisle: 2 }, 'GEN');
  wh.setLocationCategory({ aisle: 3 }, 'BULK');
  wh.setLocationCategory({ aisle: 4 }, 'BULK');
  const bottom = wh.stockPallet('DOCK-IN', { itemNo: 'Y1', batch: 'B1', expiry: '2027-06-01', qty: 96 });
  const top = wh.stockPallet('DOCK-IN', { itemNo: 'C1', batch: 'S1', expiry: '2027-06-01', qty: 80 });
  wh.addTruck('R1');
  wh.addTruck('R2');
  return { wh, bottom: bottom.sscc, top: top.sscc };
}

const jobOf = (wh, sscc) => Object.values(wh.tasks).find((t) => t.sscc === sscc && (t.status === 'active' || t.status === 'open'));

function liftBoth(wh, a, b) {
  const r1 = wh.scan('R1', a);
  assert.ok(r1.ok, r1.text);
  const r2 = wh.scan('R1', b);
  assert.ok(r2.ok, r2.text);
  return r2;
}

test('stacked pickup is off by default: the second scan only asks', () => {
  const { wh, bottom, top } = setup();
  assert.ok(wh.scan('R1', bottom).ok);
  const r = wh.scan('R1', top);
  assert.match(r.text, /You're carrying/);
  assert.equal(wh.pallets[top].loc, 'DOCK-IN');
  assert.equal(wh.instruction('R1').stack, undefined);
});

test('two stacked pallets go up in one transfer and drop at their own locations, in any order', () => {
  const { wh, bottom, top } = setup({ stackMaxMm: 2600 });
  const r = liftBoth(wh, bottom, top);
  assert.match(r.text, /Stacked: 2 on the forks/);
  const a = jobOf(wh, bottom);
  const b = jobOf(wh, top);
  assert.equal(b.truckId, 'R1');
  assert.equal(b.step, 1);
  assert.equal(wh.pallets[top].loc, null, 'lifted off the dock');
  assert.notEqual(wh._aisle(a.to), wh._aisle(b.to));
  const ins = wh.instruction('R1');
  assert.deepEqual(ins.stack.map((s) => s.sscc), [bottom, top]);

  // The top one's drop first: whichever pallet goes there is dropped.
  const d1 = wh.scan('R1', b.to);
  assert.ok(d1.ok, d1.text);
  assert.match(d1.text, /1 still on the forks. Next drop: …\d{6} to /);
  assert.equal(wh.pallets[top].loc, b.to);
  assert.equal(wh.trucks.R1.taskId, a.id);
  assert.equal(wh.trucks.R1.load, bottom);

  const d2 = wh.scan('R1', a.to);
  assert.ok(d2.ok, d2.text);
  assert.equal(wh.pallets[bottom].loc, a.to);
  assert.equal(wh.trucks.R1.load, null);
  assert.equal(wh.tasks[a.id].status, 'done');
  assert.equal(wh.tasks[b.id].status, 'done');
});

test('scanning a carried pallet makes it the next drop', () => {
  const { wh, bottom, top } = setup({ stackMaxMm: 2600 });
  liftBoth(wh, bottom, top);
  const r = wh.scan('R1', top);
  assert.match(r.text, /Next drop: …/);
  assert.equal(wh.trucks.R1.load, top);
  assert.deepEqual(wh.trucks.R1.carried, [jobOf(wh, bottom).id]);
});

test('the stack must stay under the height limit, and every item needs a height', () => {
  // 144 + 1000 + 144 + 1100 = 2388 mm
  const { wh, bottom, top } = setup({ stackMaxMm: 2300 });
  assert.ok(wh.scan('R1', bottom).ok);
  const r = wh.scan('R1', top);
  assert.equal(r.ok, false);
  assert.match(r.text, /2388 mm, over the 2300 mm limit/);
  assert.equal(wh.pallets[top].loc, 'DOCK-IN');
  assert.equal(jobOf(wh, top), undefined, 'the put-away made for it is gone again');

  const s = setup({ stackMaxMm: 3000 }, { heights: [1000, null] });
  assert.ok(s.wh.scan('R1', s.bottom).ok);
  const r2 = s.wh.scan('R1', s.top);
  assert.equal(r2.ok, false);
  assert.match(r2.text, /C1 has no height/);
});

test('a pallet set down from a stack is taken over by the next truck that scans it, and the first truck is told', () => {
  const { wh, bottom, top } = setup({ stackMaxMm: 2600 });
  liftBoth(wh, bottom, top);
  const job = jobOf(wh, top);

  const r = wh.scan('R2', top);
  assert.ok(r.ok, r.text);
  assert.match(r.text, /Taken over from R1/);
  assert.equal(job.truckId, 'R2');
  assert.equal(wh.trucks.R2.load, top);
  assert.equal(wh.trucks.R1.load, bottom);
  assert.deepEqual(wh.trucks.R1.carried, []);
  assert.match(wh.trucks.R1.message.text, /…\d{6} taken over by R2/);
  assert.equal(wh.instruction('R1').stack, undefined);

  assert.ok(wh.scan('R2', job.to).ok);
  assert.equal(wh.pallets[top].loc, job.to);
  assert.ok(wh.scan('R1', jobOf(wh, bottom).to).ok);
});

test('taking over the pallet that was the first truck\'s next drop moves it on to the rest of its stack', () => {
  const { wh, bottom, top } = setup({ stackMaxMm: 2600 });
  liftBoth(wh, bottom, top);
  assert.ok(wh.scan('R2', bottom).ok);
  assert.equal(wh.trucks.R1.load, top);
  assert.equal(wh.trucks.R1.taskId, jobOf(wh, top).id);
  assert.match(wh.trucks.R1.message.text, /taken over by R2. Next drop: …/);
});

test('a single pallet on the forks is still not anyone else\'s to take', () => {
  const { wh, bottom } = setup({ stackMaxMm: 2600 });
  assert.ok(wh.scan('R1', bottom).ok);
  const r = wh.scan('R2', bottom);
  assert.equal(r.ok, false);
  assert.match(r.text, /That's job #\d+ on R1/);
});

test('a carrying truck can take a set-down pallet onto its own stack', () => {
  const { wh, bottom, top } = setup({ stackMaxMm: 2600 });
  liftBoth(wh, bottom, top);
  const third = wh.stockPallet('DOCK-IN', { itemNo: 'Y1', batch: 'B2', expiry: '2027-07-01', qty: 96 });
  assert.ok(wh.scan('R2', third.sscc).ok);
  const r = wh.scan('R2', top);
  assert.ok(r.ok, r.text);
  assert.match(r.text, /Taken over: 2 on the forks/);
  assert.equal(jobOf(wh, top).truckId, 'R2');
  assert.match(wh.trucks.R1.message.text, /taken over by R2/);
});
