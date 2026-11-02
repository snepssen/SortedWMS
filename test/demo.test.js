const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Site = require('../server/site');
const { COMMANDS } = require('../server/commands');
const Demo = require('../src/demo');
const Labels = require('../src/labels');

function shift({ hours, you = new Set() }) {
  let t = Demo.morning(Date.UTC(2026, 10, 2, 9));
  const wh = Site.buildWarehouse(Demo.SITE, () => t);
  const rows = [];
  const exec = (op, args, by) => {
    rows.push({ t, op, args: JSON.parse(JSON.stringify(args)), by });
    return COMMANDS[op](wh, args, by);
  };
  Demo.seed((op, args) => exec(op, args, 'demo'), t, () => wh);
  let a = 3;
  const runner = new Demo.Runner({ rand: () => { a = (a * 16807) % 2147483647; return a / 2147483647; } });
  const done = [];
  for (let s = 0; s < hours * 720; s++) {
    t += 5000;
    if (s % 12 === 0) exec('tick', {}, 'system');
    done.push(...runner.step(wh, t, exec, you));
  }
  return { wh, rows, done, start: rows[0].t };
}

test('demo: a shift worked by the bots ships orders, takes in deliveries, and every step is one the system asked for', () => {
  const { wh, rows, done, start } = shift({ hours: 8 });
  assert.deepEqual(done.filter((d) => d.error), [], 'no bot step was refused');
  const orders = Object.values(wh.orders);
  assert.ok(orders.filter((o) => o.status === 'shipped').length >= 40, 'orders go all the way out');
  assert.ok(orders.some((o) => o.lines.some((l) => l.pallets)) && orders.some((o) => o.lines.some((l) => l.kind === 'each')), 'whole-pallet and piece orders');
  const by = new Set(done.map((d) => d.bot));
  for (const id of ['office', 'R1', 'R2', 'R3', 'MU1', 'P1', 'packer', 'loader', 'DESK1', 'S1', 'returns']) assert.ok(by.has(id), `${id} worked`);
  const deliveries = Object.values(wh.deliveries);
  assert.ok(deliveries.length >= 3 && deliveries.filter((d) => d.status === 'received').length >= deliveries.length - 1, 'deliveries are booked and received');
  // Short picks at a bin are counted, corrected and closed by stock control.
  const checks = Object.values(wh.checks || {});
  assert.ok(checks.length >= 1, 'short picks raise checks');
  assert.ok(checks.some((c) => c.outcome === 'corrected'), 'a short bin is corrected');
  assert.ok((wh.adjustments || []).some((a) => a.reason === 'recount' && a.after < a.before), 'the count takes the missing pieces off the books');
  // Bins are refilled from rack pallets; the desk receives a delivery without a list; returns are graded.
  assert.ok(done.some((d) => d.op === 'binRefill'));
  assert.ok(deliveries.some((d) => d.at === 'desk' && d.status === 'received'), 'the receiving desk took a delivery in');
  const rmas = Object.values(wh.returns || {});
  assert.ok(rmas.length >= 2 && rmas.some((r) => r.status === 'done'), 'returns are booked and graded');
  assert.ok(Object.values(wh.serials || {}).some((s) => s.status === 'shipped' || s.orderId), 'traced drills ship with their serial numbers');

  // The journal is the warehouse: replaying it gives the same state.
  let rt = start;
  const again = Site.buildWarehouse(Demo.SITE, () => rt);
  for (const r of rows) { rt = r.t; COMMANDS[r.op](again, r.args, r.by); }
  assert.equal(JSON.stringify(again.orders), JSON.stringify(wh.orders));
  assert.equal(JSON.stringify(again.pallets), JSON.stringify(wh.pallets));
  assert.ok(JSON.stringify(rows).length < 400000, 'an 8-hour shift fits easily in browser storage');
});

test('demo: a role a person has taken over is left alone', () => {
  const { done } = shift({ hours: 2, you: new Set(['R1', 'packer']) });
  assert.equal(done.some((d) => d.bot === 'R1' || d.bot === 'packer'), false);
  assert.ok(done.some((d) => d.bot === 'R2'));
});

test('demo: made-up numbers only, on the GS1 documentation prefix', () => {
  const { wh } = shift({ hours: 2 });
  for (const it of Object.values(wh.items)) assert.match(it.gtin, /^0614141/, it.itemNo);
  for (const sscc of Object.keys(wh.pallets)) assert.match(sscc, /^[0-9]0614141/, sscc);
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'demo.js'), 'utf8');
  assert.doesNotMatch(src, /8712345|8799998|8799997/);
});

test('an item without a best-before is received without one, and its labels leave the date out', () => {
  const t = Date.UTC(2026, 10, 2, 8);
  const wh = Site.buildWarehouse(Demo.SITE, () => t);
  wh.addItem({ itemNo: 'BOLT', name: 'Bolt M8', category: 'GEN', palletQty: 500, bestBefore: false });
  wh.addItem({ itemNo: 'GLUE', name: 'Glue', category: 'GEN', palletQty: 100 });
  assert.equal(wh.items.BOLT.bestBefore, false);
  assert.equal('bestBefore' in wh.items.GLUE, false, 'nothing stored for the usual case');
  wh.addTruck('T1', { categories: ['GEN'] });
  const sscc = require('../src/gs1').makeSscc(0, '0614141', 999999);
  wh.addDelivery({ id: 'D1', supplier: 'S', category: 'GEN', pallets: 1, list: [{ sscc, itemNo: 'BOLT', qty: 500, batch: 'B1' }] });
  const r = wh.scan('T1', `00${sscc}`);
  assert.equal(r.ok, true, r.text);
  assert.equal(wh.pallets[sscc].expiry, null);
  assert.equal(wh.deliveries.D1.status, 'received');
  const zpl = Labels.shippingLabel({ customer: 'C', orderId: '1', index: 1, total: 1, itemName: 'Bolt', itemNo: 'BOLT', qty: 500, batch: 'B1', expiry: null, labelCode: 'X', sscc, lane: 'OUT-01', printedAt: '' });
  assert.match(zpl, /\^FDBatch B1\^FS/);
  assert.doesNotMatch(zpl, /Best before/);
  wh.updateItem('BOLT', { bestBefore: true });
  assert.equal('bestBefore' in wh.items.BOLT, false);
});

test('the Pages build has the demo: its own journal and clock, the demo warehouse, and the hub page', () => {
  const build = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'build-pages.js'), 'utf8');
  const hub = fs.readFileSync(path.join(__dirname, '..', 'pages', 'demo.html'), 'utf8');
  assert.match(build, /sortedwms\.demo\.v1/);
  assert.match(build, /src\/demo\.js/);
  assert.match(hub, /<!-- WMS -->/);
  assert.match(hub, /data-take/);
  assert.match(hub, /Do this step/);
});

test('a bin is refilled from a rack pallet, with the pallet\'s batch and best-before', () => {
  const t = Date.UTC(2026, 10, 2, 8);
  const wh = Site.buildWarehouse(Demo.SITE, () => t);
  wh.addItem({ itemNo: 'GLUE', name: 'Glue', category: 'SMALL', palletQty: 48 });
  wh.addItem({ itemNo: 'DRILL', name: 'Drill', category: 'SMALL', palletQty: 4, bestBefore: false });
  wh.setItemSerials('DRILL', true);
  wh.generateGuided({ sections: { count: 1, name: 'Pick' }, layouts: [{ type: 'shelf', aisles: { count: 1 }, bays: { count: 1, name: 'Shelf 1' }, positions: { count: 2, name: 'Bin 1' }, levels: { count: 1 } }] });
  const bins = Object.values(wh.locations).filter((l) => l.kind === 'bin').map((l) => l.code).sort();
  const GS1 = require('../src/gs1');
  const a = GS1.makeSscc(0, '0614141', 501);
  const b = GS1.makeSscc(0, '0614141', 502);
  wh.stockPallet(wh.resolve('AC01A1'), { sscc: a, itemNo: 'GLUE', qty: 48, batch: 'G7', expiry: '2027-06-01' });
  wh.stockPallet(wh.resolve('AC01A2'), { sscc: b, itemNo: 'DRILL', qty: 4, batch: 'D1' });
  const r = wh.binRefill({ loc: bins[0], sscc: a, qty: 12, by: 'S1' });
  assert.equal(r.left, 36);
  assert.deepEqual(wh.binStock[bins[0]].map((l) => [l.itemNo, l.qty, l.batch, l.expiry]), [['GLUE', 12, 'G7', '2027-06-01']]);
  assert.throws(() => wh.binRefill({ loc: bins[0], sscc: a, qty: 99 }), /has only 36/);
  assert.throws(() => wh.binRefill({ loc: bins[1], sscc: b, qty: 1 }), /traced by serial number/);
  wh.raiseCheck({ loc: 'AC01A1', note: 'looks short' });
  assert.throws(() => wh.binRefill({ loc: bins[0], sscc: a, qty: 12 }), /held for stock check/);
  wh.closeCheck({ id: Object.keys(wh.checks)[0] });
  wh.binRefill({ loc: bins[0], sscc: a, qty: 36 });
  assert.equal(wh.pallets[a].status, 'shipped', 'an emptied pallet is gone');
  assert.ok(!wh.locations[wh.resolve('AC01A1')].sscc, 'and its slot is free');
});
