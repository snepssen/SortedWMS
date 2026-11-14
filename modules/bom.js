/*
 * Bills of materials for client items. Needs Kitting.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.SortedModules = root.SortedModules || []).push(api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  return {
    id: 'bom',
    name: 'Bills of materials',
    description: 'A bill of materials on a client item. A kitting task consumes the components and produces the kit. Lots and serials are used when those modules are on. The recipes stay when this is off.',
    version: 1,
    defaultOn: false,
    dependencies: ['kitting'],
    conflicts: [],
    permissions: [{ id: 'bom.write', label: 'Edit bills of materials and build kits' }],
    routes: [
      { method: '*', pattern: '^/api/boms(?:/|$)' },
    ],
    menu: [{ id: 'bom', label: 'Bills of materials', slot: 'app' }],
    handheld: [],
    settings: null,
    presets: { 'chilled-dc': false, 'high-value': false, 'home-garage': false, 'small-maker': true, '3pl': true },
    upgrades: [{
      version: 1,
      id: 'bom-kept',
      up(db) {
        db.prepare("INSERT INTO module_settings (module, key, value) VALUES ('bom', 'kept', '1') ON CONFLICT(module, key) DO NOTHING").run();
      },
    }],
  };
});
