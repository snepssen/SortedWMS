/*
 * WooCommerce shops: orders in, stock and fulfilment out. See docs/connectors/WOOCOMMERCE.md.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.SortedModules = root.SortedModules || []).push(api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  return {
    id: 'woocommerce',
    name: 'WooCommerce',
    description: 'Import processing orders from a WooCommerce shop, map SKUs to items, and send stock and tracking back. The consumer secret is never shown again.',
    version: 1,
    defaultOn: false,
    dependencies: ['connections'],
    conflicts: [],
    permissions: [
      { id: 'woocommerce.manage', label: 'Connect WooCommerce shops and map SKUs' },
    ],
    routes: [
      { method: '*', pattern: '^/api/woocommerce(?:/|$)' },
    ],
    menu: [
      { id: 'woocommerce', label: 'WooCommerce', slot: 'app' },
    ],
    handheld: [],
    settings: null,
    presets: { 'chilled-dc': false, 'high-value': false, 'home-garage': false, 'small-maker': false, '3pl': true },
    upgrades: [{
      version: 1,
      id: 'woocommerce-tables',
      up(db) {
        db.exec(`
          CREATE TABLE IF NOT EXISTS woo_shops (
            id TEXT PRIMARY KEY, site TEXT NOT NULL, client_id TEXT, name TEXT NOT NULL,
            shop TEXT NOT NULL, buffer INTEGER NOT NULL DEFAULT 0,
            poll_minutes INTEGER NOT NULL DEFAULT 15, active INTEGER NOT NULL DEFAULT 1
          );
          CREATE TABLE IF NOT EXISTS woo_map (
            shop_id TEXT NOT NULL, sku TEXT NOT NULL, item_no TEXT NOT NULL,
            product_id TEXT, variation_id TEXT, PRIMARY KEY (shop_id, sku)
          );
          CREATE TABLE IF NOT EXISTS woo_catalog (
            shop_id TEXT NOT NULL, sku TEXT NOT NULL, title TEXT, barcode TEXT,
            product_id TEXT, variation_id TEXT, PRIMARY KEY (shop_id, sku)
          );
          CREATE TABLE IF NOT EXISTS woo_link (
            shop_id TEXT NOT NULL, external_id TEXT NOT NULL, ref TEXT NOT NULL, order_id TEXT,
            PRIMARY KEY (shop_id, external_id)
          );
          CREATE TABLE IF NOT EXISTS woo_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT, site TEXT NOT NULL, shop_id TEXT,
            t INTEGER NOT NULL, ok INTEGER NOT NULL, action TEXT NOT NULL, summary TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS woo_stock (
            shop_id TEXT NOT NULL, item_no TEXT NOT NULL, qty INTEGER, pushed_at INTEGER,
            PRIMARY KEY (shop_id, item_no)
          );
          CREATE TABLE IF NOT EXISTS woo_meta (site TEXT NOT NULL, key TEXT NOT NULL, value TEXT, PRIMARY KEY (site, key));
        `);
        db.prepare("INSERT INTO module_settings (module, key, value) VALUES ('woocommerce', 'kept', '1') ON CONFLICT(module, key) DO NOTHING").run();
      },
    }],
  };
});
