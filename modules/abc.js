/*
 * ABC cycle counting. Off hides the list, the handheld count card and the
 * approval queue. Counts already taken stay.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.SortedModules = root.SortedModules || []).push(api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  return {
    id: 'abc',
    name: 'ABC cycle counts',
    description: 'Class items or locations A, B or C by how fast they move or by value, count each class on its own rhythm, and hold a blind count for a recount and a supervisor when the variance is over the threshold. The count history stays when this is off.',
    version: 1,
    dependencies: [],
    conflicts: [],
    permissions: [{ id: 'counts.approve', label: 'Approve a cycle-count variance' }],
    routes: [
      { method: 'GET', pattern: '^/api/abc(?:/|$)' },
      { method: 'POST', pattern: '^/api/abc(?:/|$)' },
    ],
    menu: [
      { id: 'abc', label: 'Cycle counts', slot: 'app' },
    ],
    handheld: [],
    settings: {
      type: 'object',
      properties: {
        windowDays: { type: 'integer', title: 'Days of history for the class', default: 30 },
        thresholdQty: { type: 'integer', title: 'Recount when the quantity is off by more than', default: 0 },
        thresholdPercent: { type: 'number', title: 'Or when the percent is over', default: 0 },
      },
    },
    presets: { 'chilled-dc': true, 'high-value': true, 'home-garage': true, 'small-maker': true, '3pl': true },
    upgrades: [{
      version: 1,
      id: 'abc-kept',
      up(db) {
        db.prepare("INSERT INTO module_settings (module, key, value) VALUES ('abc', 'kept', '1') ON CONFLICT(module, key) DO NOTHING").run();
      },
    }],
  };
});