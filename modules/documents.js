/*
 * A4 PDFs: delivery note, pick list, packing list, client statement.
 * The label printers stay on their text rules. See server/documents.js.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.SortedModules = root.SortedModules || []).push(api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  return {
    id: 'documents',
    name: 'A4 documents',
    description: 'Delivery notes, pick lists, packing lists and client statements as A4 PDFs. Dates use the warehouse timezone. Labels stay as they are.',
    version: 1,
    defaultOn: false,
    dependencies: [],
    conflicts: [],
    permissions: [{ id: 'documents.read', label: 'Open A4 documents' }],
    routes: [
      { method: 'GET', pattern: '^/api/documents(?:/|$)' },
    ],
    menu: [{ id: 'documents', label: 'Documents', slot: 'app' }],
    handheld: [],
    settings: null,
    presets: { 'chilled-dc': false, 'high-value': false, 'home-garage': false, 'small-maker': false, '3pl': true },
    upgrades: [{
      version: 1,
      id: 'documents-kept',
      up(db) {
        db.prepare("INSERT INTO module_settings (module, key, value) VALUES ('documents', 'kept', '1') ON CONFLICT(module, key) DO NOTHING").run();
      },
    }],
  };
});
