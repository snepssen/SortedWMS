const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Store } = require('../server/store');
const { Printers } = require('../server/print');
const { createApi } = require('../server/api');
const { seedDemo } = require('./fixtures/seed');

const site = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'site.json'), 'utf8'));

function setup() {
  let t = Date.UTC(2026, 9, 8, 6);
  const store = new Store({ site, now: () => (t += 7000) });
  seedDemo(store);
  const api = createApi({ store, printers: new Printers({}) });
  const call = async (method, url, body) => {
    const r = await api.handle(method, url, body, 'office');
    return r;
  };
  return { store, call };
}

test('a dry run names the rows an import would refuse and leaves the warehouse alone', async () => {
  const { store, call } = setup();
  const before = JSON.stringify(store.wh);
  const journal = store.journal().length;
  const items = await call('POST', '/api/import/items?dry=1', {
    dryRun: true,
    rows: [
      { itemNo: 'NEW-1', name: 'New tin', category: 'GEN', palletQty: 12 },
      { itemNo: 'W1001', name: 'Already there', category: 'GEN', palletQty: 1 },
      { name: 'No number', category: 'GEN', palletQty: 1 },
    ],
  });
  assert.equal(items.status, 200);
  assert.equal(items.body.dryRun, true);
  assert.equal(items.body.accepted, 1);
  assert.equal(items.body.refused, 2);
  assert.match(items.body.errors.join('\n'), /W1001: already exists/);
  assert.match(items.body.errors.join('\n'), /without an item number/);
  assert.equal(store.wh.items['NEW-1'], undefined);
  assert.equal(JSON.stringify(store.wh), before);
  assert.equal(store.journal().length, journal);

  const orders = await call('POST', '/api/import/orders', {
    dryRun: true,
    rows: [
      { orderId: 'DRY-1', customer: 'Shop', lane: 'OUT-01', itemNo: 'W1001', pallets: 1 },
      { orderId: 'DRY-2', customer: 'Shop', lane: 'NOT-A-LANE', itemNo: 'W1001', pallets: 1 },
    ],
  });
  assert.equal(orders.body.dryRun, true);
  assert.equal(orders.body.accepted, 1);
  assert.equal(orders.body.refused, 1);
  assert.match(orders.body.errors[0], /DRY-2/);
  assert.equal(store.wh.orders['DRY-1'], undefined);
  assert.equal(JSON.stringify(store.wh), before);

  const live = await call('POST', '/api/import/orders', {
    rows: [{ orderId: 'DRY-1', customer: 'Shop', lane: 'OUT-01', itemNo: 'W1001', pallets: 1 }],
  });
  assert.equal(live.body.added, 1);
  assert.ok(store.wh.orders['DRY-1']);
  store.close();
});

test('the cut-over page names the dry run, the four imports, and a backup', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'docs', 'CUTOVER.md'), 'utf8');
  for (const bit of ['dryRun', '/api/import/items', '/api/import/locations', '/api/import/stock', '/api/import/orders', './start.sh backup']) {
    assert.ok(text.includes(bit), bit);
  }
});
