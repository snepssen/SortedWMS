const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash, createHmac } = require('node:crypto');
const { Store } = require('../server/store');
const { createEtsy, verifyWebhook, withBackoff } = require('../server/etsy');
const registry = require('../modules/registry');

const site = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'server', 'site.blank.json'), 'utf8'));
const KEY = 'etsy_keystring_example';
const SHARED = 'etsy_shared_secret_example';
const HOOK = 'webhook-secret-example';
const TOKEN = 'at_example_not_a_real_token';

const receipt = {
  receipt_id: 1001,
  was_paid: true,
  was_shipped: false,
  name: 'Ada Lovelace',
  transactions: [
    { sku: 'MUG', quantity: 2, listing_id: 5, product_id: 9 },
    { sku: 'OTHER', quantity: 1, listing_id: 6, product_id: 10, barcode: '4006381333931' },
  ],
};

const listings = {
  results: [
    { listing_id: 5, title: 'Mug', inventory: { products: [{ product_id: 9, sku: 'MUG' }] } },
    { listing_id: 6, title: 'Other', inventory: { products: [{ product_id: 10, sku: 'OTHER', barcode: '4006381333931' }] } },
  ],
};

function world(transport) {
  const store = new Store({ site });
  store.exec('setModules', { etsy: true, connections: true }, 'admin');
  store.exec('addItem', { itemNo: 'MUG', name: 'Mug', category: 'GEN', palletQty: 1, codes: ['4006381333931'] }, 'office');
  store.exec('addItem', { itemNo: 'BOWL', name: 'Bowl', category: 'GEN', palletQty: 1 }, 'office');
  store.exec('createLocation', { code: 'BIN-1', kind: 'bin', name: 'Bin' }, 'office');
  store.exec('binPut', { loc: 'BIN-1', itemNo: 'MUG', qty: 10 }, 'office');
  const etsy = createEtsy({
    store,
    secretsFile: null,
    transport: transport || (async (req) => {
      const url = String(req.url);
      if (url.includes('/receipts')) return { status: 200, headers: {}, body: Buffer.from(JSON.stringify({ results: [receipt] })) };
      if (url.includes('/listings')) return { status: 200, headers: {}, body: Buffer.from(JSON.stringify(listings)) };
      return { status: 200, headers: {}, body: Buffer.from('{}') };
    }),
    sleep: async () => {},
    log() {},
  });
  etsy.saveShop({
    id: 'demo', name: 'Example', etsyShopId: '555', buffer: 2,
    redirectUri: 'https://wms.example.com/api/etsy/callback',
    keystring: KEY, sharedSecret: SHARED, webhookSecret: HOOK,
  });
  return { store, etsy };
}

test('PKCE comes back to the WMS, and a signed receipt is imported once', async () => {
  const raw = JSON.stringify(receipt);
  const good = createHmac('sha256', HOOK).update(raw).digest('hex');
  assert.equal(verifyWebhook(raw, good, HOOK), true);
  assert.equal(verifyWebhook(raw, 'nope', HOOK), false);
  const seen = { challenge: '' };
  const alerts = [];
  const alertsMod = registry.get('alerts');
  const previousRaise = alertsMod.raise;
  alertsMod.raise = (s, event) => { alerts.push(event); };
  let connected;
  const { store, etsy } = world(async (req) => {
    const target = String(req.url);
    if (target.includes('/oauth/token')) {
      const params = new URLSearchParams(req.body.toString());
      seen.challenge = createHash('sha256').update(params.get('code_verifier')).digest('base64url');
      return { status: 200, headers: {}, body: Buffer.from(JSON.stringify({ access_token: TOKEN, refresh_token: 'rt_example_not_real', expires_in: 3600 })) };
    }
    if (target.includes('/listings')) return { status: 200, headers: {}, body: Buffer.from(JSON.stringify(listings)) };
    if (target.includes('/receipts')) return { status: 200, headers: {}, body: Buffer.from(JSON.stringify({ results: [receipt] })) };
    return { status: 200, headers: {}, body: Buffer.from('{}') };
  });
  store.wh.setModules({ alerts: true, etsy: true, connections: true });
  assert.throws(() => etsy.acceptWebhook('demo', raw, 'nope'), /signature/i);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].type, 'shop.sync');
  assert.equal(JSON.stringify(alerts[0]).includes(SHARED), false);
  const started = etsy.beginConnect('demo');
  const auth = new URL(started.url);
  assert.equal(auth.origin + auth.pathname, 'https://www.etsy.com/oauth/connect');
  assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(auth.searchParams.get('redirect_uri'), 'https://wms.example.com/api/etsy/callback');
  connected = await etsy.finishConnect({ code: 'code-example', state: auth.searchParams.get('state') });
  assert.equal(connected.connected, true);
  assert.equal(seen.challenge, auth.searchParams.get('code_challenge'));
  const view = etsy.status();
  assert.equal(view.shops[0].connected, true);
  assert.equal(JSON.stringify(view).includes(TOKEN), false);
  assert.equal(JSON.stringify(view).includes(KEY), false);
  assert.equal(JSON.stringify(view).includes(SHARED), false);
  await etsy.pullProducts('demo');
  const first = etsy.acceptWebhook('demo', raw, good);
  const second = etsy.acceptWebhook('demo', raw, good);
  assert.equal(first.status, 'created');
  assert.equal(second.status, 'duplicate');
  const maps = etsy.mappings('demo');
  assert.equal(maps.find((m) => m.sku === 'MUG').itemNo, 'MUG');
  assert.equal(maps.find((m) => m.sku === 'OTHER').itemNo, 'MUG');
  alertsMod.raise = previousRaise;
  store.close();
});

test('stock pushes the available quantity minus the buffer, once per burst, and backs off when told', async () => {
  const waits = [];
  let inventory = 0;
  let limited = 0;
  const { store, etsy } = world(async (req) => {
    const url = String(req.url);
    if (req.method === 'PUT' && url.includes('/inventory')) {
      limited++;
      if (limited < 3) return { status: 429, headers: { 'retry-after': '0' }, body: Buffer.from('') };
      inventory++;
      return { status: 200, headers: {}, body: Buffer.from('{}') };
    }
    if (url.includes('/oauth/token')) {
      return { status: 200, headers: {}, body: Buffer.from(JSON.stringify({ access_token: TOKEN, refresh_token: 'rt_example', expires_in: 3600 })) };
    }
    if (url.includes('/listings')) {
      return { status: 200, headers: {}, body: Buffer.from(JSON.stringify({
        results: [{ listing_id: 5, title: 'Mug', inventory: { products: [{ product_id: 9, sku: 'MUG' }] } }],
      })) };
    }
    return { status: 200, headers: {}, body: Buffer.from('{}') };
  });
  let queued = null;
  etsy._setSchedule((fn) => { queued = fn; return { unref() {} }; });
  let n = 0;
  const back = await withBackoff(async () => {
    n++;
    return n < 3 ? { status: 429, headers: {} } : { status: 200, headers: {}, body: '' };
  }, { sleep: async (ms) => waits.push(ms), baseMs: 10, max: 4 });
  assert.equal(back.status, 200);
  assert.deepEqual(waits, [10, 20]);
  const started = etsy.beginConnect('demo');
  await etsy.finishConnect({ code: 'code-example', state: new URL(started.url).searchParams.get('state') });
  await etsy.pullProducts('demo');
  etsy.queueStock('MUG');
  etsy.queueStock('MUG');
  assert.equal(inventory, 0);
  await queued();
  assert.equal(inventory, 1);
  const pushed = store.db.prepare('SELECT qty FROM etsy_stock WHERE item_no = ?').get('MUG');
  assert.equal(pushed.qty, 8);
  store.close();
});
