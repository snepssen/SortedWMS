/*
 * The made-up workload and the bots that drive a demonstration floor.
 * The Pages walkthrough is a separate presentation and does not ask this module.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.SortedModules = root.SortedModules || []).push(api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  return {
    id: 'demo',
    name: 'Demo bots',
    description: 'Drop a made-up rush of orders and inbound pallets into this warehouse. The guided Pages demo is separate and keeps working. Real stock is not removed when this is switched off.',
    version: 1,
    dependencies: [],
    conflicts: [],
    permissions: [],
    routes: [
      { method: 'POST', pattern: '^/api/workload$' },
    ],
    menu: [
      { id: 'workload', label: 'Drop in work', slot: 'demo' },
    ],
    handheld: [],
    settings: null,
    presets: { 'chilled-dc': true, 'high-value': false, 'home-garage': false, 'small-maker': false, '3pl': false },
    upgrades: [{
      version: 1,
      id: 'demo-kept',
      up(db) {
        db.prepare("INSERT INTO module_settings (module, key, value) VALUES ('demo', 'kept', '1') ON CONFLICT(module, key) DO NOTHING").run();
      },
    }],
  };
});
