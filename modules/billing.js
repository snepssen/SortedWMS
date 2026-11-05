/*
 * 3PL billing: rate cards and invoices. Needs Clients. Switching it off
 * keeps every rate card; switching it on brings them back.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.SortedModules = root.SortedModules || []).push(api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  return {
    id: 'billing',
    name: '3PL billing',
    description: 'Rate cards and invoices per client: storage, inbound, outbound, kitting, tiers, seasons and a monthly minimum. Needs Clients. The cards stay when this is off.',
    version: 1,
    dependencies: ['clients'],
    conflicts: [],
    permissions: [{ id: 'tariff.write', label: 'Edit client rate cards' }],
    routes: [
      { method: 'POST', pattern: '^/api/clients/[^/]+/tariff$' },
      { method: 'POST', pattern: '^/api/clients/[^/]+/space$' },
      { method: 'GET', pattern: '^/api/reports/billing(?:\\.html|\\.csv)?$' },
      { method: 'GET', pattern: '^/api/reports/invoice(?:\\.csv)?$' },
    ],
    menu: [
      { id: 'tariff', label: 'Tariff', slot: 'app' },
    ],
    handheld: [],
    settings: {
      type: 'object',
      properties: {
        currency: { type: 'string', title: 'Currency shown on invoices', default: 'EUR' },
      },
    },
    presets: { 'chilled-dc': true, 'high-value': true, 'home-garage': false, 'small-maker': false, '3pl': true },
    upgrades: [{
      version: 1,
      id: 'billing-kept',
      up(db) {
        db.prepare("INSERT INTO module_settings (module, key, value) VALUES ('billing', 'kept', '1') ON CONFLICT(module, key) DO NOTHING").run();
      },
    }],
  };
});
