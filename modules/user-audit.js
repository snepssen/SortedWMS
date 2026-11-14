/*
 * A CSV of every user's moves and actions. Manager and administrator only.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.SortedModules = root.SortedModules || []).push(api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  return {
    id: 'user-audit',
    name: 'User audit',
    description: 'Export every user\'s moves and actions over a date range, in the warehouse\'s local time. Only a manager or an administrator can open it. A client login cannot. The journal stays when this is off.',
    version: 1,
    defaultOn: false,
    dependencies: [],
    conflicts: [],
    permissions: [{ id: 'user-audit.read', label: 'Export the user audit' }],
    routes: [
      { method: 'GET', pattern: '^/api/user-audit\\.csv$' },
    ],
    menu: [{ id: 'user-audit', label: 'User audit', slot: 'app' }],
    handheld: [],
    settings: null,
    presets: { 'chilled-dc': false, 'high-value': false, 'home-garage': false, 'small-maker': false, '3pl': true },
    upgrades: [{
      version: 1,
      id: 'user-audit-kept',
      up(db) {
        db.prepare("INSERT INTO module_settings (module, key, value) VALUES ('user-audit', 'kept', '1') ON CONFLICT(module, key) DO NOTHING").run();
      },
    }],
  };
});
