/*
 * Low-stock alerts that leave the building: webhooks, email, and the bell.
 * The work is in server/alerts.js. See docs/ALERTS.md.
 *
 * Off-site backups call raise(store, { type: 'backup.failed', summary, site, at })
 * when this module is on. The summary is already free of passphrases.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.SortedModules = root.SortedModules || []).push(api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  return {
    id: 'alerts',
    name: 'Low-stock alerts',
    description: 'Tell the warehouse, and a client about their own items, when available stock reaches the reorder point. Webhooks, email, and the bell. One alert until it recovers, then a reminder if it stays low. Switching this off keeps the history.',
    version: 1,
    dependencies: [],
    conflicts: [],
    permissions: [
      { id: 'alerts.read', label: 'See low-stock alerts' },
      { id: 'alerts.write', label: 'Change alert settings and send a test' },
    ],
    routes: [
      { method: '*', pattern: '^/api/notify(?:/|$)' },
    ],
    menu: [
      { id: 'alerts', label: 'Alerts', slot: 'app' },
    ],
    handheld: [],
    settings: null,
    presets: { 'chilled-dc': true, 'high-value': true, 'home-garage': true, 'small-maker': true, '3pl': true },
    upgrades: [{
      version: 1,
      id: 'alerts-tables',
      up(db) {
        db.exec(`
          CREATE TABLE IF NOT EXISTS alert_config (site TEXT PRIMARY KEY, json TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS alert_latch (
            site TEXT NOT NULL, item_key TEXT NOT NULL, phase TEXT NOT NULL,
            since_ms INTEGER NOT NULL, last_sent INTEGER, pending_since INTEGER,
            PRIMARY KEY (site, item_key)
          );
          CREATE TABLE IF NOT EXISTS alert_queue (
            id INTEGER PRIMARY KEY AUTOINCREMENT, site TEXT NOT NULL, t INTEGER NOT NULL,
            hold TEXT NOT NULL, payload TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS alert_sent (
            id INTEGER PRIMARY KEY AUTOINCREMENT, site TEXT NOT NULL, t INTEGER NOT NULL,
            channel TEXT NOT NULL, kind TEXT NOT NULL, summary TEXT NOT NULL, recipient TEXT
          );
          CREATE TABLE IF NOT EXISTS alert_note (
            id INTEGER PRIMARY KEY AUTOINCREMENT, site TEXT NOT NULL, t INTEGER NOT NULL,
            kind TEXT NOT NULL, summary TEXT NOT NULL, client_id TEXT
          );
          CREATE TABLE IF NOT EXISTS alert_read (
            note INTEGER NOT NULL, user_id INTEGER NOT NULL, PRIMARY KEY (note, user_id)
          );
          CREATE TABLE IF NOT EXISTS alert_meta (
            site TEXT NOT NULL, key TEXT NOT NULL, value TEXT, PRIMARY KEY (site, key)
          );
        `);
        db.prepare("INSERT INTO module_settings (module, key, value) VALUES ('alerts', 'kept', '1') ON CONFLICT(module, key) DO NOTHING").run();
      },
    }],
    raise(store, event) {
      if (typeof require !== 'function') return null;
      return require('../server/alerts').raiseExternal(store, event);
    },
  };
});
