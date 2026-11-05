/*
 * More than one warehouse on this install, and the switcher in the header.
 * Moving stock between them is the transfers module.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.SortedModules = root.SortedModules || []).push(api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  return {
    id: 'sites',
    name: 'More warehouses',
    description: 'More than one site on this install, with its own plate counters, and a switcher in the header. The other sites stay when this is off.',
    version: 1,
    dependencies: [],
    conflicts: [],
    permissions: [
      { id: 'sites.write', label: 'Create a warehouse' },
      { id: 'sites.switch', label: 'Switch the active warehouse' },
    ],
    routes: [
      { method: '*', pattern: '^/api/sites(?:/|$)' },
    ],
    menu: [
      { id: 'sites', label: 'Warehouses', slot: 'app' },
    ],
    handheld: [],
    settings: null,
    presets: { 'chilled-dc': true, 'high-value': false, 'home-garage': false, 'small-maker': false, '3pl': true },
    upgrades: [{
      version: 1,
      id: 'sites-kept',
      up(db) {
        db.prepare("INSERT INTO module_settings (module, key, value) VALUES ('sites', 'kept', '1') ON CONFLICT(module, key) DO NOTHING").run();
      },
    }],
  };
});
