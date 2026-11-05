/*
 * Clients who own the goods, and the login a client uses to see only theirs.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.SortedModules = root.SortedModules || []).push(api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  return {
    id: 'clients',
    name: 'Clients',
    description: 'Goods owned by clients, and a client login that sees only that client\'s items, stock and orders. Items themselves stay. Client records stay when this is off, and a client login is refused until it is on again.',
    version: 1,
    dependencies: [],
    conflicts: [],
    permissions: [
      { id: 'clients.read', label: 'View clients' },
      { id: 'clients.write', label: 'Add, edit and archive clients' },
      { id: 'items.approve', label: 'Approve items submitted by a client' },
    ],
    routes: [
      { method: '*', pattern: '^/api/clients(?:/|$)' },
    ],
    menu: [
      { id: 'clients', label: 'Clients', slot: 'app' },
    ],
    handheld: [],
    settings: {
      type: 'object',
      properties: {
        itemApproval: { type: 'boolean', title: 'Client items need warehouse approval', default: false },
      },
    },
    presets: { 'chilled-dc': true, 'high-value': true, 'home-garage': false, 'small-maker': false, '3pl': true },
    upgrades: [{
      version: 1,
      id: 'clients-kept',
      up(db) {
        db.prepare("INSERT INTO module_settings (module, key, value) VALUES ('clients', 'kept', '1') ON CONFLICT(module, key) DO NOTHING").run();
      },
    }],
  };
});
