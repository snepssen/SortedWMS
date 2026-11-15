const test = require('node:test');
const assert = require('node:assert/strict');
const { Store } = require('../server/store');
const { createAuth } = require('../server/auth');
const { createShopWorker } = require('../server/shop-worker');
const { createApi } = require('../server/api');
const { createShopify } = require('../server/shopify');
const { createAlerts } = require('../server/alerts');
const site = require('../server/site.blank.json');

function world(t) {
  const store = new Store({ site });
  t.after(() => store.close());
  createAuth(store.db).ensureAdmin({ username: 'admin', password: 'example-admin-password', displayName: 'Admin' });
  store.db.exec('CREATE TABLE worker_meta (site TEXT, key TEXT, value TEXT, PRIMARY KEY(site, key))');
  store.db.exec('CREATE TABLE extension_data (id TEXT PRIMARY KEY, payload BLOB)');
  return store;
}

test('a JSON round trip preserves pending shipment delivery, its cursor and extension blobs', async (t) => {
  const store = world(t);
  store.exec('setModules', { shopify: true }, 'admin');
  store.wh._emit('order.shipped', { orderId: 'SO1' });
  const options = {
    store, connector: 'shopify', metaTable: 'worker_meta', shops: () => [],
    pull: async () => {}, journal() {}, now: () => 100000,
    deliver: async () => { throw new Error('offline'); },
  };
  await createShopWorker(options).run();
  store.snapshot();
  store.db.prepare('INSERT INTO extension_data VALUES (?, ?)').run('binary', Buffer.from([0, 1, 255]));
  const dump = JSON.parse(JSON.stringify(store.exportBackup()));
  store.db.exec('DELETE FROM shop_deliveries; DELETE FROM worker_meta; DELETE FROM extension_data');
  store.importBackup(dump);
  assert.equal(store.db.prepare('SELECT value FROM worker_meta WHERE key = ?').get('message-cursor').value, '1');
  const queued = store.db.prepare('SELECT * FROM shop_deliveries').get();
  assert.ok(queued, 'the pending delivery survives restore');
  assert.equal(queued.attempts, 1);
  assert.equal(queued.delivered_at, null);
  assert.deepEqual(Buffer.from(store.db.prepare('SELECT payload FROM extension_data').get().payload), Buffer.from([0, 1, 255]));
  let sent = 0;
  await createShopWorker({ ...options, now: () => 120000, deliver: async () => { sent++; } }).run();
  assert.equal(sent, 1);
});

test('restoring a legacy JSON export clears newer module state and transient authentication', (t) => {
  const store = world(t);
  const dump = JSON.parse(JSON.stringify(store.exportBackup()));
  delete dump.moduleTables;
  store.db.prepare('INSERT INTO worker_meta VALUES (?, ?, ?)').run('MAIN', 'message-cursor', '999');
  const auth = createAuth(store.db);
  const signed = auth.login('admin', 'example-admin-password');
  assert.ok(signed.token);
  store.db.prepare('INSERT INTO mfa_challenges VALUES (?, ?, ?)').run('old-mfa', 1, Date.now() + 60000);
  store.db.prepare('INSERT INTO pair_tokens (token_hash, code, user_id, created_by, expires_at, used_at) VALUES (?, ?, ?, ?, ?, ?)').run('old-pair', '123456', 1, 1, Date.now() + 60000, null);
  store.importBackup(dump);
  for (const name of ['worker_meta', 'sessions', 'mfa_challenges', 'pair_tokens']) {
    assert.equal(store.db.prepare(`SELECT COUNT(*) AS n FROM ${name}`).get().n, 0, name);
  }
});

test('a fresh installation restores shop mappings and alert state even when their modules are off', (t) => {
  const source = world(t);
  const target = world(t);
  for (const store of [source, target]) {
    createShopify({ store, secretsFile: null, env: {} });
    createAlerts({ store, secretsFile: null, env: {}, log() {} });
  }
  source.exec('addItem', { itemNo: 'MUG', name: 'Mug', category: 'GEN', palletQty: 1 }, 'office');
  source.exec('setModules', { shopify: false, alerts: false }, 'admin');
  source.db.prepare('INSERT INTO shopify_shops (id, site, name, shop) VALUES (?, ?, ?, ?)').run('example', 'MAIN', 'Example', 'example.myshopify.com');
  source.db.prepare('INSERT INTO shopify_map (shop_id, sku, item_no) VALUES (?, ?, ?)').run('example', 'REMOTE-MUG', 'MUG');
  source.db.prepare('INSERT INTO alert_meta (site, key, value) VALUES (?, ?, ?)').run('MAIN', 'digest-check', 'at-backup');
  source.db.prepare('INSERT INTO alert_queue (site, t, hold, payload) VALUES (?, ?, ?, ?)').run('MAIN', 1, 'digest', '{"type":"low-stock"}');
  source.db.prepare('INSERT INTO api_keys (name, key_hash, role, created_at) VALUES (?, ?, ?, ?)').run('example-integration', 'example-key-hash', 'office', 1);
  const dump = JSON.parse(JSON.stringify(source.exportBackup()));
  target.db.exec("CREATE TABLE later_module (value TEXT); INSERT INTO later_module VALUES ('newer state')");
  target.importBackup(dump);
  for (const name of ['shopify_shops', 'shopify_map', 'alert_meta', 'alert_queue', 'api_keys']) {
    assert.deepEqual(target.db.prepare(`SELECT * FROM ${name}`).all(), source.db.prepare(`SELECT * FROM ${name}`).all(), name);
  }
  assert.equal(target.wh.module('shopify'), false);
  assert.equal(target.wh.module('alerts'), false);
  assert.equal(target.db.prepare('SELECT COUNT(*) AS n FROM later_module').get().n, 0);
  assert.ok(target.db.prepare("SELECT id FROM auth_audit WHERE action = 'backup-import'").get());
});

test('JSON backups omit active authentication challenges and external photo files', (t) => {
  const store = world(t);
  store.db.prepare('INSERT INTO mfa_challenges VALUES (?, ?, ?)').run('active-challenge', 1, Date.now() + 60000);
  store.db.exec('CREATE TABLE backup_item_photos (id TEXT PRIMARY KEY, data BLOB)');
  store.db.prepare('INSERT INTO backup_item_photos VALUES (?, ?)').run('image', Buffer.from('photo-bytes'));
  const dump = JSON.parse(JSON.stringify(store.exportBackup()));
  assert.ok(dump.moduleTables);
  assert.equal(dump.moduleTables.sessions, undefined);
  assert.equal(dump.moduleTables.mfa_challenges, undefined);
  assert.equal(dump.moduleTables.backup_item_photos, undefined);
  assert.equal(JSON.stringify(dump).includes('active-challenge'), false);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM mfa_challenges').get().n, 1, 'export does not change the live database');
  store.importBackup(dump);
  assert.deepEqual(Buffer.from(store.db.prepare('SELECT data FROM backup_item_photos').get().data), Buffer.from('photo-bytes'), 'metadata-only restore retains existing images');
});

test('invalid or unavailable table data is refused without changing warehouse state', (t) => {
  const store = world(t);
  store.exec('setConfig', { patch: { aisleCap: 2 } }, 'admin');
  const dump = JSON.parse(JSON.stringify(store.exportBackup()));
  store.exec('setConfig', { patch: { aisleCap: 3 } }, 'admin');
  for (const moduleTables of [
    { missing_module_table: [{ id: 'x' }] },
    { worker_meta: [{ 'site) VALUES (1); DELETE FROM users; --': 'x' }] },
    { worker_meta: 'not rows' },
    { extension_data: [{ id: 'bad', payload: { $sqliteBlob: 'invalid base64!' } }] },
    { users: [] },
  ]) {
    const result = createApi({ store, printers: { flush() {} } }).handle('POST', '/api/backup', { ...dump, moduleTables });
    assert.equal(result.status, 400);
    assert.equal(store.wh.config.aisleCap, 3);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1);
  }
});

test('a constraint failure rolls back every table and leaves an active login intact', (t) => {
  const store = world(t);
  const dump = JSON.parse(JSON.stringify(store.exportBackup()));
  store.db.prepare('INSERT INTO worker_meta VALUES (?, ?, ?)').run('MAIN', 'keep', 'current');
  createAuth(store.db).login('admin', 'example-admin-password');
  const broken = { ...dump, moduleTables: { worker_meta: [{ site: 'MAIN', key: 'duplicate' }, { site: 'MAIN', key: 'duplicate' }] } };
  assert.throws(() => store.importBackup(broken));
  assert.equal(store.db.prepare('SELECT value FROM worker_meta').get().value, 'current');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 1);
});
