/*
 * Item photos for the office and the client. The text terminal stays text.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.SortedModules = root.SortedModules || []).push(api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  return {
    id: 'photos',
    name: 'Item photos',
    description: 'One or a few photos on an item, stored as files next to the warehouse database. The office and the client can see them. The text terminal does not. The files stay when this is off.',
    version: 1,
    defaultOn: false,
    dependencies: [],
    conflicts: [],
    permissions: [
      { id: 'photos.read', label: 'See item photos' },
      { id: 'photos.write', label: 'Upload item photos' },
    ],
    routes: [
      { method: 'GET', pattern: '^/api/photos(?:/|$)' },
      { method: '*', pattern: '^/api/items/[^/]+/photos(?:/|$)' },
    ],
    menu: [{ id: 'photos', label: 'Item photos', slot: 'app' }],
    handheld: [],
    settings: null,
    presets: { 'chilled-dc': false, 'high-value': false, 'home-garage': false, 'small-maker': true, '3pl': true },
    upgrades: [{
      version: 1,
      id: 'photos-kept',
      up(db) {
        db.prepare("INSERT INTO module_settings (module, key, value) VALUES ('photos', 'kept', '1') ON CONFLICT(module, key) DO NOTHING").run();
      },
    }],
  };
});
