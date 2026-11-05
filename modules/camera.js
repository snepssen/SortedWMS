/*
 * Scan with the phone or laptop camera, for a bench that has no barcode scanner.
 * There is no server route: the button is added in the browser.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.SortedModules = root.SortedModules || []).push(api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  return {
    id: 'camera',
    name: 'Camera scanning',
    description: 'A camera button beside each scan field, for a phone or a laptop with no barcode scanner. Printed plate labels stay part of the core. Switching this off only removes the camera button.',
    version: 1,
    dependencies: [],
    conflicts: [],
    permissions: [],
    routes: [],
    menu: [
      { id: 'camera', label: 'Camera scan', slot: 'scan' },
    ],
    handheld: [],
    settings: null,
    presets: { 'chilled-dc': true, 'high-value': true, 'home-garage': true, 'small-maker': true, '3pl': true },
    upgrades: [{
      version: 1,
      id: 'camera-kept',
      up(db) {
        db.prepare("INSERT INTO module_settings (module, key, value) VALUES ('camera', 'kept', '1') ON CONFLICT(module, key) DO NOTHING").run();
      },
    }],
  };
});
