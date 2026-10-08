/*
 * Build a warehouse from the site configuration (layout, categories, cells,
 * block lanes, stations, routes, desks, items, location templates).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('../src/engine'));
  else root.SortedSite = factory(root.SortedWMS);
})(typeof self !== 'undefined' ? self : this, function (Engine) {
  'use strict';
  const { Warehouse } = Engine;

  function buildWarehouse(site, clock) {
    const L = site.layout || {};
    const wh = new Warehouse({
      aisles: L.aisles, bays: L.bays, levels: L.levels, positions: L.positions, outLanes: L.outLanes,
      blocks: site.blocks || [], stations: site.stations || [], categories: site.categories, clock, config: site.config || {},
    });
    for (const [aisle, cell] of Object.entries(site.cells || {})) wh.setAisleCell(aisle, cell);
    for (const [aisle, end] of Object.entries(site.aisleEntry || {})) wh.setAisleDirection(aisle, end);
    for (const r of site.routes || []) wh.addRoute(r);
    for (const d of site.desks || []) wh.addDesk(d.id, d);
    for (const it of site.items || []) wh.addItem(it);
    for (const tpl of site.templates || []) wh.applyTemplate(wh.selectLocations(tpl.from, tpl.to), tpl.category, { by: 'setup' });
    for (const zone of site.quarantine || []) wh.setQuarantineLocations(wh.selectLocations(zone.from, zone.to), true, zone.reason || 'Site quarantine designation', 'setup');
    if (site.naming) wh.setNaming(site.naming);
    wh.events.length = 0;
    wh.log(`Site "${site.name || 'unnamed'}" created`);
    return wh;
  }

  return { buildWarehouse };
});
