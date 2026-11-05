/*
 * Temperature zones, pallet temperature checks and trailer-air inspections.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.SortedModules = root.SortedModules || []).push(api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  return {
    id: 'food',
    name: 'Food and temperature',
    description: 'Temperature zones, a recorded pallet temperature, the quality hold that follows an out-of-range reading, and trailer-air inspections. Readings stay when this is off. It does not monitor continuously.',
    version: 1,
    dependencies: [],
    conflicts: [],
    permissions: [],
    routes: [
      { method: 'GET', pattern: '^/api/quality$' },
      { method: 'POST', pattern: '^/api/pallets/[^/]+/temperature$' },
      { method: 'POST', pattern: '^/api/pallets/[^/]+/quality-release$' },
      { method: 'POST', pattern: '^/api/orders/[^/]+/loading/inspection$' },
      { method: 'POST', pattern: '^/api/orders/[^/]+/loading/release$' },
    ],
    menu: [
      { id: 'quality', label: 'Temperature', slot: 'office' },
    ],
    handheld: [],
    settings: {
      type: 'object',
      properties: {
        min: { type: 'number', title: 'Example lower limit, °C', default: 2 },
        max: { type: 'number', title: 'Example upper limit, °C', default: 6 },
      },
    },
    presets: { 'chilled-dc': true, 'high-value': false, 'home-garage': false, 'small-maker': false, '3pl': false },
    upgrades: [{
      version: 1,
      id: 'food-kept',
      up(db) {
        db.prepare("INSERT INTO module_settings (module, key, value) VALUES ('food', 'kept', '1') ON CONFLICT(module, key) DO NOTHING").run();
      },
    }],
  };
});
