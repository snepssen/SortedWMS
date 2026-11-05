/*
 * Pick waves: whole pallets, then boxes, then the small rest from the bins.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.SortedModules = root.SortedModules || []).push(api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  return {
    id: 'waves',
    name: 'Pick waves',
    description: 'Orders queue into waves: whole pallets, then boxes, then small picks. Off means pick by hand from the Bins screen. A wave already planned stays until it is finished or cancelled.',
    version: 1,
    dependencies: [],
    conflicts: [],
    permissions: [],
    routes: [
      { method: '*', pattern: '^/api/waves(?:/|$)' },
    ],
    menu: [
      { id: 'waves', label: 'Pick waves', slot: 'app' },
      { id: 'cases', label: 'Pallet and box picks', slot: 'app' },
    ],
    handheld: [],
    settings: {
      type: 'object',
      properties: {
        auto: { type: 'boolean', title: 'Plan the next wave automatically', default: true },
        maxWaitMin: { type: 'integer', title: 'Minutes an order may wait before it opens a box', default: 30 },
        maxOrders: { type: 'integer', title: 'Orders in one wave', default: 12 },
      },
    },
    presets: { 'chilled-dc': true, 'high-value': true, 'home-garage': false, 'small-maker': false, '3pl': true },
    upgrades: [{
      version: 1,
      id: 'waves-kept',
      up(db) {
        db.prepare("INSERT INTO module_settings (module, key, value) VALUES ('waves', 'kept', '1') ON CONFLICT(module, key) DO NOTHING").run();
      },
    }],
  };
});