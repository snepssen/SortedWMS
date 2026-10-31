/*
 * The WMS API as plain functions: views for the screens and one route per
 * action. The Node server puts it behind HTTP; on GitHub Pages the same code
 * runs in the browser against a local journal (server/local.js).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('../src/engine'));
  else root.SortedApi = factory(root.SortedWMS);
})(typeof self !== 'undefined' ? self : this, function (Engine) {
  'use strict';
  const { TASK_TYPES, TRUCK_MODES, SHIFT_REASONS, RECEIVE_FIELDS, FIELD_LABELS, SCAN_COMMANDS, COMMAND_PREFIX } = Engine;

  // ---- Views: what the pages need, without engine internals --------------------

  // A location as the screens show it: AA03C2 or 38-02-0-10 (the naming setting), stations by name.
  const placeName = (wh, code) => (code && wh.locations[code] ? (wh.locations[code].kind === 'rack' ? wh.label(code) : wh._placeName(code)) : code);

  function palletView(wh, p) {
    if (!p) return null;
    const item = wh.items[p.itemNo];
    return {
      sscc: p.sscc, itemNo: p.itemNo, name: item && item.name, category: item && item.category, batch: p.batch, expiry: p.expiry,
      qty: p.qty, status: p.status, blockReason: p.blockReason, shipState: wh.shipState(p), loc: p.loc, locName: placeName(wh, p.loc),
      qualityHold: p.qualityHold || null, qualityHistory: p.qualityHistory || [],
      recallHold: wh.batchHoldFor(p), holdReason: wh.holdReason(p),
      quarantine: p.quarantine || null, quarantineHistory: (p.quarantineHistory || []).map((e) => ({ ...e, locationName: placeName(wh, e.location) })),
      orderId: p.orderId, inProcess: p.proc ? p.proc.route : null,
    };
  }

  function taskView(wh, t) {
    if (!t) return null;
    return {
      id: t.id, type: t.type, typeLabel: TASK_TYPES[t.type].label, status: t.status, category: t.category, sscc: t.sscc,
      from: t.from, fromName: placeName(wh, t.from), to: t.to, toName: placeName(wh, t.to),
      step: t.step, orderId: t.orderId, deliveryId: t.deliveryId, truckId: t.truckId, urgent: wh.isUrgent(t),
      why: t.type === 'SHIFT' ? SHIFT_REASONS[t.reason] : t.type === 'MOVE' ? t.note : t.type === 'COUNT' ? 'Nothing else to do: a quick stock count' : t.dispatchReason,
      labelCode: t.labelCode || null, alert: t.alert, heldReason: t.heldReason, createdAt: t.createdAt,
    };
  }

  // A stock check answer as the screens show it: a title and lines, codes in the chosen naming.
  function lookupView(wh, r) {
    return { kind: r.kind, title: wh.display(r.title), lines: r.lines.map((l) => wh.display(l)), text: wh.display(r.text), belongsAt: r.belongsAt ? placeName(wh, r.belongsAt) : null };
  }

  function deviceView(wh, id) {
    const d = wh.trucks[id] || wh.desks[id];
    if (!d) return null;
    const ins = wh.trucks[id] ? wh.instruction(id) : { kind: d.taskId ? 'receive' : 'idle' };
    const task = d.taskId ? wh.tasks[d.taskId] : null;
    const out = {
      id, kind: d.kind || 'truck', mode: d.mode, operator: d.operator || null, duty: d.duty || null, equipment: d.equipment || null, modes: Object.entries(TRUCK_MODES).map(([k, v]) => ({ id: k, label: v.label })),
      categories: d.categories, message: d.message ? { ok: d.message.ok, text: wh.display(d.message.text) } : null, stats: d.stats,
      instruction: { kind: ins.kind, task: taskView(wh, task) },
    };
    const I = out.instruction;
    if (ins.target) {
      I.target = ins.target;
      I.targetName = placeName(wh, ins.target);
      const sp = wh.spoken(ins.target);
      if (sp && wh.naming.show === 'row') I.spoken = sp;
      if (wh.trucks[id]) I.enterFrom = wh.entryFor(d, ins.target);
      // Printed on the location label, never shown on the handheld: the demo kit's label wall needs it.
      I.targetCheck = wh.checkDigit(ins.target);
    }
    if (ins.pallet) I.pallet = palletView(wh, ins.pallet);
    // The customer's requirements come with every job on their order.
    const order = task && task.orderId && wh.orders[task.orderId];
    if (order) I.customer = { name: order.customer, notes: wh.customerNotes(order.customer) };
    if (ins.aisle) I.aisle = ins.aisle;
    if (task && task.type === 'RECEIVE') {
      const del = wh.deliveries[task.deliveryId];
      I.kind = 'receive';
      I.delivery = { id: del.id, supplier: del.supplier, expected: del.expected, received: del.received.length, hasList: Boolean(del.list) };
      I.field = RECEIVE_FIELDS.find((f) => !task.draft[f]) || null;
      I.fields = RECEIVE_FIELDS.map((f) => ({ id: f, label: FIELD_LABELS[f], value: task.draft[f] || null }));
      I.defaultQty = task.draft.item ? wh.items[task.draft.item].palletQty : null;
      if (wh.desks[id]) I.callout = wh.deskCallout(id);
    }
    if (ins.kind === 'pick-order') {
      I.order = ins.order ? { id: ins.order.id, customer: ins.order.customer, status: ins.order.status } : null;
      out.openOrders = Object.values(wh.orders).filter((o) => o.status === 'open' || o.status === 'picking')
        .filter((o) => Object.values(wh.tasks).some((t) => t.orderId === o.id && t.status === 'open' && (!d.categories || d.categories.includes(t.category))))
        .map((o) => ({ id: o.id, customer: o.customer, lane: o.lane, pallets: o.lines.reduce((s, l) => s + l.allocated.length, 0) }));
    }
    if (ins.kind === 'count') {
      I.step = ins.step;
      // Blind count: the handheld doesn't show this. The demo kit's label wall needs it to show the right label.
      const loc = wh.locations[ins.target];
      I.expectedSscc = loc && loc.sscc ? loc.sscc : null;
    }
    if (ins.kind === 'transfer') I.pallet = palletView(wh, ins.pallet);
    if (ins.kind === 'find' && ins.result) I.result = lookupView(wh, ins.result);
    if (ins.armed) I.armed = ins.armed;
    if (ins.pending) I.pending = { via: ins.pending.via, pallet: palletView(wh, ins.pending.pallet), ...lookupView(wh, ins.pending.info) };
    return out;
  }

  function summary(wh) {
    const tasks = Object.values(wh.tasks);
    return {
      openJobs: tasks.filter((t) => t.status === 'open').length,
      activeJobs: tasks.filter((t) => t.status === 'active').length,
      heldJobs: tasks.filter((t) => t.status === 'held' && !t.replacedBy).length,
      trucks: Object.values(wh.trucks).map((t) => ({ id: t.id, mode: t.mode, categories: t.categories, task: taskView(wh, wh.tasks[t.taskId]) })),
      orders: Object.values(wh.orders).filter((o) => o.status !== 'shipped').length,
      pallets: Object.values(wh.pallets).filter((p) => p.loc).length,
      lost: wh.lostPallets().length,
      cantShip: Object.values(wh.pallets).filter((p) => p.loc && wh.shipState(p) !== 'ok').length,
      inProcess: Object.values(wh.pallets).filter((p) => p.proc).length,
      categories: wh.categories,
      naming: wh.naming.show,
      config: wh.config,
      jobOrderNow: { window: wh.activeWindow(), priority: wh.activePriority(), localTime: wh.localTime() },
    };
  }

  // ---- Routes ----------------------------------------------------------------------

  /**
   * handle(method, url, body, by) -> { status, body }. `store` needs wh, exec(op, args, by)
   * and journal(filter); `printers` needs flush(queue) and results.
   */
  function locationView(wh, l) {
    const occupied = l.kind === 'rack' && !l.structural ? (l.sscc ? 1 : 0) : (l.pallets ? l.pallets.length : 0);
    return {
      code: l.code, kind: l.structural && l.kind === 'rack' ? 'rack' : l.kind, name: l.name || null,
      structural: Boolean(l.structural), custom: Boolean(l.custom),
      zone: l.zone || null, aisle: l.aisle || null, rack: l.rack || null, level: l.level ?? null, bin: l.bin || null,
      parent: l.parent || null, category: l.category || null, blocked: Boolean(l.blocked),
      capacity: l.capacity || null, occupied, sscc: l.sscc || null, virtual: Boolean(l.virtual), role: l.role || null,
      replenishment: l.replenishment || null,
    };
  }

  function holderView(wh, h) {
    return { ...h, contents: (h.contents || []).map((c) => ({ ...c, name: c.itemNo && wh.items[c.itemNo] ? wh.items[c.itemNo].name : null })) };
  }

  function csv(rows) {
    return rows.map((r) => r.map((c) => `"${String(c == null ? '' : c).replace(/"/g, '""')}"`).join(',')).join('\n');
  }

  function createApi({ store, printers, hardware }) {
    const wh = () => (store.warehouse ? store.warehouse(store.siteId) : store.wh);
    const routes = [];
    const on = (method, pattern, fn) => routes.push({ method, re: new RegExp(`^${pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`), fn });
    const run = (op, args, by) => {
      const result = store.exec(op, args, by);
      printers.flush(wh().printQueue);
      return result;
    };
    let currentActor = null;
    const ownClient = () => (currentActor && currentActor.role === 'client' ? String(currentActor.clientId || '').toUpperCase() : null);
    const deny = () => ({ status: 403, error: 'That belongs to another client' });

    // Reads
    on('GET', '/api/summary', () => summary(wh()));
    on('GET', '/api/devices', () => [...Object.keys(wh().trucks), ...Object.keys(wh().desks)].map((id) => deviceView(wh(), id)));
    on('GET', '/api/scan-commands', () => Object.entries(SCAN_COMMANDS).map(([k, c]) => ({ code: COMMAND_PREFIX + k, label: c.label, group: c.group, confirm: Boolean(c.confirm) })));
    on('GET', '/api/devices/:id', ({ id }) => deviceView(wh(), id) || { status: 404, error: `No device ${id}` });
    on('GET', '/api/tasks', (_, q) => Object.values(wh().tasks).filter((t) => (q.status ? t.status === q.status : ['open', 'active', 'held'].includes(t.status))).map((t) => taskView(wh(), t)));
    on('GET', '/api/orders', () => Object.values(wh().orders).filter((o) => { const own = ownClient(); return own == null || o.clientId === own; }).map((o) => ({ ...o,
      trailerReadiness: wh().trailerReadiness(o.id),
      shippingHolds: o.status === 'shipped' ? [] : o.lines.flatMap((l) => l.allocated).map((s) => wh().pallets[s]).filter((p) => wh().shipState(p) !== 'ok').map((p) => ({ sscc: p.sscc, reason: wh().holdReason(p) || wh().shipState(p) })),
    })));
    on('GET', '/api/orders/:id/loading', ({ id }) => {
      id = decodeURIComponent(id);
      const o = wh().orders[id];
      if (!o) return { status: 404, error: `No order ${id}` };
      const pallets = o.lines.flatMap((l) => l.allocated).map((s) => palletView(wh(), wh().pallets[s]));
      return { id: o.id, customer: o.customer, status: o.status, lane: o.lane, verifyLoading: o.verifyLoading || false, loading: o.loading || null, trailerReadiness: wh().trailerReadiness(o.id),
        total: o.lines.reduce((n, l) => n + l.pallets, 0), loaded: pallets.filter((p) => o.loading && p.loc === o.loading.location).length, pallets };
    });
    on('GET', '/api/deliveries', () => Object.values(wh().deliveries).map((d) => ({ ...d, list: undefined, hasList: Boolean(d.list) })));
    on('GET', '/api/items', () => { const own = ownClient(); return Object.values(wh().items).filter((i) => own == null || i.clientId === own); });
    on('GET', '/api/stock', () => { const own = ownClient(); return wh().stockSummary().filter((r) => own == null || (r.item && r.item.clientId === own)).map((r) => ({ ...r, next: palletView(wh(), r.next) })); });
    on('GET', '/api/quality', () => Object.values(wh().pallets).filter((p) => p.qualityHistory && p.qualityHistory.length).map((p) => palletView(wh(), p)));
    const recallView = (itemNo, batch) => {
      const r = wh().batchRecall(itemNo, batch);
      return { ...r, inStock: r.inStock.map((p) => palletView(wh(), p)) };
    };
    on('GET', '/api/recalls', () => (wh().batchHolds || []).map((h) => recallView(h.itemNo, h.batch)));
    on('GET', '/api/recalls/preview', (_, q) => recallView(q.itemNo, q.batch));
    on('GET', '/api/quarantine', () => ({
      locations: Object.values(wh().locations).filter((l) => l.quarantine).map((l) => ({ code: l.code, name: placeName(wh(), l.code), category: l.category, blocked: l.blocked, sscc: l.sscc, reservedBy: l.reservedBy || null })),
      pallets: Object.values(wh().pallets).filter((p) => p.quarantine || p.quarantineHistory?.length).map((p) => {
        const move = wh()._liveTaskFor(p.sscc);
        return { ...palletView(wh(), p), move: taskView(wh(), move), waitingForSpace: Boolean(move && move.status === 'open' && move.autoSlot && !wh()._findSlot(p, move.from)) };
      }),
      history: wh().quarantineZoneHistory || [],
    }));
    on('GET', '/api/lookup/:code', ({ code }) => {
      const r = wh().lookup(decodeURIComponent(code));
      if (!r) return { status: 404, error: `${decodeURIComponent(code)} is not a pallet, location or item` };
      return { ...lookupView(wh(), r), pallet: palletView(wh(), r.pallet), pallets: (r.pallets || []).map((p) => palletView(wh(), p)), location: r.location && { code: r.location.code, name: wh().label(r.location.code), kind: r.location.kind, category: r.location.category, blocked: r.location.blocked, check: wh().checkDigit(r.location.code) } };
    });
    // Blocked pallets (damaged, expired on arrival, blocked by the office) and blocked locations: what the coordinator can release.
    on('GET', '/api/blocked', () => ({
      pallets: Object.values(wh().pallets).filter((p) => p.status === 'blocked').map((p) => palletView(wh(), p)),
      locations: Object.values(wh().locations).filter((l) => l.blocked).map((l) => ({ code: l.code, name: placeName(wh(), l.code), kind: l.kind, sscc: l.sscc || null })),
    }));
    on('GET', '/api/lost', () => wh().lostPallets().map((p) => ({ ...palletView(wh(), p), missingFrom: p.missingFrom, missingFromName: placeName(wh(), p.missingFrom) })));
    // Stock counts: the open count jobs, the latest results, and how often the system was right.
    on('GET', '/api/counts', () => {
      const counts = (wh().counts || []).slice(0, 200);
      const open = Object.values(wh().tasks).filter((t) => t.type === 'COUNT' && ['open', 'active', 'held'].includes(t.status));
      return {
        open: open.length,
        done: (wh().counts || []).length,
        accuracy: counts.length ? Math.round((100 * counts.filter((c) => c.result === 'ok').length) / counts.length) : null,
        results: counts.map((c) => ({ ...c, name: placeName(wh(), c.code) })),
      };
    });
    on('GET', '/api/drivers', () => wh().driverStats());
    on('GET', '/api/customers', () => Object.entries(wh().customers || {}).map(([name, c]) => ({ name, notes: c.notes })));
    on('GET', '/api/transfers', () => (wh().transfers || []).slice(0, 200).map((t) => ({ ...t, fromName: placeName(wh(), t.from), toName: placeName(wh(), t.to) })));
    on('GET', '/api/trace/:batch', ({ batch }) => {
      const r = wh().trace(decodeURIComponent(batch));
      return { ...r, inStock: r.inStock.map((p) => palletView(wh(), p)) };
    });
    on('GET', '/api/template/preview', (_, q) => {
      const codes = wh().selectLocations(q.from, q.to);
      return { ...wh().previewTemplate(codes, q.category || null), first: codes.slice(0, 3).map((c) => wh().label(c)), last: codes.slice(-3).map((c) => wh().label(c)) };
    });
    on('GET', '/api/stations', () => Object.values(wh().stations).map((st) => ({ id: st.id, name: st.name, machine: st.machine, minutes: st.minutes, dwell: st.dwell, capacity: st.capacity })));
    on('GET', '/api/routes', () => Object.values(wh().routes).map((r) => ({ id: r.id, name: r.name, steps: r.steps })));
    on('GET', '/api/stations/:id', ({ id }) => {
      const v = wh().stationView(id);
      const pv = (p) => palletView(wh(), p);
      return { station: v.station, queue: v.queue.map(pv), working: v.working.map((w) => ({ ...w, pallet: pv(w.pallet) })), dwelling: v.dwelling.map((d) => ({ ...d, pallet: pv(d.pallet) })), waiting: v.waiting.map(pv), coming: v.coming };
    });
    on('GET', '/api/process-log', () => wh().processLog.slice(0, 200));
    on('GET', '/api/events', () => wh().events.slice(0, 200).map((e) => ({ ...e, text: wh().display(e.text) })));
    on('GET', '/api/journal', (_, q) => store.journal({ limit: q.limit, op: q.op, by: q.by, before: q.before }).map((row) => ({ ...row, local: wh().formatLocal ? wh().formatLocal(row.t) : null })));
    on('GET', '/api/printers', () => (printers.list ? printers.list() : []));
    on('GET', '/api/printers/:name/status', ({ name }) => (printers.status ? printers.status(decodeURIComponent(name)) : { status: 404, error: 'No printers here' }));
    on('GET', '/api/print-queue', () => ({ jobs: wh().printQueue.slice(0, 50).map((j) => ({ id: j.id, printer: j.printer, at: j.at, label: j.label })), results: printers.results.slice(0, 50) }));

    // Handheld and desk actions
    on('POST', '/api/devices', (_, q, b, by) => run('addTruck', b, by));
    on('POST', '/api/devices/:id/mode', ({ id }, q, b, by) => run('setTruckMode', { id, mode: b.mode, orderId: b.orderId }, by));
    on('POST', '/api/devices/:id/categories', ({ id }, q, b, by) => run('setTruckCategories', { id, categories: b.categories }, by));
    on('POST', '/api/devices/:id/scan', ({ id }, q, b, by) => run('scan', { id, code: b.code }, by));
    on('POST', '/api/devices/:id/qty', ({ id }, q, b, by) => run('confirmQty', { id, qty: b.qty }, by));
    on('POST', '/api/devices/:id/finish-receiving', ({ id }, q, b, by) => run('finishReceiving', { id }, by));
    on('POST', '/api/devices/:id/problem', ({ id }, q, b, by) => run('reportProblem', { id, reason: b.reason }, by));
    on('POST', '/api/devices/:id/pending', ({ id }, q, b, by) => run('pendingAction', { id, action: b.action }, by));
    on('POST', '/api/desks/:id/start', ({ id }, q, b, by) => run('deskStart', { id, deliveryId: b.deliveryId }, by));
    on('POST', '/api/desks/:id/enter', ({ id }, q, b, by) => run('deskEnter', { id, field: b.field, value: b.value }, by));
    on('POST', '/api/stations/:id/scan', ({ id }, q, b, by) => run('stationScan', { id, code: b.code }, by));

    // Office actions
    on('POST', '/api/quarantine/locations', (_, q, b, by) => run('setQuarantineLocations', b, by));
    on('POST', '/api/quarantine/request', (_, q, b, by) => run('requestQuarantine', b, by));
    on('POST', '/api/quarantine/release', (_, q, b, by) => run('releaseQuarantine', b, by));
    on('POST', '/api/recalls', (_, q, b, by) => run('placeBatchHold', { itemNo: b.itemNo, batch: b.batch, reason: b.reason }, by));
    on('POST', '/api/recalls/release', (_, q, b, by) => run('releaseBatchHold', { itemNo: b.itemNo, batch: b.batch, reason: b.reason }, by));
    on('POST', '/api/config', (_, q, b, by) => run('setConfig', { patch: b }, by));
    on('POST', '/api/tasks/:taskId/urgent', ({ taskId }, q, b, by) => run('setUrgent', { taskId: Number(taskId), urgent: b.urgent !== false }, by));
    on('POST', '/api/tasks/:taskId/cancel', ({ taskId }, q, b, by) => run('cancelTask', { taskId: Number(taskId) }, by));
    on('POST', '/api/tasks/:taskId/release', ({ taskId }, q, b, by) => run('releaseTask', { taskId: Number(taskId) }, by));
    on('POST', '/api/transfer', (_, q, b, by) => run('transferPallet', b, by));
    on('POST', '/api/template/apply', (_, q, b, by) => {
      const r = run('applyTemplate', b, by);
      return { ...r, moves: Array.isArray(r.moves) ? r.moves.length : r.moves };
    });
    on('POST', '/api/locations/:code/unblock', ({ code }, q, b, by) => run('unblockLocation', { code: wh().resolve(decodeURIComponent(code)) }, by));
    on('POST', '/api/pallets/:sscc/status', ({ sscc }, q, b, by) => run('setPalletStatus', { sscc, status: b.status, reason: b.reason }, by));
    on('POST', '/api/pallets/:sscc/temperature', ({ sscc }, q, b, by) => run('recordTemperature', { sscc, temperature: b.temperature, min: b.min, max: b.max, reason: b.reason }, by));
    on('POST', '/api/pallets/:sscc/quality-release', ({ sscc }, q, b, by) => run('releaseQualityHold', { sscc, reason: b.reason }, by));
    on('POST', '/api/pallets/:sscc/allow-short', ({ sscc }, q, b, by) => run('allowShortShip', { sscc }, by));
    on('POST', '/api/pallets/:sscc/process', ({ sscc }, q, b, by) => run('startProcess', { sscc, route: b.route }, by));
    on('POST', '/api/items/:itemNo/min-ship-days', ({ itemNo }, q, b, by) => run('setMinShipDays', { itemNo, days: b.days }, by));
    on('POST', '/api/orders', (_, q, b, by) => run('addOrder', b, by));
    on('POST', '/api/orders/:id/loading', ({ id }, q, b, by) => run('startLoading', { id: decodeURIComponent(id), trailer: b.trailer, inspectionPolicy: b.inspectionPolicy }, by));
    on('POST', '/api/orders/:id/loading/inspection', ({ id }, q, b, by) => run('recordTrailerInspection', { ...b, id: decodeURIComponent(id) }, by));
    on('POST', '/api/orders/:id/loading/release', ({ id }, q, b, by) => run('releaseTrailerHold', { id: decodeURIComponent(id), reason: b.reason }, by));
    on('POST', '/api/orders/:id/loading/scan', ({ id }, q, b, by) => run('scanLoading', { ...b, id: decodeURIComponent(id) }, by));
    on('POST', '/api/orders/:id/ship', ({ id }, q, b, by) => run('shipOrder', { id: decodeURIComponent(id), seal: b.seal }, by));
    on('POST', '/api/deliveries', (_, q, b, by) => run('addDelivery', b, by));
    on('POST', '/api/aisles/:aisle/direction', ({ aisle }, q, b, by) => run('setAisleDirection', { aisle, enterFrom: b.enterFrom }, by));
    on('POST', '/api/aisles/:aisle/cell', ({ aisle }, q, b, by) => run('setAisleCell', { aisle, cell: b.cell }, by));
    on('POST', '/api/naming', (_, q, b, by) => run('setNaming', { show: b.show }, by));
    on('POST', '/api/plan/grouping', (_, q, b, by) => run('planGrouping', {}, by));
    on('POST', '/api/shift/start', (_, q, b, by) => run('startShift', {}, by));
    on('POST', '/api/customers', (_, q, b, by) => run('setCustomerNotes', { customer: b.customer, notes: b.notes }, by));
    on('POST', '/api/workload', (_, q, b, by) => run('dropWorkload', { seed: Number(b.seed) || (Date.now() % 1e9) + 1, picks: Number(b.picks) || 0, inbound: Number(b.inbound) || 0 }, by));
    on('POST', '/api/plan/counts', (_, q, b, by) => run('planCounts', { from: b.from || null, to: b.to || null, limit: b.limit }, by));
    on('POST', '/api/plan/dig-out', (_, q, b, by) => run('planDigOut', {}, by));
    on('POST', '/api/import/items', (_, q, b, by) => run('importItems', { rows: b.rows || b }, by));
    on('POST', '/api/import/locations', (_, q, b, by) => run('importLocations', { rows: b.rows || b }, by));
    on('POST', '/api/import/orders', (_, q, b, by) => run('importOrders', { rows: b.rows || b }, by));
    on('POST', '/api/import/stock', (_, q, b, by) => run('importStock', { rows: b.rows || b }, by));

    // Clients, items, locations, holders, labels, equipment, reports.
    const clientView = (c) => {
      const items = Object.values(wh().items).filter((i) => i.clientId === c.id);
      const stock = wh().stockForClient(c.id).filter((p) => p.loc && p.status !== 'shipped');
      return { ...c, items: items.length, pallets: stock.length, qty: stock.reduce((n, p) => n + (p.qty || 0), 0), tariffVersions: wh().decorateTariff(c) };
    };
    on('GET', '/api/clients', (_, q) => { const own = ownClient(); return Object.values(wh().clients || {}).filter((c) => (own == null || c.id === own) && (q.archived === '1' || c.status !== 'archived')).map(clientView); });
    on('GET', '/api/clients/:id', ({ id }) => {
      const c = wh().clients[decodeURIComponent(id).toUpperCase()];
      if (!c) return { status: 404, error: `Unknown client ${id}` };
      const own = ownClient();
      if (own != null && c.id !== own) return deny();
      return { ...clientView(c), itemList: Object.values(wh().items).filter((i) => i.clientId === c.id), stock: wh().stockForClient(c.id).filter((p) => p.status !== 'shipped').map((p) => palletView(wh(), p)) };
    });
    on('POST', '/api/clients', (_, q, b, by) => run('addClient', b, by));
    on('POST', '/api/clients/:id', ({ id }, q, b, by) => run('updateClient', { ...b, id: decodeURIComponent(id) }, by));
    on('POST', '/api/clients/:id/archive', ({ id }, q, b, by) => run('archiveClient', { id: decodeURIComponent(id) }, by));
    on('POST', '/api/clients/:id/restore', ({ id }, q, b, by) => run('restoreClient', { id: decodeURIComponent(id) }, by));
    on('POST', '/api/items', (_, q, b, by) => {
      const own = ownClient();
      const body = { ...b };
      if (own != null) {
        if (!own) return deny();
        body.clientId = own;
        if (wh().config && wh().config.itemApproval) body.status = 'pending';
      }
      return run('addItem', body, by);
    });
    on('POST', '/api/items/:itemNo', ({ itemNo }, q, b, by) => {
      const key = decodeURIComponent(itemNo);
      const own = ownClient();
      const item = wh().items[key];
      if (own != null && (!item || item.clientId !== own)) return deny();
      const body = { ...b, itemNo: key };
      if (own != null) delete body.clientId;
      return run('updateItem', body, by);
    });
    on('POST', '/api/items/:itemNo/archive', ({ itemNo }, q, b, by) => {
      const key = decodeURIComponent(itemNo);
      const own = ownClient();
      const item = wh().items[key];
      if (own != null && (!item || item.clientId !== own)) return deny();
      return run('archiveItem', { itemNo: key }, by);
    });
    on('POST', '/api/items/:itemNo/approve', ({ itemNo }, q, b, by) => run('approveItem', { itemNo: decodeURIComponent(itemNo) }, by));
    on('POST', '/api/items/:itemNo/remove', ({ itemNo }, q, b, by) => run('removeItem', { itemNo: decodeURIComponent(itemNo) }, by));
    on('GET', '/api/locations', (_, q) => {
      let list = Object.values(wh().locations);
      if (q.kind) list = list.filter((l) => l.kind === q.kind || (q.kind === 'rack' && l.structural));
      if (q.custom === '1') list = list.filter((l) => l.custom || l.structural || l.capacity);
      if (q.q) {
        const s = String(q.q).toLowerCase();
        list = list.filter((l) => `${l.code} ${l.name || ''} ${l.kind}`.toLowerCase().includes(s));
      }
      const total = list.length;
      const limit = Math.min(Number(q.limit) || 200, 2000);
      return { total, locations: list.slice(0, limit).map((l) => locationView(wh(), l)) };
    });
    on('POST', '/api/locations', (_, q, b, by) => run('createLocation', b, by));
    on('POST', '/api/locations/:code/capacity', ({ code }, q, b, by) => run('setLocationCapacity', { ...b, code: decodeURIComponent(code) }, by));
    on('POST', '/api/locations/:code/delete', ({ code }, q, b, by) => run('deleteLocation', { code: decodeURIComponent(code) }, by));
    on('DELETE', '/api/locations/:code', ({ code }, q, b, by) => run('deleteLocation', { code: decodeURIComponent(code) }, by));
    on('GET', '/api/holders', () => Object.values(wh().holders || {}).map((h) => holderView(wh(), h)));
    on('POST', '/api/holders', (_, q, b, by) => run('addHolder', b, by));
    on('POST', '/api/holders/issue', (_, q, b, by) => run('issuePlates', b, by));
    on('POST', '/api/holders/series', (_, q, b, by) => run('issueSeries', b, by));
    on('POST', '/api/consolidate', (_, q, b, by) => run('consolidate', b, by));
    on('GET', '/api/holders/:id/history', ({ id }) => {
      const h = wh().holders[decodeURIComponent(id).toUpperCase()];
      if (!h) return { status: 404, error: `Unknown holder ${id}` };
      return { id: h.id, series: h.series || null, parentId: h.parentId || null, children: h.children || [], history: h.history || [], movements: wh().movementsFor({ holder: h.id }) };
    });
    on('GET', '/api/movements', (_, q) => wh().movementsFor({ user: q.user || null, holder: q.holder || null }));
    on('GET', '/api/technical', () => ({ ...(wh().technical || {}), holderSeries: wh().holderSeries }));
    on('POST', '/api/technical', (_, q, b, by) => run('setTechnical', { patch: b }, by));
    on('GET', '/api/setup', () => {
      const { PRESETS, FEATURES } = require('../src/presets');
      const { EXAMPLES, LEVELS } = require('../src/locations');
      return {
        setup: wh().setup || { completed: false },
        features: wh().features,
        presets: PRESETS.map((p) => ({ id: p.id, name: p.name, summary: p.summary, features: p.features, modules: p.modules, locationPlan: p.locationPlan, virtual: p.virtual, categories: p.categories })),
        featureList: FEATURES.map(([id, label, hint]) => ({ id, label, hint })),
        modules: wh().moduleList(),
        examples: Object.values(EXAMPLES).map((ex) => ({ ...ex, preview: require('../src/locations').expand(ex.plan, { limit: 6 }) })),
        levels: LEVELS,
      };
    });
    on('POST', '/api/setup/preset', (_, q, b, by) => run('applyPreset', b, by));
    on('GET', '/api/modules', () => wh().moduleList());
    on('POST', '/api/setup/modules', (_, q, b, by) => run('setModules', { modules: b.modules || b }, by));
    on('POST', '/api/setup/features', (_, q, b, by) => run('setFeatures', { features: b.features || b }, by));
    on('POST', '/api/setup/complete', (_, q, b, by) => run('completeSetup', {}, by));
    on('POST', '/api/locations/preview', (_, q, b) => require('../src/locations').expand(b.plan || b, { limit: 24 }));
    on('POST', '/api/locations/generate', (_, q, b, by) => run('generateLocations', b, by));
    on('POST', '/api/items/:itemNo/units', ({ itemNo }, q, b, by) => run('setItemUnits', { ...b, itemNo: decodeURIComponent(itemNo) }, by));
    on('GET', '/api/bins', (_, q) => (q.item || q.itemNo ? wh().binsFor(q.item || q.itemNo) : wh().binList()));
    on('GET', '/api/bins/:code', ({ code }) => wh().binContents(decodeURIComponent(code)));
    on('POST', '/api/bins/put', (_, q, b, by) => run('binPut', b, by));
    on('POST', '/api/bins/take', (_, q, b, by) => run('binTake', b, by));
    on('POST', '/api/bins/move', (_, q, b, by) => run('binMove', b, by));
    on('POST', '/api/bins/count', (_, q, b, by) => run('binCount', b, by));
    on('POST', '/api/bins/:code/mode', ({ code }, q, b, by) => run('setBinMode', { code: decodeURIComponent(code), mixed: b.mixed }, by));
    on('GET', '/api/waves', () => Object.values(wh().waves || {}).slice(-30).reverse());
    on('GET', '/api/waves/queue', () => ({ settings: wh().waveSettings(), active: wh().activeWave() ? wh().activeWave().id : null, queue: wh().waveQueue() }));
    on('POST', '/api/waves/config', (_, q, b, by) => run('setWaveConfig', { config: b }, by));
    on('GET', '/api/waves/tasks', (_, q) => wh().waveTasks({ kind: q.kind || null }));
    on('POST', '/api/waves', (_, q, b, by) => run('planWave', b, by));
    on('POST', '/api/waves/tasks/:task/confirm', ({ task }, q, b, by) => run('confirmWaveTask', { task: decodeURIComponent(task), scan: b.scan }, by));
    on('POST', '/api/waves/:id/cancel', ({ id }, q, b, by) => run('cancelWave', { id: decodeURIComponent(id) }, by));
    on('POST', '/api/locations/guided/preview', (_, q, b) => {
      const out = require('../src/locations').guided(b.answers || b, { limit: 24 });
      return { total: out.total, sample: out.sample, sampleCode: out.sampleCode, plans: out.plans.map(({ section, type, total, sampleCode, lastCode, capacity }) => ({ section, type, total, sampleCode, lastCode, capacity })) };
    });
    on('POST', '/api/locations/guided', (_, q, b, by) => run('generateGuided', b, by));
    on('GET', '/api/location-profiles', () => wh().locationProfilesView());
    on('POST', '/api/location-profiles', (_, q, b, by) => run('saveLocationProfile', { profile: b }, by));
    on('POST', '/api/locations/bulk', (_, q, b, by) => run('bulkLocations', b, by));
    on('GET', '/api/val', () => ({ stations: wh().valStations || [], kits: Object.values(wh().kits || {}), jobs: (wh().valJobs || []).slice(0, 20) }));
    on('POST', '/api/val/start', (_, q, b, by) => run('startVal', b, by));
    on('POST', '/api/holders/:id/pick', ({ id }, q, b, by) => run('pickHolder', { id: decodeURIComponent(id), orderId: b.orderId || null, qty: b.qty }, by));
    on('POST', '/api/val/scan', (_, q, b, by) => run('scanVal', b, by));
    on('POST', '/api/holders/:id', ({ id }, q, b, by) => run('updateHolder', { ...b, id: decodeURIComponent(id) }, by));
    on('POST', '/api/holders/:id/move', ({ id }, q, b, by) => run('moveHolder', { id: decodeURIComponent(id), loc: b.loc }, by));
    on('POST', '/api/holders/:id/load', ({ id }, q, b, by) => run('loadHolder', { ...b, id: decodeURIComponent(id) }, by));
    on('POST', '/api/holders/:id/unload', ({ id }, q, b, by) => run('unloadHolder', { ...b, id: decodeURIComponent(id) }, by));
    on('POST', '/api/holders/:id/remove', ({ id }, q, b, by) => run('removeHolder', { id: decodeURIComponent(id) }, by));
    on('DELETE', '/api/holders/:id', ({ id }, q, b, by) => run('removeHolder', { id: decodeURIComponent(id) }, by));
    const issue = (args, by) => {
      const result = run('issueLabel', args, by);
      if (hardware && result && result.zpl) hardware.note(result);
      return result;
    };
    on('POST', '/api/labels/pallet', (_, q, b, by) => issue({ ...b, kind: 'pallet' }, by));
    on('POST', '/api/labels/master', (_, q, b, by) => issue({ ...b, kind: 'master' }, by));
    on('GET', '/api/labels/sheet', (_, q) => ({ contentType: 'text/html; charset=utf-8', raw: wh().labelSheet({ kind: q.kind || 'locations', codes: q.codes || null, prefix: q.prefix || null, items: q.items || null, ids: q.ids || null, layout: q.layout || 'a4-21', skip: Number(q.skip) || 0 }) }));
    on('GET', '/api/labels/:id', ({ id }) => wh().labelDocument(decodeURIComponent(id)));
    on('GET', '/api/labels/:id/html', ({ id }) => ({ contentType: 'text/html; charset=utf-8', raw: wh().labelDocument(decodeURIComponent(id)).html }));
    on('GET', '/api/labels/:id/zpl', ({ id }) => ({ contentType: 'text/plain; charset=utf-8', raw: wh().labelDocument(decodeURIComponent(id)).zpl }));
    on('POST', '/api/stock/adjust', (_, q, b, by) => run('adjustQuantity', b, by));
    on('POST', '/api/replenish', (_, q, b, by) => run('replenish', b, by));
    on('POST', '/api/orders/:id/pack', ({ id }, q, b, by) => run('recordPacking', { id: decodeURIComponent(id), note: b.note }, by));
    on('POST', '/api/orders/:id/carton', ({ id }, q, b, by) => run('openCarton', { orderId: decodeURIComponent(id) }, by));
    on('POST', '/api/orders/:id/dispatch-cartons', ({ id }, q, b, by) => run('dispatchCartons', { orderId: decodeURIComponent(id) }, by));
    on('POST', '/api/cartons/:id/pack', ({ id }, q, b, by) => run('packIntoCarton', { carton: decodeURIComponent(id), code: b.code, qty: b.qty }, by));
    on('POST', '/api/cartons/:id/close', ({ id }, q, b, by) => run('closeCarton', { carton: decodeURIComponent(id), ...b }, by));
    on('POST', '/api/work-orders', (_, q, b, by) => run('addWorkOrder', b, by));
    on('POST', '/api/pick-faces', (_, q, b, by) => run('setPickFace', b, by));
    on('POST', '/api/replenishment/plan', (_, q, b, by) => run('planReplenishment', {}, by));
    on('GET', '/api/returns', () => Object.values(wh().returns || {}));
    on('POST', '/api/returns', (_, q, b, by) => run('receiveReturn', b, by));
    on('POST', '/api/returns/:id/grade', ({ id }, q, b, by) => run('gradeReturn', { ...b, id: decodeURIComponent(id) }, by));
    on('GET', '/api/reports/availability', () => wh().availability());
    on('GET', '/api/reports/availability.json', () => wh().availability());
    on('GET', '/api/reports/availability.csv', () => ({
      contentType: 'text/csv; charset=utf-8',
      raw: csv([['sku', 'name', 'onHand', 'allocated', 'held', 'reserved', 'available', 'reorderPoint', 'low'], ...wh().availability().map((r) => [r.sku, r.name, r.onHand, r.allocated, r.held, r.reserved, r.available, r.reorderPoint == null ? '' : r.reorderPoint, r.low ? 'yes' : 'no'])]),
    }));
    on('GET', '/api/alerts/low-stock', () => wh().lowStock());
    on('GET', '/api/reports/billing', (_, q) => wh().billingReport({ clientId: q.clientId || null }));
    on('GET', '/api/reports/billing.csv', (_, q) => ({
      contentType: 'text/csv; charset=utf-8',
      raw: csv([['client', 'name', 'palletDays', 'moves', 'storageRate', 'handlingRate', 'storage', 'handling', 'total'], ...wh().billingReport({ clientId: q.clientId || null }).map((r) => [r.clientId, r.name, r.palletDays, r.moves, r.storageRate, r.handlingRate, r.storage, r.handling, r.total])]),
    }));
    on('GET', '/api/sites', () => ({ current: store.siteId || 'MAIN', sites: store.listSites ? store.listSites() : [{ id: 'MAIN', name: 'Main warehouse' }] }));
    on('POST', '/api/sites', (_, q, b) => store.createSite(b));
    on('POST', '/api/sites/transfer', (_, q, b, by) => store.startTransfer({ from: b.from || store.siteId || 'MAIN', to: b.to, itemNo: b.itemNo, qty: b.qty, id: b.id, by }));
    on('POST', '/api/sites/transfers/:id/receive', ({ id }, q, b, by) => store.receiveTransfer({ id: decodeURIComponent(id), from: b.from || 'MAIN', to: b.to, by }));
    on('POST', '/api/sites/transfers/:id/cancel', ({ id }, q, b, by) => store.cancelTransfer({ id: decodeURIComponent(id), from: b.from || store.siteId || 'MAIN', by }));
    on('POST', '/api/orders/:id/shipment', ({ id }, q, b, by) => run('stageShipment', { orderId: decodeURIComponent(id), truck: b.truck || null }, by));
    on('POST', '/api/orders/:id/shipment/scan', ({ id }, q, b, by) => run('scanShipment', { orderId: decodeURIComponent(id), code: b.code }, by));
    on('POST', '/api/orders/:id/shipment/dispatch', ({ id }, q, b, by) => run('dispatchShipment', { orderId: decodeURIComponent(id) }, by));
    on('GET', '/api/orders/:id/shipment', ({ id }) => {
      const order = wh().orders[decodeURIComponent(id)];
      if (!order) return { status: 404, error: `No order ${id}` };
      return order.shipment || { status: 404, error: 'No shipment' };
    });
    on('GET', '/api/orders/:id/delivery-note', ({ id }) => ({ contentType: 'text/html; charset=utf-8', raw: wh().deliveryNote(decodeURIComponent(id)) }));
    on('POST', '/api/clients/:id/tariff', ({ id }, q, b, by) => run('setTariff', { clientId: decodeURIComponent(id), tariff: b }, by));
    on('POST', '/api/clients/:id/space', ({ id }, q, b, by) => run('setSpaces', { clientId: decodeURIComponent(id), spaces: b.spaces || [] }, by));
    on('GET', '/api/reports/billing.html', (_, q) => ({ contentType: 'text/html; charset=utf-8', raw: wh().invoiceHtml({ clientId: q.clientId, from: q.from || null, to: q.to || null }) }));
    on('GET', '/api/reports/invoice', (_, q) => wh().invoice({ clientId: q.clientId, from: q.from || null, to: q.to || null }));
    on('GET', '/api/reports/invoice.csv', (_, q) => ({
      contentType: 'text/csv; charset=utf-8',
      raw: wh().invoiceCsv({ clientId: q.clientId, from: q.from || null, to: q.to || null }),
    }));
    on('GET', '/api/backup', () => store.exportBackup());
    on('POST', '/api/backup', (_, q, b) => store.importBackup(b));
    on('POST', '/api/devices/:id/operator', ({ id }, q, b, by) => run('assignOperator', { id, operator: b.operator || null, ...('duty' in b ? { duty: b.duty || null } : {}) }, by));
    on('POST', '/api/devices/:id/duty', ({ id }, q, b, by) => run('setTruckDuty', { id, duty: b.duty || null }, by));
    on('POST', '/api/devices/:id/equipment', ({ id }, q, b, by) => run('setTruckEquipment', { id, equipment: b.equipment || null }, by));
    on('GET', '/api/checks', () => wh().openChecks());
    on('POST', '/api/checks', (_, q, b, by) => run('raiseCheck', b, by));
    on('POST', '/api/checks/:id/close', ({ id }, q, b, by) => run('closeCheck', { ...b, id: decodeURIComponent(id) }, by));
    on('GET', '/api/stock/at/:code', ({ code }) => wh()._stockAt(wh().resolve(decodeURIComponent(code))));
    on('POST', '/api/stock/correct', (_, q, b, by) => run('correctItem', b, by));
    on('GET', '/api/reports/stock-changes', (_, q) => wh().stockChanges({ from: q.from || null, to: q.to || null }));
    on('GET', '/api/reports/stock-changes.csv', (_, q) => ({ contentType: 'text/csv; charset=utf-8', raw: wh().stockChangesCsv({ from: q.from || null, to: q.to || null }) }));
    on('GET', '/api/putaway/:sscc', ({ sscc }) => wh().putAwaySlot(decodeURIComponent(sscc)));
    on('POST', '/api/putaway', (_, q, b, by) => run('putAwayPallet', b, by));
    on('POST', '/api/stock/create', (_, q, b, by) => run('createStock', b, by));
    on('POST', '/api/stock/:sscc/delete', ({ sscc }, q, b, by) => run('deleteStock', { sscc: decodeURIComponent(sscc), reason: b.reason }, by));
    on('GET', '/api/equipment', () => ({ equipment: Object.values(wh().equipment || {}), faults: wh().faults || [], maintenance: (wh().maintenance || []).slice(0, 100) }));
    on('POST', '/api/equipment', (_, q, b, by) => run('addEquipment', b, by));
    on('POST', '/api/equipment/:id/fault', ({ id }, q, b, by) => run('reportFault', { ...b, equipmentId: decodeURIComponent(id) }, by));
    on('POST', '/api/equipment/:id/maintenance', ({ id }, q, b, by) => run('recordMaintenance', { ...b, equipmentId: decodeURIComponent(id) }, by));
    on('POST', '/api/faults/:id/close', ({ id }, q, b, by) => run('closeFault', { id: decodeURIComponent(id), note: b.note }, by));
    on('GET', '/api/search', (_, q) => wh().search(q.q || ''));
    on('GET', '/api/exceptions', () => ({
      held: Object.values(wh().tasks).filter((t) => t.status === 'held' && !t.replacedBy).map((t) => taskView(wh(), t)),
      blocked: Object.values(wh().pallets).filter((p) => p.status === 'blocked').map((p) => palletView(wh(), p)),
      lost: wh().lostPallets().map((p) => palletView(wh(), p)),
      faults: (wh().faults || []).filter((f) => f.status === 'open'),
      quality: Object.values(wh().pallets).filter((p) => p.qualityHold).map((p) => palletView(wh(), p)),
    }));
    on('GET', '/api/reports/stock', () => wh().stockSummary().map((r) => ({ itemNo: r.item.itemNo, name: r.item.name, clientId: r.item.clientId || null, category: r.item.category, available: r.available, short: r.short, blocked: r.blocked, qty: r.qty, batches: r.batches, nextExpiry: r.next && r.next.expiry })));
    on('GET', '/api/reports/expiry', (_, q) => {
      const days = Math.min(Math.max(Number(q.days) || 30, 0), 3650);
      return Object.values(wh().pallets).filter((p) => p.loc && p.status !== 'shipped' && wh().daysLeft(p) <= days).sort((a, b) => (a.expiry < b.expiry ? -1 : 1)).slice(0, 500).map((p) => ({ ...palletView(wh(), p), daysLeft: wh().daysLeft(p) }));
    });
    on('GET', '/api/reports/orders', () => Object.values(wh().orders).map((o) => ({ id: o.id, customer: o.customer, clientId: o.clientId || null, status: o.status, lane: o.lane, pallets: o.lines.reduce((n, l) => n + l.allocated.length, 0), short: o.lines.reduce((n, l) => n + l.short, 0) })));
    on('GET', '/api/reports/stock.csv', () => ({
      contentType: 'text/csv; charset=utf-8',
      raw: csv([['item', 'name', 'client', 'category', 'available', 'short', 'blocked', 'qty', 'batches'], ...wh().stockSummary().map((r) => [r.item.itemNo, r.item.name, r.item.clientId || '', r.item.category, r.available, r.short, r.blocked, r.qty, r.batches])]),
    }));
    on('GET', '/api/hardware', () => (hardware ? hardware.recent() : { settings: { scanner: 'wedge', printer: 'simulated' }, scans: [], jobs: [], printers: printers.list ? printers.list() : [], modes: { scanner: ['wedge', 'manual', 'simulated'], printer: ['simulated', 'network', 'browser'] } }));
    on('POST', '/api/hardware/mode', (_, q, b) => (hardware ? hardware.setMode(b) : { status: 400, error: 'Hardware service is not configured' }));
    on('POST', '/api/hardware/scan', async (_, q, b, by) => {
      if (!hardware) return { status: 400, error: 'Hardware service is not configured' };
      const scan = hardware.recordScan(b);
      if (b.deviceId) return { scan, result: run('scan', { id: b.deviceId, code: scan.code }, by) };
      if (b.stationId) return { scan, result: run('stationScan', { id: b.stationId, code: scan.code }, by) };
      return { scan };
    });
    on('POST', '/api/hardware/print', (_, q, b) => (hardware ? hardware.print({ printer: b.printer, zpl: b.zpl, html: b.html, kind: b.kind }) : { status: 400, error: 'Hardware service is not configured' }));

    // Answers to recent changes by request ID. A handheld on a slow network sends the same
    // request again when the answer is late; the repeat gets the first answer instead of
    // happening twice (a pallet scanned twice in Auto means "move it").
    const answered = new Map();
    function handle(method, rawUrl, body = {}, by = 'office', requestId = null, actor = null) {
      currentActor = actor || null;
      if (method !== 'GET' && requestId) {
        const key = `${by}|${method} ${rawUrl}|${requestId}`;
        if (answered.has(key)) return answered.get(key);
        const out = handleOnce(method, rawUrl, body, by);
        answered.set(key, out);
        if (answered.size > 2000) answered.delete(answered.keys().next().value);
        return out;
      }
      return handleOnce(method, rawUrl, body, by);
    }

    // Changes that belong to a module are refused while it is off. Reads still answer.
    const MODULE_ROUTES = [
      ['trucks', /^\/api\/(devices|aisles\/|shift\/start|plan\/counts)/],
      ['waves', /^\/api\/waves/],
      ['kitting', /^\/api\/(val|work-orders)/],
      ['stations', /^\/api\/(stations\/[^/]+\/scan|pallets\/[^/]+\/process)/],
      ['billing', /^\/api\/clients\/[^/]+\/(tariff|space)$/],
      ['clients', /^\/api\/clients/],
      ['sites', /^\/api\/sites/],
    ];
    function moduleOff(method, path) {
      if (method === 'GET' || typeof wh().module !== 'function') return null;
      const hit = MODULE_ROUTES.find(([, re]) => re.test(path));
      return hit && !wh().module(hit[0]) ? hit[0] : null;
    }

    function handleOnce(method, rawUrl, body, by) {
      const url = new URL(rawUrl, 'http://x');
      const route = routes.find((r) => r.method === method && r.re.test(url.pathname));
      if (!route) return { status: 404, body: { error: `No route ${method} ${url.pathname}` } };
      const off = moduleOff(method, url.pathname);
      if (off) {
        const label = (wh().moduleList().modules.find((m) => m.id === off) || {}).label || off;
        return { status: 409, body: { error: `${label} is switched off for this warehouse. An administrator can turn it on in setup.`, module: off } };
      }
      const answer = (out) => {
      if (out && out.contentType) return { status: out.status || 200, body: out.raw != null ? out.raw : out.body, contentType: out.contentType };
      if (out && out.status && out.error) return { status: out.status, body: { error: out.error } };
      return { status: 200, body: out === undefined ? { ok: true } : out };
      };
      try {
        const out = route.fn(url.pathname.match(route.re).groups || {}, Object.fromEntries(url.searchParams), body || {}, by);
        // Asking a printer goes over the network: those routes answer with a promise.
        if (out && typeof out.then === 'function') return out.then(answer, (e) => ({ status: 400, body: { error: e.message } }));
        return answer(out);
      } catch (e) {
        return { status: 400, body: { error: e.message } };
      }
    }

    return { handle };
  }

  return { createApi, deviceView, summary, placeName, lookupView };
});
