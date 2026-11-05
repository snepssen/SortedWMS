/*
 * After a split replenishment, the remainder on the source plate is a real
 * move back to storage, not a silent put-back at the moment of the drop.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.SortedModules = root.SortedModules || []).push(api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  return {
    id: 'return-move',
    name: 'Replenishment return',
    description: 'When a split replenishment leaves cases on the source plate, the machine operator gets a task to take that remainder back to the slot it came from, or to another free slot. The task is in the same queue as other work. Switching this off goes back to putting the remainder away at the moment of the drop. Open tasks stay.',
    version: 1,
    dependencies: [],
    conflicts: [],
    permissions: [],
    routes: [
      { method: 'GET', pattern: '^/api/return-moves$' },
    ],
    menu: [],
    handheld: [],
    settings: null,
    presets: { 'chilled-dc': true, 'high-value': true, 'home-garage': false, 'small-maker': false, '3pl': true },
    upgrades: [{
      version: 1,
      id: 'return-move-kept',
      up(db) {
        db.prepare("INSERT INTO module_settings (module, key, value) VALUES ('return-move', 'kept', '1') ON CONFLICT(module, key) DO NOTHING").run();
      },
    }],
  };
});