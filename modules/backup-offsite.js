/*
 * Encrypted off-site backups. The warehouse switches this on or off.
 * The work itself is in server/backup-offsite.js, because it uses the
 * disk and the network. See docs/BACKUPS.md.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.SortedModules = root.SortedModules || []).push(api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  return {
    id: 'backup-offsite',
    name: 'Off-site backups',
    description: 'Encrypt the database and send it on a schedule to a folder, S3-compatible storage, or WebDAV. The passphrase is never shown again. Switching this off keeps the copies already sent.',
    version: 1,
    dependencies: [],
    conflicts: [],
    permissions: [
      { id: 'backups.offsite', label: 'Run and restore off-site backups' },
    ],
    routes: [
      { method: '*', pattern: '^/api/offsite(?:/|$)' },
    ],
    menu: [
      { id: 'offsite', label: 'Backups', slot: 'app' },
    ],
    handheld: [],
    settings: null,
    presets: { 'chilled-dc': true, 'high-value': true, 'home-garage': true, 'small-maker': true, '3pl': true },
    upgrades: [{
      version: 1,
      id: 'offsite-tables',
      up(db) {
        db.exec(`
          CREATE TABLE IF NOT EXISTS offsite_config (site TEXT PRIMARY KEY, json TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS offsite_runs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            site TEXT NOT NULL,
            t INTEGER NOT NULL,
            ok INTEGER NOT NULL,
            summary TEXT NOT NULL
          );
        `);
        db.prepare("INSERT INTO module_settings (module, key, value) VALUES ('backup-offsite', 'kept', '1') ON CONFLICT(module, key) DO NOTHING").run();
      },
    }],
  };
});
