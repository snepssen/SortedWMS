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
    for (const c of site.clients || []) wh.addClient(c);
    const ownerOf = { YOG: 'CL-DAIRY', CHE: 'CL-CHEESE', PRO: 'CL-PROTEIN' };
    for (const it of site.items || []) wh.addItem({ ...it, clientId: it.clientId || (wh.clients[ownerOf[it.category]] ? ownerOf[it.category] : null) });
    const dims = {
      Y1001: { lengthMm: 1200, widthMm: 800, heightMm: 1400, weightKg: 420 },
      Y1002: { lengthMm: 1200, widthMm: 800, heightMm: 1500, weightKg: 480 },
      C2001: { lengthMm: 1200, widthMm: 800, heightMm: 1200, weightKg: 350 },
      C2005: { lengthMm: 1200, widthMm: 800, heightMm: 1600, weightKg: 600, uom: 'crate' },
      P3001: { lengthMm: 1200, widthMm: 800, heightMm: 1300, weightKg: 390 },
    };
    for (const [itemNo, d] of Object.entries(dims)) if (wh.items[itemNo]) Object.assign(wh.items[itemNo], d);
    for (const loc of site.extraLocations || []) wh.createLocation(loc);
    for (const h of site.holders || []) wh.addHolder(h);
    for (const eq of site.equipment || []) wh.addEquipment(eq);
    for (const f of site.faults || []) wh.reportFault(f, 'setup');
    for (const m of site.maintenance || []) wh.recordMaintenance(m, 'setup');
    for (const kit of site.kits || []) wh.addKit(kit);
    for (const station of site.valStations || []) wh.addValStation(station);
    if (site.preset) wh.applyPreset(site.preset);
    if (site.features) wh.setFeatures(site.features);
    if (site.technical) wh.setTechnical(site.technical);
    for (const plate of site.licensePlates || []) wh.issueSeries({ ...plate, by: 'setup' });
    for (const [name, notes] of Object.entries(site.customers || {})) wh.setCustomerNotes(name, notes);
    for (const tpl of site.templates || []) wh.applyTemplate(wh.selectLocations(tpl.from, tpl.to), tpl.category, { by: 'setup' });
    for (const zone of site.quarantine || []) wh.setQuarantineLocations(wh.selectLocations(zone.from, zone.to), true, zone.reason || 'Site quarantine designation', 'setup');
    if (site.naming) wh.setNaming(site.naming);
    wh.events.length = 0;
    wh.printQueue.length = 0;
    wh.log(`Site "${site.name || 'unnamed'}" created`);
    return wh;
  }

  return { buildWarehouse };
});
