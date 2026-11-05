/*
 * Ship stock to another warehouse on this install and receive it there.
 * A refusal puts the original plate back. Needs More warehouses.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.SortedModules = root.SortedModules || []).push(api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  return {
    id: 'transfers',
    name: 'Transfers',
    description: 'Ship stock to another warehouse on this install and receive it there. A refusal returns the original plate. Needs More warehouses. Transfer records stay when this is off.',
    version: 1,
    dependencies: ['sites'],
    conflicts: [],
    permissions: [],
    routes: [
      { method: 'POST', pattern: '^/api/sites/transfer$', weight: 50 },
      { method: 'POST', pattern: '^/api/sites/transfers/[^/]+/(?:receive|cancel)$', weight: 50 },
    ],
    menu: [
      { id: 'transfers', label: 'Transfers', slot: 'app' },
    ],
    handheld: [],
    settings: null,
    presets: { 'chilled-dc': true, 'high-value': false, 'home-garage': false, 'small-maker': false, '3pl': true },
    upgrades: [{
      version: 1,
      id: 'transfers-kept',
      up(db) {
        db.prepare("INSERT INTO module_settings (module, key, value) VALUES ('transfers', 'kept', '1') ON CONFLICT(module, key) DO NOTHING").run();
      },
    }],
  };
});
