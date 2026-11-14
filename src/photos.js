/*
 * Which photos an item has. The files themselves live next to the database;
 * this only remembers the name, the type and the size.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SortedPhotos = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX = 3;
  const TYPES = ['jpeg', 'png', 'gif', 'webp'];

  function install(Warehouse) {
    Warehouse.prototype.addItemPhoto = function ({ itemNo, id, type, bytes, name } = {}) {
      const item = this.items[itemNo];
      if (!item) throw new Error(`Unknown item ${itemNo}`);
      if (!/^[a-f0-9]{16}$/.test(String(id || ''))) throw new Error('Bad photo');
      if (!TYPES.includes(type)) throw new Error('A photo must be a JPEG, PNG, GIF or WebP');
      this.itemPhotos = this.itemPhotos || {};
      const list = this.itemPhotos[item.itemNo] || [];
      const known = list.find((p) => p.id === id);
      if (known) return known;
      if (list.length >= MAX) throw new Error('An item can have 3 photos');
      const row = { id, type, bytes: Number(bytes) || 0, name: String(name || '').slice(0, 80), t: this.now() };
      this.itemPhotos[item.itemNo] = list.concat(row);
      this.log(`Photo on ${item.itemNo}`);
      return row;
    };
  }

  return { install, MAX };
});
