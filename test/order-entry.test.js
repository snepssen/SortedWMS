const test = require('node:test');
const assert = require('node:assert/strict');
const { Warehouse } = require('../src/engine');

test('a piece order does not plan ground jobs again when no pallet has moved', () => {
  const w = new Warehouse({ aisles: [1], bays: 4, levels: 3, positions: [10, 40], outLanes: 1, clock: () => Date.UTC(2026, 5, 1, 8) });
  w.addItem({ itemNo: 'Y1', name: 'Paint', category: 'GEN', palletQty: 10 });
  for (const loc of w._racks()) loc.category = 'GEN';
  const high = w._racks().find((l) => l.level > 0);
  w.stockPallet(high.code, { itemNo: 'Y1', qty: 10, receivedAt: 1 });
  let planned = 0;
  const orig = w._fefoContext.bind(w);
  w._fefoContext = () => { planned++; return orig(); };
  w.addOrder({ id: 'O1', customer: 'Shop', lane: 'OUT-01', lines: [{ itemNo: 'Y1', units: 2 }] });
  const jobs = Object.values(w.tasks).filter((t) => t.reason === 'ground').length;
  assert.ok(jobs >= 1, 'the first order still brings the next pallet down');
  const afterFirst = planned;
  w.addOrder({ id: 'O2', customer: 'Shop', lane: 'OUT-01', lines: [{ itemNo: 'Y1', units: 1 }] });
  w.addOrder({ id: 'O3', customer: 'Shop', lane: 'OUT-01', lines: [{ itemNo: 'Y1', units: 1 }] });
  assert.equal(planned, afterFirst, 'later piece orders do not walk the pallets again');
  assert.equal(Object.values(w.tasks).filter((t) => t.reason === 'ground').length, jobs);
  w.setPalletStatus(Object.values(w.pallets)[0].sscc, 'blocked', 'Damaged');
  w.addOrder({ id: 'O4', customer: 'Shop', lane: 'OUT-01', lines: [{ itemNo: 'Y1', units: 1 }] });
  assert.ok(planned > afterFirst, 'a blocked pallet makes the next order plan again');
});

test('adding an order costs the same with 3,000 open orders as with 6,000', () => {
  const w = new Warehouse({ aisles: [1, 2], bays: 6, levels: 2, positions: [10], outLanes: 1, clock: () => Date.UTC(2026, 5, 2, 8) });
  for (let i = 1; i <= 40; i++) w.addItem({ itemNo: `I${i}`, name: `Item ${i}`, category: 'GEN', palletQty: 10 });
  const slot = w._racks().find((l) => l.level === 0);
  slot.category = 'GEN';
  w.stockPallet(slot.code, { itemNo: 'I1', qty: 10, receivedAt: 1 });
  const add = (n) => {
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < n; i++) {
      w._seq.order = (w._seq.order || 0) + 1;
      w.addOrder({ id: `O${w._seq.order}`, customer: 'Shop', lane: 'OUT-01', lines: [{ itemNo: 'I1', units: 1 }] });
    }
    return Number(process.hrtime.bigint() - t0) / 1e6 / n;
  };
  add(200);
  const at3000 = (() => { add(2800); return add(50); })();
  add(2950);
  const at6000 = add(50);
  assert.ok(at6000 < at3000 * 1.5, `6000 open orders ${at6000.toFixed(3)} ms, 3000 was ${at3000.toFixed(3)} ms`);
});

// One item in one aisle, two racks high. The pallet up high is the next to ship.
function groundSite(clock) {
  const w = new Warehouse({ aisles: [1], bays: 4, levels: 3, positions: [10, 40], outLanes: 1, clock, config: { groundNextPerItem: 1 } });
  w.setFeatures({ lotExpiry: true, fefo: true, temperatureZones: true });
  w.addItem({ itemNo: 'Y1', name: 'Paint', category: 'GEN', palletQty: 10, minShipDays: 10 });
  for (const loc of w._racks()) loc.category = 'GEN';
  return w;
}
const groundJobs = (w) => Object.values(w.tasks).filter((t) => t.reason === 'ground' && t.status !== 'cancelled').map((t) => t.sscc).sort();
const high = (w, n = 0) => w._racks().filter((l) => l.level > 0)[n].code;

test('releasing a pallet to ship brings it down, even when no pallet moved since the last plan', () => {
  const clock = () => Date.UTC(2026, 5, 1, 8);
  const short = groundSite(clock);
  const p = short.stockPallet(high(short), { itemNo: 'Y1', qty: 10, expiry: '2026-06-05', receivedAt: 1 });
  short.planGround();
  assert.deepEqual(groundJobs(short), [], 'too short-dated to ship');
  short.allowShortShip(p.sscc);
  assert.deepEqual(groundJobs(short), [p.sscc]);

  const held = groundSite(clock);
  const q = held.stockPallet(high(held), { itemNo: 'Y1', qty: 10, expiry: '2027-01-01', receivedAt: 1 });
  held.recordTemperature(q.sscc, 12, 2, 8, 'Too warm');
  held.planGround();
  assert.deepEqual(groundJobs(held), []);
  held.releaseQualityHold(q.sscc, 'Checked, fine');
  assert.deepEqual(groundJobs(held), [q.sscc]);
});

test('a piece order plans again after a bring-down job was cancelled, and on a new day', () => {
  let t = Date.UTC(2026, 5, 1, 8);
  const w = groundSite(() => t);
  const p = w.stockPallet(high(w), { itemNo: 'Y1', qty: 10, expiry: '2027-01-01', receivedAt: 1 });
  w.addOrder({ id: 'O1', customer: 'Shop', lane: 'OUT-01', lines: [{ itemNo: 'Y1', units: 1 }] });
  const job = Object.values(w.tasks).find((x) => x.reason === 'ground');
  w.cancelTask(job.id);
  w.addOrder({ id: 'O2', customer: 'Shop', lane: 'OUT-01', lines: [{ itemNo: 'Y1', units: 1 }] });
  assert.deepEqual(groundJobs(w), [p.sscc], 'the cancelled job is planned again');

  // The pallet down below runs out of days overnight; the next order should bring the other one down.
  const w2 = groundSite(() => t);
  const soon = w2.stockPallet(high(w2, 0), { itemNo: 'Y1', qty: 10, expiry: '2026-06-12', receivedAt: 1 });
  const later = w2.stockPallet(high(w2, 1), { itemNo: 'Y1', qty: 10, expiry: '2027-01-01', receivedAt: 2 });
  w2.addOrder({ id: 'O1', customer: 'Shop', lane: 'OUT-01', lines: [{ itemNo: 'Y1', units: 1 }] });
  assert.deepEqual(groundJobs(w2), [soon.sscc]);
  t = Date.UTC(2026, 5, 3, 8); // 9 days left, under the 10 to ship
  w2.addOrder({ id: 'O2', customer: 'Shop', lane: 'OUT-01', lines: [{ itemNo: 'Y1', units: 1 }] });
  assert.ok(groundJobs(w2).includes(later.sscc), 'a new day is a reason to plan again');
});

test('a warehouse reloaded from its saved state plans the same ground jobs as the live one', () => {
  let t = Date.UTC(2026, 5, 1, 8);
  const clock = () => t;
  const w = groundSite(clock);
  const a = w.stockPallet(high(w, 0), { itemNo: 'Y1', qty: 10, expiry: '2026-06-05', receivedAt: 1 });
  const b = w.stockPallet(high(w, 1), { itemNo: 'Y1', qty: 10, expiry: '2027-01-01', receivedAt: 2 });
  let n = 0;
  const order = () => ({ id: `O${++n}`, customer: 'Shop', lane: 'OUT-01', lines: [{ itemNo: 'Y1', units: 1 }] });
  const steps = [
    () => w.addOrder(order()),
    () => w.recordTemperature(b.sscc, 12, 2, 8, 'Too warm'),
    () => w.addOrder(order()),
    () => w.allowShortShip(a.sscc),
    () => w.addOrder(order()),
    () => { const j = Object.values(w.tasks).find((x) => x.reason === 'ground' && x.status === 'open'); if (j) w.cancelTask(j.id); },
    () => w.addOrder(order()),
    () => w.releaseQualityHold(b.sscc, 'Checked, fine'),
    () => w.addOrder(order()),
    () => { t += 86400000; },
    () => w.addOrder(order()),
  ];
  for (const [i, step] of steps.entries()) {
    step();
    // The same piece order on the live warehouse and on a copy loaded from what it saved.
    const copy = Warehouse.restore(JSON.parse(JSON.stringify(w)), { clock });
    const probe = () => ({ id: `C${i}`, customer: 'Shop', lane: 'OUT-01', lines: [{ itemNo: 'Y1', units: 1 }] });
    copy.addOrder(probe());
    w.addOrder(probe());
    assert.deepEqual(groundJobs(copy), groundJobs(w), `after step ${i + 1}`);
  }
});
