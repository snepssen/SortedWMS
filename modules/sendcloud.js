/*
 * Sendcloud labels for a packed shipment. See docs/connectors/SENDCLOUD.md.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.SortedModules = root.SortedModules || []).push(api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  return {
    id: 'sendcloud',
    name: 'Sendcloud',
    description: 'Buy a Sendcloud label for a packed shipment, print it, and keep the tracking number. Keys are never shown again.',
    version: 1,
    defaultOn: false,
    dependencies: ['connections'],
    conflicts: [],
    permissions: [
      { id: 'sendcloud.manage', label: 'Connect Sendcloud and buy labels' },
    ],
    routes: [
      { method: '*', pattern: '^/api/sendcloud(?:/|$)' },
    ],
    menu: [
      { id: 'sendcloud', label: 'Sendcloud', slot: 'app' },
    ],
    handheld: [],
    settings: null,
    presets: { 'chilled-dc': false, 'high-value': false, 'home-garage': false, 'small-maker': false, '3pl': true },
    upgrades: [{
      version: 1,
      id: 'sendcloud-tables',
      up(db) {
        db.exec(`
          CREATE TABLE IF NOT EXISTS sendcloud_account (
            site TEXT PRIMARY KEY, sender_name TEXT, sender_address TEXT, sender_city TEXT, sender_postal TEXT, sender_country TEXT
          );
          CREATE TABLE IF NOT EXISTS sendcloud_rules (
            id INTEGER PRIMARY KEY AUTOINCREMENT, site TEXT NOT NULL, client_id TEXT, country TEXT,
            min_kg REAL NOT NULL, max_kg REAL NOT NULL, method_id TEXT NOT NULL, carrier TEXT NOT NULL, service TEXT
          );
          CREATE TABLE IF NOT EXISTS sendcloud_parcels (
            id INTEGER PRIMARY KEY AUTOINCREMENT, site TEXT NOT NULL, order_id TEXT, return_id TEXT,
            external_id TEXT, carrier TEXT, service TEXT, tracking TEXT, tracking_url TEXT, pdf_path TEXT,
            status TEXT, print_id INTEGER, t INTEGER NOT NULL
          );
          CREATE TABLE IF NOT EXISTS sendcloud_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT, site TEXT NOT NULL, t INTEGER NOT NULL, ok INTEGER NOT NULL,
            action TEXT NOT NULL, summary TEXT NOT NULL
          );
        `);
        db.prepare("INSERT INTO module_settings (module, key, value) VALUES ('sendcloud', 'kept', '1') ON CONFLICT(module, key) DO NOTHING").run();
      },
    }],
  };
});
