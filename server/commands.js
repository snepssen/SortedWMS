/*
 * Every change to the warehouse goes through one of these commands. The
 * server journals each one (time, operator, arguments) so the journal is the
 * audit trail, and replaying it rebuilds the exact state after a restart.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SortedCommands = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const req = (v, name) => {
    if (v === undefined || v === null || v === '') throw new Error(`${name} is required`);
    return v;
  };

  const COMMANDS = {
    // Handhelds and desks
    addTruck: (wh, a) => wh.addTruck(req(a.id, 'id'), { mode: a.mode || 'auto', categories: a.categories || null }),
    setTruckMode: (wh, a) => wh.setTruckMode(req(a.id, 'id'), req(a.mode, 'mode'), { orderId: a.orderId || null }),
    setTruckCategories: (wh, a) => wh.setTruckCategories(req(a.id, 'id'), a.categories || null),
    scan: (wh, a) => wh.scan(req(a.id, 'id'), req(a.code, 'code')),
    confirmQty: (wh, a) => wh.confirmQty(req(a.id, 'id'), a.qty == null ? null : a.qty),
    finishReceiving: (wh, a) => wh.finishReceiving(req(a.id, 'id')),
    reportProblem: (wh, a) => wh.reportProblem(req(a.id, 'id'), req(a.reason, 'reason')),
    pendingAction: (wh, a) => wh.pendingAction(req(a.id, 'id'), req(a.action, 'action')),
    deskStart: (wh, a) => wh.deskStart(req(a.id, 'id'), a.deliveryId || null),
    deskEnter: (wh, a) => wh.deskEnter(req(a.id, 'id'), req(a.field, 'field'), req(a.value, 'value')),
    stationScan: (wh, a) => wh.stationScan(req(a.id, 'id'), req(a.code, 'code')),

    // Office
    setConfig: (wh, a) => wh.setConfig(a.patch || {}),
    setUrgent: (wh, a) => wh.setUrgent(req(a.taskId, 'taskId'), Boolean(a.urgent)),
    cancelTask: (wh, a) => wh.cancelTask(req(a.taskId, 'taskId')),
    releaseTask: (wh, a) => wh.releaseTask(req(a.taskId, 'taskId')),
    unblockLocation: (wh, a) => wh.unblockLocation(req(a.code, 'code')),
    setPalletStatus: (wh, a) => wh.setPalletStatus(req(a.sscc, 'sscc'), req(a.status, 'status'), a.reason || null),
    recordTemperature: (wh, a, by) => wh.recordTemperature(req(a.sscc, 'sscc'), a.temperature, a.min, a.max, req(a.reason, 'reason'), by),
    releaseQualityHold: (wh, a, by) => wh.releaseQualityHold(req(a.sscc, 'sscc'), req(a.reason, 'reason'), by),
    placeBatchHold: (wh, a, by) => wh.placeBatchHold(req(a.itemNo, 'itemNo'), req(a.batch, 'batch'), req(a.reason, 'reason'), by),
    releaseBatchHold: (wh, a, by) => wh.releaseBatchHold(req(a.itemNo, 'itemNo'), req(a.batch, 'batch'), req(a.reason, 'reason'), by),
    setQuarantineLocations: (wh, a, by) => wh.setQuarantineLocations(wh.selectLocations(req(a.from, 'from'), req(a.to, 'to')), a.enabled, req(a.reason, 'reason'), by),
    requestQuarantine: (wh, a, by) => wh.requestQuarantine(req(a.sscc, 'sscc'), req(a.reason, 'reason'), by),
    releaseQuarantine: (wh, a, by) => wh.releaseQuarantine(req(a.sscc, 'sscc'), req(a.reason, 'reason'), by),
    allowShortShip: (wh, a) => wh.allowShortShip(req(a.sscc, 'sscc')),
    setMinShipDays: (wh, a) => wh.setMinShipDays(req(a.itemNo, 'itemNo'), Number(a.days)),
    transferPallet: (wh, a, by) => wh.transferPallet(req(a.sscc, 'sscc'), wh.resolve(req(a.to, 'to')), { by }),
    applyTemplate: (wh, a, by) => wh.applyTemplate(wh.selectLocations(req(a.from, 'from'), req(a.to, 'to')), a.category || null, { by }),
    setAisleDirection: (wh, a) => wh.setAisleDirection(req(a.aisle, 'aisle'), req(a.enterFrom, 'enterFrom')),
    setAisleCell: (wh, a) => wh.setAisleCell(req(a.aisle, 'aisle'), req(a.cell, 'cell')),
    setNaming: (wh, a) => wh.setNaming(req(a.show, 'show')),
    planGrouping: (wh) => wh.planGrouping(),
    planDigOut: (wh) => wh.planDigOut(),
    startProcess: (wh, a) => wh.startProcess(req(a.sscc, 'sscc'), req(a.route, 'route')),

    // Orders and deliveries
    addOrder: (wh, a) => wh.addOrder({ id: String(req(a.id, 'id')), customer: req(a.customer, 'customer'), lane: req(a.lane, 'lane'), lines: req(a.lines, 'lines'), verifyLoading: a.verifyLoading === undefined ? false : a.verifyLoading }),
    startLoading: (wh, a, by) => wh.startLoading(String(req(a.id, 'id')), req(a.trailer, 'trailer'), by, { inspectionPolicy: a.inspectionPolicy === undefined ? null : a.inspectionPolicy }),
    recordTrailerInspection: (wh, a, by) => wh.recordTrailerInspection(String(req(a.id, 'id')), a, by),
    releaseTrailerHold: (wh, a, by) => wh.releaseTrailerHold(String(req(a.id, 'id')), req(a.reason, 'reason'), by),
    scanLoading: (wh, a, by) => wh.scanLoading(String(req(a.id, 'id')), req(a.device, 'device'), req(a.code, 'code'), a.unload === undefined ? false : a.unload, by),
    shipOrder: (wh, a, by) => wh.shipOrder(String(req(a.id, 'id')), { seal: a.seal }, by),
    addDelivery: (wh, a) => wh.addDelivery({ id: String(req(a.id, 'id')), supplier: req(a.supplier, 'supplier'), category: req(a.category, 'category'), pallets: a.pallets, list: a.list || null, at: a.at || 'dock' }),

    // Master data and imports
    addItem: (wh, a) => wh.addItem(a),
    importItems: (wh, a) => (a.rows || []).map((r) => (wh.items[r.itemNo] ? null : wh.addItem(r))).filter(Boolean).length,
    importLocations: (wh, a) => wh.importLocations(a.rows || []),
    // Orders from a spreadsheet: one row per line (orderId, customer, lane, itemNo, pallets, process).
    // Rows of one order are added together; an order that fails is listed and the rest still go in.
    importOrders: (wh, a) => {
      const out = { added: 0, errors: [] };
      const orders = new Map();
      for (const r of a.rows || []) {
        const id = String(r.orderId || r.order || '').trim();
        if (!id) { out.errors.push('A row without an order number'); continue; }
        if (!orders.has(id)) orders.set(id, { id, customer: r.customer, lane: r.lane, lines: [], verifyLoading: /^(1|true|yes|ja)$/i.test(String(r.verifyLoading || '')) });
        const line = { itemNo: String(r.itemNo || r.item || '').trim(), pallets: Number(r.pallets) || 1 };
        if (r.process) line.process = String(r.process).trim();
        orders.get(id).lines.push(line);
      }
      for (const o of orders.values()) {
        try { wh.addOrder(o); out.added++; } catch (e) { out.errors.push(`${o.id}: ${e.message}`); }
      }
      return out;
    },
    importStock: (wh, a) => {
      const out = { added: 0, errors: [] };
      for (const r of a.rows || []) {
        try { wh.stockPallet(wh.resolve(r.code), r); out.added++; } catch (e) { out.errors.push(`${r.sscc || r.code}: ${e.message}`); }
      }
      wh.planRelocations();
      wh.dispatch();
      return out;
    },

    // Clock tick: dwell timers, waiting trucks, escalations
    tick: (wh) => wh.dispatch(),
  };

  return { COMMANDS };
});
