/*
 * Text terminal for scanners. Off until a warehouse turns it on. Telnet is
 * plaintext, so it is for the site LAN.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.SortedModules = root.SortedModules || []).push(api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  return {
    id: 'terminal',
    name: 'Text terminal',
    description: 'A text-only telnet screen for scanner terminals. Off until you turn it on. Telnet is plaintext: use it on the site LAN.',
    version: 1,
    defaultOn: false,
    dependencies: [],
    conflicts: [],
    permissions: [],
    routes: [],
    menu: [],
    handheld: [],
    settings: {
      type: 'object',
      properties: {
        port: { type: 'integer', title: 'Telnet port', default: 2323 },
        idleMinutes: { type: 'integer', title: 'Idle minutes before the session drops', default: 15 },
        maxSessions: { type: 'integer', title: 'Sessions at once', default: 8 },
      },
    },
    presets: { 'chilled-dc': false, 'high-value': false, 'home-garage': false, 'small-maker': false, '3pl': false },
    upgrades: [{
      version: 1,
      id: 'terminal-kept',
      up(db) {
        db.prepare("INSERT INTO module_settings (module, key, value) VALUES ('terminal', 'kept', '1') ON CONFLICT(module, key) DO NOTHING").run();
      },
    }],
  };
});
