const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Site = require('../server/site');
const { COMMANDS } = require('../server/commands');
const { seedDemo } = require('../server/seed');

const site = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'server', 'site.example.json'), 'utf8'));

function floor() {
  const t = Date.UTC(2026, 9, 9, 6);
  const wh = Site.buildWarehouse(site, () => t);
  const store = { wh, now: () => t, exec: (op, args, by) => COMMANDS[op](wh, args, by) };
  seedDemo(store);
  return { wh, store };
}

const groundJobs = (wh) => Object.values(wh.tasks).filter((t) => t.reason === 'ground' && ['open', 'active'].includes(t.status)).map((t) => t.sscc).sort();

test('an import takes unit lines (picked in waves) and a minimum of days left, beside whole-pallet lines', () => {
  const { wh } = floor();
  const out = COMMANDS.importOrders(wh, { planOnce: true, rows: [
    { orderId: 'IM1', customer: 'Corner shop', lane: 'OUT-01', itemNo: 'Y1001', units: '24', minDays: '3' },
    { orderId: 'IM1', customer: 'Corner shop', lane: 'OUT-01', itemNo: 'Y1002', units: 6 },
    { orderId: 'IM2', customer: 'Depot', lane: 'OUT-02', itemNo: 'Y1001', pallets: '' },
  ] });
  assert.deepEqual(out, { added: 2, errors: [] });
  assert.deepEqual(wh.orders.IM1.lines.map((l) => [l.itemNo, l.kind, l.units]), [['Y1001', 'each', 24], ['Y1002', 'each', 6]]);
  assert.equal(wh.orders.IM1.minDays, 3);
  assert.deepEqual(wh.orders.IM2.lines.map((l) => [l.itemNo, l.pallets, l.allocated.length]), [['Y1001', 1, 1]], 'a blank pallets column is one pallet');
});

test('planning once at the end of an import leaves the same ground jobs as planning after every order', () => {
  const rows = ['C2001', 'C2002', 'Y1001', 'Y1002', 'Y1003', 'C2001'].map((itemNo, i) => ({ orderId: `B${i}`, customer: 'Shop', lane: 'OUT-01', itemNo, pallets: 1 }));
  const each = floor();
  const once = floor();
  COMMANDS.importOrders(each.wh, { rows });
  COMMANDS.importOrders(once.wh, { rows, planOnce: true });
  assert.deepEqual(Object.values(once.wh.orders).map((o) => o.lines[0].allocated), Object.values(each.wh.orders).map((o) => o.lines[0].allocated), 'the same pallets go to the same orders');
  assert.deepEqual(groundJobs(once.wh), groundJobs(each.wh));
  assert.ok(groundJobs(once.wh).length > 0);
  assert.equal(once.wh._planLater, false, 'never left on after an import');
  assert.equal(JSON.stringify(once.wh).includes('_planLater'), false, 'and never saved');
});
