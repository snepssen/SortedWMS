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
  const { TASK_TYPES, TRUCK_MODES, SHIFT_REASONS, RECEIVE_FIELDS, FIELD_LABELS } = Engine;

  // ---- Views: what the pages need, without engine internals --------------------

  // A location as the screens show it: AA03C2 or 38-02-0-10 (the naming setting), stations by name.
  const placeName = (wh, code) => (code && wh.locations[code] ? (wh.locations[code].kind === 'rack' ? wh.label(code) : wh._placeName(code)) : code);

  function palletView(wh, p) {
    if (!p) return null;
    const item = wh.items[p.itemNo];
    return {
      sscc: p.sscc, itemNo: p.itemNo, name: item && item.name, category: item && item.category, batch: p.batch, expiry: p.expiry,
      qty: p.qty, status: p.status, blockReason: p.blockReason, shipState: wh.shipState(p), loc: p.loc, locName: placeName(wh, p.loc),
      orderId: p.orderId, inProcess: p.proc ? p.proc.route : null,
    };
  }

  function taskView(wh, t) {
    if (!t) return null;
    return {
      id: t.id, type: t.type, typeLabel: TASK_TYPES[t.type].label, status: t.status, category: t.category, sscc: t.sscc,
      from: t.from, fromName: placeName(wh, t.from), to: t.to, toName: placeName(wh, t.to),
      step: t.step, orderId: t.orderId, deliveryId: t.deliveryId, truckId: t.truckId, urgent: wh.isUrgent(t),
      why: t.type === 'SHIFT' ? SHIFT_REASONS[t.reason] : t.type === 'MOVE' ? t.note : t.dispatchReason,
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
      id, kind: d.kind || 'truck', mode: d.mode, modes: Object.entries(TRUCK_MODES).map(([k, v]) => ({ id: k, label: v.label })),
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
    }
    if (ins.pallet) I.pallet = palletView(wh, ins.pallet);
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
    if (ins.kind === 'transfer') I.pallet = palletView(wh, ins.pallet);
    if (ins.kind === 'find' && ins.result) I.result = lookupView(wh, ins.result);
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
    };
  }

  // ---- Routes ----------------------------------------------------------------------

  /**
   * handle(method, url, body, by) -> { status, body }. `store` needs wh, exec(op, args, by)
   * and journal(filter); `printers` needs flush(queue) and results.
   */
  function createApi({ store, printers }) {
    const wh = () => store.wh;
    const routes = [];
    const on = (method, pattern, fn) => routes.push({ method, re: new RegExp(`^${pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`), fn });
    const run = (op, args, by) => {
      const result = store.exec(op, args, by);
      printers.flush(store.wh.printQueue);
      return result;
    };

    // Reads
    on('GET', '/api/summary', () => summary(wh()));
    on('GET', '/api/devices', () => [...Object.keys(wh().trucks), ...Object.keys(wh().desks)].map((id) => deviceView(wh(), id)));
    on('GET', '/api/devices/:id', ({ id }) => deviceView(wh(), id) || { status: 404, error: `No device ${id}` });
    on('GET', '/api/tasks', (_, q) => Object.values(wh().tasks).filter((t) => (q.status ? t.status === q.status : ['open', 'active', 'held'].includes(t.status))).map((t) => taskView(wh(), t)));
    on('GET', '/api/orders', () => Object.values(wh().orders));
    on('GET', '/api/deliveries', () => Object.values(wh().deliveries).map((d) => ({ ...d, list: undefined, hasList: Boolean(d.list) })));
    on('GET', '/api/items', () => Object.values(wh().items));
    on('GET', '/api/stock', () => wh().stockSummary().map((r) => ({ ...r, next: palletView(wh(), r.next) })));
    on('GET', '/api/lookup/:code', ({ code }) => {
      const r = wh().lookup(decodeURIComponent(code));
      if (!r) return { status: 404, error: `${decodeURIComponent(code)} is not a pallet, location or item` };
      return { ...lookupView(wh(), r), pallet: palletView(wh(), r.pallet), pallets: (r.pallets || []).map((p) => palletView(wh(), p)), location: r.location && { code: r.location.code, name: wh().label(r.location.code), kind: r.location.kind, category: r.location.category, blocked: r.location.blocked } };
    });
    on('GET', '/api/lost', () => wh().lostPallets().map((p) => ({ ...palletView(wh(), p), missingFrom: p.missingFrom, missingFromName: placeName(wh(), p.missingFrom) })));
    on('GET', '/api/transfers', () => (wh().transfers || []).slice(0, 200).map((t) => ({ ...t, fromName: placeName(wh(), t.from), toName: placeName(wh(), t.to) })));
    on('GET', '/api/trace/:batch', ({ batch }) => {
      const r = wh().trace(decodeURIComponent(batch));
      return { ...r, inStock: r.inStock.map((p) => palletView(wh(), p)) };
    });
    on('GET', '/api/template/preview', (_, q) => {
      const codes = wh().selectLocations(q.from, q.to);
      return { ...wh().previewTemplate(codes, q.category || null), first: codes.slice(0, 3).map((c) => wh().label(c)), last: codes.slice(-3).map((c) => wh().label(c)) };
    });
    on('GET', '/api/stations/:id', ({ id }) => {
      const v = wh().stationView(id);
      const pv = (p) => palletView(wh(), p);
      return { station: v.station, queue: v.queue.map(pv), working: v.working.map((w) => ({ ...w, pallet: pv(w.pallet) })), dwelling: v.dwelling.map((d) => ({ ...d, pallet: pv(d.pallet) })), waiting: v.waiting.map(pv), coming: v.coming };
    });
    on('GET', '/api/process-log', () => wh().processLog.slice(0, 200));
    on('GET', '/api/events', () => wh().events.slice(0, 200).map((e) => ({ ...e, text: wh().display(e.text) })));
    on('GET', '/api/journal', (_, q) => store.journal({ limit: q.limit, op: q.op, by: q.by, before: q.before }));
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
    on('POST', '/api/pallets/:sscc/allow-short', ({ sscc }, q, b, by) => run('allowShortShip', { sscc }, by));
    on('POST', '/api/pallets/:sscc/process', ({ sscc }, q, b, by) => run('startProcess', { sscc, route: b.route }, by));
    on('POST', '/api/items/:itemNo/min-ship-days', ({ itemNo }, q, b, by) => run('setMinShipDays', { itemNo, days: b.days }, by));
    on('POST', '/api/orders', (_, q, b, by) => run('addOrder', b, by));
    on('POST', '/api/orders/:id/ship', ({ id }, q, b, by) => run('shipOrder', { id }, by));
    on('POST', '/api/deliveries', (_, q, b, by) => run('addDelivery', b, by));
    on('POST', '/api/aisles/:aisle/direction', ({ aisle }, q, b, by) => run('setAisleDirection', { aisle, enterFrom: b.enterFrom }, by));
    on('POST', '/api/aisles/:aisle/cell', ({ aisle }, q, b, by) => run('setAisleCell', { aisle, cell: b.cell }, by));
    on('POST', '/api/naming', (_, q, b, by) => run('setNaming', { show: b.show }, by));
    on('POST', '/api/plan/grouping', (_, q, b, by) => run('planGrouping', {}, by));
    on('POST', '/api/plan/dig-out', (_, q, b, by) => run('planDigOut', {}, by));
    on('POST', '/api/import/items', (_, q, b, by) => run('importItems', { rows: b.rows || b }, by));
    on('POST', '/api/import/locations', (_, q, b, by) => run('importLocations', { rows: b.rows || b }, by));
    on('POST', '/api/import/stock', (_, q, b, by) => run('importStock', { rows: b.rows || b }, by));

    function handle(method, rawUrl, body = {}, by = 'office') {
      const url = new URL(rawUrl, 'http://x');
      const route = routes.find((r) => r.method === method && r.re.test(url.pathname));
      if (!route) return { status: 404, body: { error: `No route ${method} ${url.pathname}` } };
      try {
        const out = route.fn(url.pathname.match(route.re).groups || {}, Object.fromEntries(url.searchParams), body || {}, by);
        if (out && out.status && out.error) return { status: out.status, body: { error: out.error } };
        return { status: 200, body: out === undefined ? { ok: true } : out };
      } catch (e) {
        return { status: 400, body: { error: e.message } };
      }
    }

    return { handle };
  }

  return { createApi, deviceView, summary, placeName, lookupView };
});
