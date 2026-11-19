/*
 * One item list per client. The client keeps the description. The warehouse
 * keeps locations, holds and counts. Off hides the screens and leaves the rows.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.SortedModules = root.SortedModules || []).push(api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  return {
    id: 'client-items',
    name: 'Client items',
    description: 'The client keeps one item list: names, sizes, barcodes, fast and slow movers, and requests to take stock out. Warehouse staff see that list and flag a note. They do not rewrite the description. Locations, holds and counts stay with the warehouse. With one client, the same list is the owner\'s inventory. Switching this off keeps the rows and returns item editing to the warehouse.',
    version: 1,
    defaultOn: false,
    dependencies: ['clients'],
    conflicts: [],
    permissions: [
      { id: 'client-items.flag', label: 'Flag an item for the client' },
      { id: 'client-items.remove', label: 'Carry out a client stock removal' },
    ],
    routes: [
      { method: '*', pattern: '^/api/client-items(?:/|$)' },
    ],
    menu: [
      { id: 'client-items', label: 'Item list', slot: 'app' },
      { id: 'client-movers', label: 'Movers', slot: 'app' },
      { id: 'client-removals', label: 'Stock removal', slot: 'app' },
    ],
    handheld: [],
    settings: null,
    presets: { 'chilled-dc': false, 'high-value': false, 'home-garage': false, 'small-maker': false, '3pl': true },
    upgrades: [{
      version: 1,
      id: 'client-items-kept',
      up(db) {
        db.prepare("INSERT INTO module_settings (module, key, value) VALUES ('client-items', 'kept', '1') ON CONFLICT(module, key) DO NOTHING").run();
      },
    }],
  };
});
