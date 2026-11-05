/*
 * Reports for the office and for a client login. Tables that belong to
 * another module are omitted while that module is off.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.SortedModules = root.SortedModules || []).push(api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  return {
    id: 'reports',
    name: 'Reports',
    description: 'Stock, ageing, movements, volumes, cycle time, pick accuracy, count accuracy, location use, and a best-before outlook when lots are on. Each table filters and exports to CSV in this warehouse\'s timezone. A client login sees only their own rows. Switching this off hides the page. The numbers stay.',
    version: 1,
    dependencies: [],
    conflicts: [],
    permissions: [],
    routes: [
      { method: 'GET', pattern: '^/api/reports/area' },
    ],
    menu: [
      { id: 'reports', label: 'Reports', slot: 'app' },
    ],
    handheld: [],
    settings: null,
    presets: { 'chilled-dc': true, 'high-value': true, 'home-garage': true, 'small-maker': true, '3pl': true },
    upgrades: [{
      version: 1,
      id: 'reports-kept',
      up(db) {
        db.prepare("INSERT INTO module_settings (module, key, value) VALUES ('reports', 'kept', '1') ON CONFLICT(module, key) DO NOTHING").run();
      },
    }],
  };
});