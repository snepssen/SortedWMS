/*
 * Reach trucks: Auto dispatch, Auto-Shift, aisle limits and one-way aisles.
 * Off for a building worked on foot.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.SortedModules = root.SortedModules || []).push(api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  return {
    id: 'trucks',
    name: 'Reach trucks',
    description: 'Handheld Auto dispatch, Auto-Shift, aisle limits, one-way aisles and block lanes. Off for shelves and bins worked on foot. Trucks and their jobs stay when this is off; nobody is given a new truck job.',
    version: 1,
    dependencies: [],
    conflicts: [],
    permissions: [],
    routes: [
      { method: '*', pattern: '^/api/devices(?:/|$)' },
      { method: 'GET', pattern: '^/api/drivers$' },
      { method: 'POST', pattern: '^/api/shift/start$' },
      { method: 'POST', pattern: '^/api/plan/grouping$' },
      { method: 'POST', pattern: '^/api/plan/dig-out$' },
      { method: 'POST', pattern: '^/api/plan/counts$' },
      { method: 'POST', pattern: '^/api/aisles/[^/]+/direction$' },
    ],
    menu: [
      { id: 'moves', label: 'Truck', slot: 'app' },
    ],
    handheld: [
      { id: 'auto', label: 'Auto' },
      { id: 'shift', label: 'Auto-Shift only' },
      { id: 'pick', label: 'Pick' },
      { id: 'putaway', label: 'Put-away' },
    ],
    settings: {
      type: 'object',
      properties: {
        aisleCap: { type: 'integer', title: 'Reach trucks in one aisle', default: 2 },
        oneWay: { type: 'boolean', title: 'One-way aisles', default: false },
      },
    },
    presets: { 'chilled-dc': true, 'high-value': true, 'home-garage': false, 'small-maker': false, '3pl': true },
    upgrades: [{
      version: 1,
      id: 'trucks-kept',
      up(db) {
        db.prepare("INSERT INTO module_settings (module, key, value) VALUES ('trucks', 'kept', '1') ON CONFLICT(module, key) DO NOTHING").run();
      },
    }],
  };
});
