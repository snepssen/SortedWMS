/*
 * Pair a phone or tablet on the same network with a QR code. Meant for a
 * laptop or a small site. The link is HTTP on a trusted LAN.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.SortedModules = root.SortedModules || []).push(api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  return {
    id: 'device-pairing',
    name: 'Connect a device',
    description: 'A QR code and a short code so a phone on the same network opens SortedWMS and stays signed in on that device. HTTP on a trusted LAN.',
    version: 1,
    dependencies: [],
    conflicts: [],
    permissions: [{ id: 'devices.manage', label: 'See and revoke paired devices' }],
    routes: [
      { method: 'GET', pattern: '^/api/pairing(?:/|$)' },
      { method: 'POST', pattern: '^/api/pairing(?:/|$)' },
      { method: 'GET', pattern: '^/api/devices/paired' },
      { method: 'POST', pattern: '^/api/devices/paired(?:/|$)' },
    ],
    menu: [{ id: 'pairing', label: 'Connect a device', slot: 'app' }],
    handheld: [],
    settings: {
      type: 'object',
      properties: {
        idleHours: { type: 'integer', title: 'Hours of quiet before a paired device is signed out', default: 4 },
        allowPublic: { type: 'boolean', title: 'Allow a public address in the link', default: false },
      },
    },
    presets: { 'chilled-dc': true, 'high-value': true, 'home-garage': true, 'small-maker': true, '3pl': true },
    upgrades: [{
      version: 1,
      id: 'device-pairing-kept',
      up(db) {
        db.prepare("INSERT INTO module_settings (module, key, value) VALUES ('device-pairing', 'kept', '1') ON CONFLICT(module, key) DO NOTHING").run();
      },
    }],
  };
});