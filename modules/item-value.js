/*
 * Item value. Off hides the amount, the currency setting and the stock-value
 * report. Amounts already stored stay on the item.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.SortedModules = root.SortedModules || []).push(api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  return {
    id: 'item-value',
    name: 'Item value',
    description: 'A value on each item, in the warehouse currency. Used for ABC by value and the stock-value report. While high-value plates are on, only a role with the item-value permission sees the amount.',
    version: 1,
    dependencies: [],
    conflicts: [],
    permissions: [{ id: 'items.value', label: 'See and edit item value' }],
    routes: [
      { method: 'GET', pattern: '^/api/reports/stock-value' },
      { method: 'POST', pattern: '^/api/item-value/currency$' },
    ],
    menu: [],
    handheld: [],
    settings: {
      type: 'object',
      properties: {
        currency: { type: 'string', title: 'Warehouse currency', default: 'EUR' },
      },
    },
    presets: { 'chilled-dc': true, 'high-value': true, 'home-garage': true, 'small-maker': true, '3pl': true },
    upgrades: [{
      version: 1,
      id: 'item-value-kept',
      up(db) {
        db.prepare("INSERT INTO module_settings (module, key, value) VALUES ('item-value', 'kept', '1') ON CONFLICT(module, key) DO NOTHING").run();
      },
    }],
  };
});
