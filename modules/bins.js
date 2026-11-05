/*
 * Loose stock in bins and on shelves, without a license plate.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.SortedModules = root.SortedModules || []).push(api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  return {
    id: 'bins',
    name: 'Bins',
    description: 'Loose stock in bins and on shelves: put away, pick, move and count without a license plate. A home garage and a small maker live here. The quantities stay when this is off.',
    version: 1,
    dependencies: [],
    conflicts: [],
    permissions: [],
    routes: [
      { method: '*', pattern: '^/api/bins(?:/|$)' },
    ],
    menu: [
      { id: 'bins', label: 'Bins', slot: 'app' },
      { id: 'bins', label: 'Bins', slot: 'handheld' },
    ],
    handheld: [],
    settings: {
      type: 'object',
      properties: {
        mixed: { type: 'boolean', title: 'A new bin may hold more than one item', default: true },
      },
    },
    presets: { 'chilled-dc': true, 'high-value': true, 'home-garage': true, 'small-maker': true, '3pl': true },
    upgrades: [{
      version: 1,
      id: 'bins-kept',
      up(db) {
        db.prepare("INSERT INTO module_settings (module, key, value) VALUES ('bins', 'kept', '1') ON CONFLICT(module, key) DO NOTHING").run();
      },
    }],
  };
});
