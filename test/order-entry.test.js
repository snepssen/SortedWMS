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
