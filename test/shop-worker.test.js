const test = require('node:test');
const assert = require('node:assert/strict');
const { Store } = require('../server/store');
const { createShopWorker } = require('../server/shop-worker');
const { shopPages } = require('../server/shop-pages');
const site = require('../server/site.blank.json');

test('shipment delivery survives a failure and worker restart after cursor advancement', async () => {
  let time = 100000;
  const store = new Store({ site, now: () => time });
  store.wh.setModules({ shopify: true });
  store.db.exec('CREATE TABLE worker_meta (site TEXT, key TEXT, value TEXT, PRIMARY KEY(site, key))');
  store.wh._emit('order.shipped', { orderId: 'SO1' });
  let attempts = 0;
  const options = {
    store, connector: 'shopify', metaTable: 'worker_meta', shops: () => [],
    pull: async () => {}, journal: () => {}, now: () => time,
    deliver: async () => { if (++attempts === 1) throw new Error('Network unavailable'); },
  };
  try {
    await createShopWorker(options).run();
    assert.equal(store.db.prepare('SELECT value FROM worker_meta WHERE key = ?').get('message-cursor').value, '1');
    assert.equal(store.db.prepare('SELECT delivered_at FROM shop_deliveries').get().delivered_at, null);
    time += 15000;
    await createShopWorker(options).run();
    assert.equal(attempts, 2);
    assert.equal(store.db.prepare('SELECT delivered_at FROM shop_deliveries').get().delivered_at, time);
    await createShopWorker(options).run();
    assert.equal(attempts, 2);
  } finally { store.close(); }
});

test('concurrent warehouse contexts stay isolated across awaited network operations', async () => {
  const store = new Store({ site });
  store.createSite({ id: 'SECOND', name: 'Second warehouse' });
  let finish;
  const paused = new Promise((resolve) => { finish = resolve; });
  try {
    const second = store._withSite('SECOND', async () => {
      await paused;
      assert.equal(store.siteId, 'SECOND');
      store.exec('addItem', { itemNo: 'SECOND-PART', name: 'Second part', category: 'GEN' });
    });
    store.siteId = 'MAIN';
    store.exec('addItem', { itemNo: 'MAIN-PART', name: 'Main part', category: 'GEN' });
    finish();
    await second;
    assert.ok(store.wh.items['MAIN-PART']);
    assert.equal(store.wh.items['SECOND-PART'], undefined);
    assert.ok(store.warehouse('SECOND').items['SECOND-PART']);
    assert.equal(store.siteId, 'MAIN');
  } finally { store.close(); }
});

test('background workers process all configured sites and retain their site while awaiting', async () => {
  const store = new Store({ site });
  store.createSite({ id: 'SECOND', name: 'Second warehouse' });
  for (const id of ['MAIN', 'SECOND']) store._withSite(id, () => store.exec('setModules', { shopify: true }));
  store.db.exec('CREATE TABLE worker_meta (site TEXT, key TEXT, value TEXT, PRIMARY KEY(site, key))');
  store.wh._emit('order.shipped', { orderId: 'MAIN-ORDER' });
  store._withSite('SECOND', () => {
    const wh = store.warehouse('SECOND');
    wh._emit('order.shipped', { orderId: 'SECOND-ORDER' });
    store.exec('setConfig', { patch: {} });
  });
  const seen = [];
  const worker = createShopWorker({
    store, connector: 'shopify', metaTable: 'worker_meta', shops: () => [], pull: async () => {},
    journal: () => {}, deliver: async (message) => {
      const id = store.siteId;
      await Promise.resolve();
      assert.equal(store.siteId, id);
      seen.push([id, message.data.orderId]);
    },
  });
  try {
    store.siteId = 'SECOND';
    await worker.run();
    assert.deepEqual(seen, [['MAIN', 'MAIN-ORDER'], ['SECOND', 'SECOND-ORDER']]);
  } finally { store.close(); }
});

test('pagination follows Shopify links, WooCommerce pages and Etsy offsets past fifty orders', async () => {
  for (const mode of ['link', 'page', 'offset']) {
    const requests = [];
    const result = [];
    for await (const rows of shopPages({
      mode, path: '/orders?limit=50', rows: (data) => data.rows,
      load: async (url) => {
        requests.push(url);
        const first = requests.length === 1;
        return { data: { rows: Array.from({ length: first ? 50 : 1 }, (_, i) => first ? i : 50), count: 51 },
          headers: first ? { link: '</orders?page_info=next>; rel="next"', 'x-wp-totalpages': '2' } : { 'x-wp-totalpages': '2' } };
      },
    })) result.push(...rows);
    assert.equal(result.length, 51);
    assert.equal(requests.length, 2);
    assert.match(requests[1], mode === 'link' ? /page_info=next/ : mode === 'page' ? /page=2/ : /offset=50/);
  }
});
