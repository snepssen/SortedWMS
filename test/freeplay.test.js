const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Site = require('../server/site');
const { COMMANDS } = require('../server/commands');
const { seedDemo } = require('../server/seed');
const Workload = require('../src/workload');
const Drivers = require('../src/drivers');

const site = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'server', 'site.example.json'), 'utf8'));

function floor() {
  let t = Date.UTC(2026, 9, 9, 6);
  const wh = Site.buildWarehouse(site, () => t);
  const rows = [];
  const store = { wh, now: () => t, exec: (op, args, by) => { rows.push({ t, op, args: JSON.parse(JSON.stringify(args)), by }); return COMMANDS[op](wh, args, by); } };
  seedDemo(store);
  return { wh, store, rows, clock: { get: () => t, add: (ms) => { t += ms; } } };
}

test('workload: picks only from stock free to ship, deliveries only into rack space, all random but repeatable', () => {
  const { wh } = floor();
  const a = Workload.plan(wh, { seed: 7, picks: 150, inbound: 120 });
  const b = Workload.plan(wh, { seed: 7, picks: 150, inbound: 120 });
  const c = Workload.plan(wh, { seed: 8, picks: 150, inbound: 120 });
  assert.deepEqual(a, b, 'same seed, same state: same work');
  assert.notDeepEqual(a.orders, c.orders, 'another seed: other work');
  assert.equal(a.picks, 150);
  assert.equal(a.orders.reduce((n, o) => n + o.lines.reduce((m, l) => m + l.pallets, 0), 0), 150);
  assert.equal(a.inbound, 120);
  assert.equal(a.deliveries.reduce((n, d) => n + d.list.length, 0), 120);
  const lanes = new Set(a.orders.map((o) => o.lane));
  assert.ok(lanes.size > 1, 'orders spread over the shipping lanes');
  for (const d of a.deliveries) {
    assert.ok(d.list.every((p) => wh.items[p.itemNo].category === d.category && !wh.pallets[p.sscc]));
    assert.ok(d.list.length >= 1 && d.list.length <= 26);
  }
  // More than the stock that can ship: the rest is left out and said so.
  const big = Workload.plan(wh, { seed: 7, picks: 1000 });
  assert.ok(big.short > 0 && big.picks + big.short === 1000);
});

test('workload: one journaled command drops it all in, and replay gives the same orders and deliveries', () => {
  const { wh, store, rows } = floor();
  const r = store.exec('dropWorkload', { seed: 99, picks: 60, inbound: 40 }, 'office');
  assert.equal(r.picks, 60);
  assert.equal(r.inbound, 40);
  assert.match(r.text, /orders, 60 pallets to pick.*deliveries, 40 pallets to receive/);
  const picks = Object.values(wh.tasks).filter((t) => t.type === 'PICK' && t.status !== 'cancelled').length;
  assert.ok(picks >= 60);
  let rt = rows[0].t;
  const again = Site.buildWarehouse(site, () => rt);
  for (const row of rows) { rt = row.t; COMMANDS[row.op](again, row.args, row.by); }
  assert.equal(JSON.stringify(again.orders), JSON.stringify(wh.orders));
  assert.equal(JSON.stringify(again.deliveries), JSON.stringify(wh.deliveries));
  assert.throws(() => COMMANDS.dropWorkload(wh, { picks: 5 }), /seed is required/);
});

test('drivers: a rush shift worked by simulated drivers ends with every order shipped and every delivery in', () => {
  const { wh, store, clock } = floor();
  // HH07 works every category, so the seed's protein-drink delivery gets received too.
  for (const [id, categories] of [['HH05', ['YOG']], ['HH06', ['CHE']], ['HH07', null]]) store.exec('addTruck', { id, categories }, 'office');
  store.exec('dropWorkload', { seed: 5, picks: 40, inbound: 40 }, 'office');
  let a = 11;
  const rand = () => { a = (a * 16807) % 2147483647; return a / 2147483647; };
  const eta = {};
  let refused = 0;
  for (let step = 0; step < 12 * 3600; step++) {
    clock.add(1000);
    if (step % 60 === 0) COMMANDS.tick(wh);
    for (const id of Object.keys(wh.trucks)) {
      const act = Drivers.next(wh, id, rand);
      if (!act) { delete eta[id]; continue; }
      const key = `${wh.trucks[id].taskId}:${act.what}`;
      if (!eta[id] || eta[id].key !== key) { eta[id] = { key, act, at: clock.get() + act.ms }; continue; }
      if (clock.get() < eta[id].at) continue;
      const r = eta[id].act.qty ? store.exec('confirmQty', { id, qty: null }, id) : store.exec('scan', { id, code: eta[id].act.code }, id);
      if (r && r.ok === false && !r.difference) refused++;
      delete eta[id];
    }
    for (const o of Object.values(wh.orders)) if (o.status === 'ready') store.exec('shipOrder', { id: o.id }, 'office');
    const busy = Object.values(wh.tasks).some((t) => (t.status === 'open' || t.status === 'active') && !(t.type === 'PUTAWAY' && wh.items[wh.pallets[t.sscc].itemNo].category === 'PRO'));
    if (!busy) break;
  }
  assert.equal(refused, 0, 'every simulated scan is one the system asked for');
  assert.deepEqual([...new Set(Object.values(wh.orders).map((o) => o.status))], ['shipped']);
  assert.ok(Object.values(wh.deliveries).every((d) => d.status !== 'open'), 'every delivery received, including the one without a pallet list');
  const left = Object.values(wh.tasks).filter((t) => t.status === 'open' || t.status === 'active');
  assert.ok(left.every((t) => t.type === 'PUTAWAY' && wh.items[wh.pallets[t.sscc].itemNo].category === 'PRO'), 'only protein drinks wait: that category has no rack space yet');
});

test('drivers: a time for every step, nothing for an idle or paused truck', () => {
  const { wh, store } = floor();
  store.exec('addTruck', { id: 'HH09', categories: ['CHE'] }, 'office');
  const act = Drivers.next(wh, 'HH09', () => 0.5);
  assert.ok(act && act.ms > 0 && act.code && act.what);
  store.exec('setTruckMode', { id: 'HH09', mode: 'paused' }, 'office');
  assert.equal(Drivers.next(wh, 'HH09'), null);
});
