/*
 * Other systems: API keys, the intake, webhooks, and the drop and outbox folders.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.SortedModules = root.SortedModules || []).push(api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  return {
    id: 'connections',
    name: 'Connections',
    description: 'API keys, intake of orders and ASNs, the message log, signed webhooks, and the drop and outbox folders. Keys and messages stay when this is off; folders wait until it is on again.',
    version: 1,
    dependencies: [],
    conflicts: [],
    permissions: [
      { id: 'messages.read', label: 'Read the confirmations sent to other systems' },
      { id: 'intake.write', label: 'Send orders and ASNs in from another system' },
    ],
    routes: [
      { method: '*', pattern: '^/api/keys(?:/|$)' },
      { method: '*', pattern: '^/api/webhooks(?:/|$)' },
      { method: 'POST', pattern: '^/api/inbox$' },
      { method: 'GET', pattern: '^/api/messages$' },
    ],
    menu: [
      { id: 'connections', label: 'Connections', slot: 'app' },
    ],
    handheld: [],
    settings: {
      type: 'object',
      properties: {
        inbox: { type: 'boolean', title: 'Take files from the drop folder', default: true },
      },
    },
    presets: { 'chilled-dc': true, 'high-value': true, 'home-garage': false, 'small-maker': false, '3pl': true },
    upgrades: [{
      version: 1,
      id: 'connections-kept',
      up(db) {
        // Keys, webhooks and messages already have their own tables. This row
        // only marks that the module's data is kept across an upgrade.
        db.prepare("INSERT INTO module_settings (module, key, value) VALUES ('connections', 'kept', '1') ON CONFLICT(module, key) DO NOTHING").run();
      },
    }],
  };
});
