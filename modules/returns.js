/*
 * Goods a customer sends back against an order, graded restock, quarantine or scrap.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.SortedModules = root.SortedModules || []).push(api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  return {
    id: 'returns',
    name: 'Returns',
    description: 'Receive a return against a shipped order and grade it restock, quarantine or scrap. The return and its grade stay when this is off.',
    version: 1,
    dependencies: [],
    conflicts: [],
    permissions: [],
    routes: [
      { method: '*', pattern: '^/api/returns(?:/|$)' },
      { method: 'GET', pattern: '^/api/orders/[^/]+/returnable$' },
    ],
    menu: [
      { id: 'returns', label: 'Returns', slot: 'app' },
    ],
    handheld: [],
    settings: null,
    presets: { 'chilled-dc': true, 'high-value': true, 'home-garage': false, 'small-maker': true, '3pl': true },
    upgrades: [{
      version: 1,
      id: 'returns-kept',
      up(db) {
        db.prepare("INSERT INTO module_settings (module, key, value) VALUES ('returns', 'kept', '1') ON CONFLICT(module, key) DO NOTHING").run();
      },
    }],
  };
});
