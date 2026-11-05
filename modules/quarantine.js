/*
 * Physical quarantine positions and the move of a held pallet into them.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.SortedModules = root.SortedModules || []).push(api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  return {
    id: 'quarantine',
    name: 'Quarantine',
    description: 'Designate rack positions as quarantine and move a held pallet in and out. Damage, temperature and recall holds are separate. The designation and the history stay when this is off.',
    version: 1,
    dependencies: [],
    conflicts: [],
    permissions: [],
    routes: [
      { method: '*', pattern: '^/api/quarantine(?:/|$)' },
    ],
    menu: [
      { id: 'quarantine', label: 'Quarantine', slot: 'office' },
    ],
    handheld: [],
    settings: null,
    presets: { 'chilled-dc': true, 'high-value': false, 'home-garage': false, 'small-maker': false, '3pl': false },
    upgrades: [{
      version: 1,
      id: 'quarantine-kept',
      up(db) {
        db.prepare("INSERT INTO module_settings (module, key, value) VALUES ('quarantine', 'kept', '1') ON CONFLICT(module, key) DO NOTHING").run();
      },
    }],
  };
});
