/*
 * Process routes: pallets through work stations, with a standard time and a dwell.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.SortedModules = root.SortedModules || []).push(api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  return {
    id: 'stations',
    name: 'Process stations',
    description: 'Pallets routed through work stations, with a standard time and a dwell. The station screen and the process log stay when this is off; new scans do not.',
    version: 1,
    dependencies: [],
    conflicts: [],
    permissions: [],
    routes: [
      { method: '*', pattern: '^/api/stations(?:/|$)' },
      { method: 'GET', pattern: '^/api/routes$' },
      { method: 'GET', pattern: '^/api/process-log$' },
      { method: 'POST', pattern: '^/api/pallets/[^/]+/process$' },
    ],
    menu: [
      { id: 'stations', label: 'Stations', slot: 'station' },
    ],
    handheld: [],
    settings: null,
    presets: { 'chilled-dc': true, 'high-value': false, 'home-garage': false, 'small-maker': false, '3pl': false },
    upgrades: [{
      version: 1,
      id: 'stations-kept',
      up(db) {
        db.prepare("INSERT INTO module_settings (module, key, value) VALUES ('stations', 'kept', '1') ON CONFLICT(module, key) DO NOTHING").run();
      },
    }],
  };
});
