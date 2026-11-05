/*
 * One serial number per piece, from put-away through to the order it shipped on.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.SortedModules = root.SortedModules || []).push(api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  return {
    id: 'serials',
    name: 'Serial numbers',
    description: 'Trace an item by serial number: book them on a pallet or in a bin, and follow a serial to the order it left on. The register stays when this is off.',
    version: 1,
    dependencies: [],
    conflicts: [],
    permissions: [],
    routes: [
      { method: '*', pattern: '^/api/serials(?:/|$)' },
      { method: 'POST', pattern: '^/api/items/[^/]+/serials$' },
      { method: '*', pattern: '^/api/pallets/[^/]+/serials$' },
    ],
    menu: [
      { id: 'serials', label: 'Serial numbers', slot: 'app' },
    ],
    handheld: [],
    settings: null,
    presets: { 'chilled-dc': true, 'high-value': true, 'home-garage': false, 'small-maker': false, '3pl': true },
    upgrades: [{
      version: 1,
      id: 'serials-kept',
      up(db) {
        db.prepare("INSERT INTO module_settings (module, key, value) VALUES ('serials', 'kept', '1') ON CONFLICT(module, key) DO NOTHING").run();
      },
    }],
  };
});
