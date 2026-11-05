/*
 * VAL stations and work orders that build a kit from components.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.SortedModules = root.SortedModules || []).push(api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  return {
    id: 'kitting',
    name: 'Kitting',
    description: 'VAL stations and work orders that build a kit from components. Kits and open jobs stay when this is off.',
    version: 1,
    dependencies: [],
    conflicts: [],
    permissions: [{ id: 'val.execute', label: 'Run value-added and kitting scans' }],
    routes: [
      { method: '*', pattern: '^/api/val(?:/|$)' },
      { method: 'POST', pattern: '^/api/work-orders$' },
    ],
    menu: [
      { id: 'kitting', label: 'Kitting', slot: 'app' },
    ],
    handheld: [],
    settings: null,
    presets: { 'chilled-dc': true, 'high-value': true, 'home-garage': false, 'small-maker': true, '3pl': true },
    upgrades: [{
      version: 1,
      id: 'kitting-kept',
      up(db) {
        db.prepare("INSERT INTO module_settings (module, key, value) VALUES ('kitting', 'kept', '1') ON CONFLICT(module, key) DO NOTHING").run();
      },
    }],
  };
});
