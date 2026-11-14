const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHmac } = require('node:crypto');
const { Store } = require('../server/store');
const { createWoo, verifyWebhook, withBackoff } = require('../server/woocommerce');
const registry = require('../modules/registry');

const site = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'server', 'site.blank.json'), 'utf8'));
const KEY = 'ck_example_not_a_real_key';
const SECRET = 'cs_example_not_a_real_secret';
const HOOK = 'webhook-secret-example';

const order = {
  id: 1001,
  status: 'processing',
  billing: { first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com' },
  line_items: [
    { sku: 'MUG', quantity: 2 },
    { sku: 'OTHER', quantity: 1, meta_data: [{ key: 'barcode', value: '4006381333931' }] },
  ],
};

const products = [
  { id: 5, name: 'Mug', sku: 'MUG', type: 'simple', global_unique_id: '4006381333931' },
  { id: 6, name: 'Other', sku: 'OTHER', type: 'simple', global_unique_id: '4006381333931' },
];

function world(transport) {
  const store = new Store({ site });
  store.exec('setModules', { woocommerce: true, connections: true }, 'admin');
  store.exec('addItem', { itemNo: 'MUG', name: 'Mug', category: 'GEN', palletQty: 1, codes: ['4006381333931'] }, 'office');
  store.exec('addItem', { itemNo: 'BOWL', name: 'Bowl', category: 'GEN', palletQty: 1 }, 'office');
  store.exec('createLocation', { code: 'BIN-1', kind: 'bin', name: 'Bin' }, 'office');
  store.exec('binPut', { loc: 'BIN-1', itemNo: 'MUG', qty: 10 }, 'office');
  const woo = createWoo({
    store,
    secretsFile: null,
    transport: transport || (async (req) => {
      const url = String(req.url);
      if (url.includes('/orders')) return { status: 200, headers: {}, body: Buffer.from(JSON.stringify([order])) };
      if (url.includes('/products')) return { status: 200, headers: {}, body: Buffer.from(JSON.stringify(products)) };
      return { status: 200, headers: {}, body: Buffer.from('{}') };
    }),
    sleep: async () => {},
    log() {},
  });
  woo.saveShop({
    id: 'demo', name: 'Example', shop: 'https://shop.example.com', buffer: 2,
    consumerKey: KEY, consumerSecret: SECRET, webhookSecret: HOOK,
  });
  return { store, woo };
}

test('a WooCommerce webhook signature must match, and the same order is imported once', async () => {
  const raw = JSON.stringify(order);
  const good = createHmac('sha256', HOOK).update(raw).digest('base64');
  assert.equal(verifyWebhook(raw, good, HOOK), true);
  assert.equal(verifyWebhook(raw, 'nope', HOOK), false);
  const { store, woo } = world();
  const seen = [];
  const alertsMod = registry.get('alerts');
  const previousRaise = alertsMod.raise;
  alertsMod.raise = (s, event) => { seen.push(event); };
  try {
    store.wh.setModules({ alerts: true, woocommerce: true, connections: true });
    assert.throws(() => woo.acceptWebhook('demo', raw, 'nope'), /signature/i);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].type, 'shop.sync');
    assert.equal(JSON.stringify(seen[0]).includes(SECRET), false);
    await woo.pullProducts('demo');
    const first = woo.acceptWebhook('demo', raw, good);
    const second = woo.acceptWebhook('demo', raw, good);
    assert.equal(first.status, 'created');
    assert.equal(second.status, 'duplicate');
    assert.equal(second.id, first.id);
    const view = woo.status();
    assert.equal(view.shops[0].keySet, true);
    assert.equal(view.shops[0].secretSet, true);
    assert.equal(JSON.stringify(view).includes(KEY), false);
    assert.equal(JSON.stringify(view).includes(SECRET), false);
    const maps = woo.mappings('demo');
    assert.equal(maps.find((m) => m.sku === 'MUG').itemNo, 'MUG');
    assert.equal(maps.find((m) => m.sku === 'OTHER').itemNo, 'MUG');
  } finally {
    alertsMod.raise = previousRaise;
    store.close();
  }
});

test('stock pushes the available quantity minus the buffer, once per burst, and backs off when told', async () => {
  const waits = [];
  let inventory = 0;
  let limited = 0;
  const { store, woo } = world(async (req) => {
    const url = String(req.url);
    if (req.method === 'PUT' && url.includes('/products/')) {
      limited++;
      if (limited < 3) return { status: 429, headers: { 'retry-after': '0' }, body: Buffer.from('') };
      inventory++;
      return { status: 200, headers: {}, body: Buffer.from('{}') };
    }
    if (url.includes('/products')) {
      return { status: 200, headers: {}, body: Buffer.from(JSON.stringify([
        { id: 5, name: 'Mug', sku: 'MUG', type: 'simple', global_unique_id: '4006381333931' },
      ])) };
    }
    return { status: 200, headers: {}, body: Buffer.from('[]') };
  });
  let queued = null;
  woo._setSchedule((fn) => { queued = fn; return { unref() {} }; });
  let n = 0;
  const back = await withBackoff(async () => {
    n++;
    return n < 3 ? { status: 429, headers: {} } : { status: 200, headers: {}, body: '' };
  }, { sleep: async (ms) => waits.push(ms), baseMs: 10, max: 4 });
  assert.equal(back.status, 200);
  assert.deepEqual(waits, [10, 20]);
  await woo.pullProducts('demo');
  woo.queueStock('MUG');
  woo.queueStock('MUG');
  assert.equal(inventory, 0);
  await queued();
  assert.equal(inventory, 1);
  const pushed = store.db.prepare('SELECT qty FROM woo_stock WHERE item_no = ?').get('MUG');
  assert.equal(pushed.qty, 8);
  store.close();
});
