/*
 * Lot numbers and best-before dates, and the batch recall that hangs off them.
 * FEFO is the category feature that ships the earliest expiry first; it needs this.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.SortedModules = root.SortedModules || []).push(api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  return {
    id: 'lots',
    name: 'Lots and best-before',
    description: 'Batch numbers, best-before dates, the near-expiry list and batch recall. FEFO allocation needs this. Dates already on stock stay when this is off.',
    version: 1,
    dependencies: [],
    conflicts: [],
    permissions: [],
    routes: [
      { method: 'GET', pattern: '^/api/best-before$' },
      { method: '*', pattern: '^/api/recalls(?:/|$)' },
      { method: 'GET', pattern: '^/api/reports/expiry$' },
      { method: 'GET', pattern: '^/api/trace/' },
      { method: 'POST', pattern: '^/api/pallets/[^/]+/allow-short$' },
      { method: 'POST', pattern: '^/api/items/[^/]+/min-ship-days$' },
    ],
    menu: [
      { id: 'recalls', label: 'Batch recalls', slot: 'office' },
    ],
    handheld: [],
    settings: {
      type: 'object',
      properties: {
        watchDays: { type: 'integer', title: 'Days ahead on the near best-before list', default: 14 },
      },
    },
    presets: { 'chilled-dc': true, 'high-value': true, 'home-garage': false, 'small-maker': true, '3pl': false },
    upgrades: [{
      version: 1,
      id: 'lots-kept',
      up(db) {
        db.prepare("INSERT INTO module_settings (module, key, value) VALUES ('lots', 'kept', '1') ON CONFLICT(module, key) DO NOTHING").run();
      },
    }],
  };
});
