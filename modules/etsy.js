/*
 * Etsy shops: orders in, stock and tracking out. See docs/connectors/ETSY.md.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.SortedModules = root.SortedModules || []).push(api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  return {
    id: 'etsy',
    name: 'Etsy',
    description: 'Import paid, unshipped Etsy receipts, map SKUs to items, and send stock and tracking back. Sign-in uses OAuth with PKCE. The keystring and tokens are never shown again.',
    version: 1,
    defaultOn: false,
    dependencies: ['connections'],
    conflicts: [],
    permissions: [
      { id: 'etsy.manage', label: 'Connect Etsy shops and map SKUs' },
    ],
    routes: [
      { method: '*', pattern: '^/api/etsy(?:/|$)' },
    ],
    menu: [
      { id: 'etsy', label: 'Etsy', slot: 'app' },
    ],
    handheld: [],
    settings: null,
    presets: { 'chilled-dc': false, 'high-value': false, 'home-garage': false, 'small-maker': false, '3pl': true },
    upgrades: [{
      version: 1,
      id: 'etsy-tables',
      up(db) {
        db.exec(`
          CREATE TABLE IF NOT EXISTS etsy_shops (
            id TEXT PRIMARY KEY, site TEXT NOT NULL, client_id TEXT, name TEXT NOT NULL,
            etsy_shop_id TEXT NOT NULL, redirect_uri TEXT NOT NULL, buffer INTEGER NOT NULL DEFAULT 0,
            poll_minutes INTEGER NOT NULL DEFAULT 15, active INTEGER NOT NULL DEFAULT 1
          );
          CREATE TABLE IF NOT EXISTS etsy_map (
            shop_id TEXT NOT NULL, sku TEXT NOT NULL, item_no TEXT NOT NULL,
            listing_id TEXT, product_id TEXT, PRIMARY KEY (shop_id, sku)
          );
          CREATE TABLE IF NOT EXISTS etsy_catalog (
            shop_id TEXT NOT NULL, sku TEXT NOT NULL, title TEXT, barcode TEXT,
            listing_id TEXT, product_id TEXT, PRIMARY KEY (shop_id, sku)
          );
          CREATE TABLE IF NOT EXISTS etsy_link (
            shop_id TEXT NOT NULL, external_id TEXT NOT NULL, ref TEXT NOT NULL, order_id TEXT,
            PRIMARY KEY (shop_id, external_id)
          );
          CREATE TABLE IF NOT EXISTS etsy_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT, site TEXT NOT NULL, shop_id TEXT,
            t INTEGER NOT NULL, ok INTEGER NOT NULL, action TEXT NOT NULL, summary TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS etsy_stock (
            shop_id TEXT NOT NULL, item_no TEXT NOT NULL, qty INTEGER, pushed_at INTEGER,
            PRIMARY KEY (shop_id, item_no)
          );
          CREATE TABLE IF NOT EXISTS etsy_meta (site TEXT NOT NULL, key TEXT NOT NULL, value TEXT, PRIMARY KEY (site, key));
        `);
        db.prepare("INSERT INTO module_settings (module, key, value) VALUES ('etsy', 'kept', '1') ON CONFLICT(module, key) DO NOTHING").run();
      },
    }],
  };
});
