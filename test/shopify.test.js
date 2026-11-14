const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHmac } = require('node:crypto');
const { Store } = require('../server/store');
const { createShopify, verifyWebhook, withBackoff } = require('../server/shopify');
const registry = require('../modules/registry');

const site = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'server', 'site.blank.json'), 'utf8'));
const TOKEN = 'shpat_example_not_a_real_token';
const SECRET = 'webhook-secret-example';

const order = {
  id: 1001,
  financial_status: 'paid',
  fulfillment_status: null,
  cancelled_at: null,
  email: 'ada@example.com',
  shipping_address: { name: 'Ada Lovelace' },
  line_items: [{ sku: 'MUG', quantity: 2, barcode: '' }, { sku: 'OTHER', quantity: 1, barcode: '4006381333931' }], // OTHER matches MUG by barcode text
};

function world(transport) {
  const store = new Store({ site });
  store.exec('setModules', { shopify: true, connections: true }, 'admin');
  store.exec('addItem', { itemNo: 'MUG', name: 'Mug', category: 'GEN', palletQty: 1, codes: ['4006381333931'] }, 'office');
  store.exec('addItem', { itemNo: 'BOWL', name: 'Bowl', category: 'GEN', palletQty: 1 }, 'office');
  store.exec('createLocation', { code: 'BIN-1', kind: 'bin', name: 'Bin' }, 'office');
  store.exec('binPut', { loc: 'BIN-1', itemNo: 'MUG', qty: 10 }, 'office');
  const calls = [];
  const shopify = createShopify({
    store,
    secretsFile: null,
    transport: transport || (async (req) => {
      calls.push(req);
      const url = req.url;
      if (url.includes('/orders.json')) return { status: 200, headers: {}, body: Buffer.from(JSON.stringify({ orders: [order] })) };
      if (url.includes('/products.json')) return { status: 200, headers: {}, body: Buffer.from(JSON.stringify({ products: [
        { title: 'Mug', variants: [{ id: 5, sku: 'MUG', barcode: '4006381333931', inventory_item_id: 9 }] },
        { title: 'Other', variants: [{ id: 6, sku: 'OTHER', barcode: '4006381333931', inventory_item_id: 10 }] },
      ] })) };
      return { status: 200, headers: {}, body: Buffer.from('{}') };
    }),
    sleep: async () => {},
    log() {},
  });
  shopify.saveShop({ id: 'demo', name: 'Example', shop: 'example.myshopify.com', locationId: '77', buffer: 2, token: TOKEN, webhookSecret: SECRET });
  return { store, shopify, calls };
}

test('a Shopify webhook signature must match, and the same order is imported once', async () => {
  const raw = JSON.stringify(order);
  const good = createHmac('sha256', SECRET).update(raw).digest('base64');
  assert.equal(verifyWebhook(raw, good, SECRET), true);
  assert.equal(verifyWebhook(raw, 'nope', SECRET), false);
  const { store, shopify } = world();
  const seen = [];
  const alertsMod = registry.get('alerts');
  const previousRaise = alertsMod.raise;
  alertsMod.raise = (s, event) => { seen.push(event); };
  try {
    store.wh.setModules({ alerts: true, shopify: true, connections: true });
    assert.throws(() => shopify.acceptWebhook('demo', raw, 'nope'), /signature/i);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].type, 'shop.sync');
    assert.equal(JSON.stringify(seen[0]).includes(SECRET), false);
    await shopify.pullProducts('demo');
    const first = shopify.acceptWebhook('demo', raw, good);
    const second = shopify.acceptWebhook('demo', raw, good);
    assert.equal(first.status, 'created');
    assert.equal(second.status, 'duplicate');
    assert.equal(second.id, first.id);
    const view = shopify.status();
    assert.equal(view.shops[0].tokenSet, true);
    assert.equal(JSON.stringify(view).includes(TOKEN), false);
    const maps = shopify.mappings('demo');
    assert.equal(maps.find((m) => m.sku === 'MUG').itemNo, 'MUG');
    assert.equal(maps.find((m) => m.sku === 'OTHER').itemNo, 'MUG');
  } finally { alertsMod.raise = previousRaise; store.close(); }
});

test('stock pushes the available quantity minus the buffer, once per burst, and backs off when told', async () => {
  const waits = [];
  let inventory = 0;
  let limited = 0;
  const { store, shopify } = world(async (req) => {
    if (String(req.url).includes('inventory_levels')) {
      limited++;
      if (limited < 3) return { status: 429, headers: { 'retry-after': '0' }, body: Buffer.from('') };
      inventory++;
      return { status: 200, headers: {}, body: Buffer.from('{}') };
    }
    if (String(req.url).includes('/products.json')) {
      return { status: 200, headers: {}, body: Buffer.from(JSON.stringify({ products: [
        { title: 'Mug', variants: [{ id: 5, sku: 'MUG', barcode: '4006381333931', inventory_item_id: 9 }] },
      ] })) };
    }
    return { status: 200, headers: {}, body: Buffer.from(JSON.stringify({ orders: [], products: [] })) };
  });
  let queued = null;
  shopify._setSchedule((fn) => { queued = fn; return { unref() {} }; });
  let n = 0;
  const back = await withBackoff(async () => {
    n++;
    return n < 3 ? { status: 429, headers: {} } : { status: 200, headers: {}, body: '' };
  }, { sleep: async (ms) => waits.push(ms), baseMs: 10, max: 4 });
  assert.equal(back.status, 200);
  assert.deepEqual(waits.filter((v) => v !== 'try'), [10, 20]);
  await shopify.pullProducts('demo');
  shopify.queueStock('MUG');
  shopify.queueStock('MUG');
  assert.equal(inventory, 0);
  await queued();
  assert.equal(inventory, 1);
  const pushed = store.db.prepare('SELECT qty FROM shopify_stock WHERE item_no = ?').get('MUG');
  assert.equal(pushed.qty, 8);
  store.close();
});
