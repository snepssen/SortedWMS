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
  // The same routes run in the browser on Pages, where there is no require: use the globals the modules set there.
  const presetsLib = () => (typeof require === 'function' ? require('../src/presets') : globalThis.SortedPresets);
  const registryLib = () => {
    if (typeof require === 'function') {
      try { return require('../modules/registry'); } catch (e) { return null; }
    }
    return typeof globalThis !== 'undefined' ? globalThis.SortedRegistry : null;
  };
  function hiddenModes(wh) {
    const reg = registryLib();
    const hidden = new Set();
    if (!reg || typeof wh.module !== 'function') return hidden;
    for (const mod of reg.modules()) {
      if (wh.module(mod.id)) continue;
      for (const mode of mod.handheld || []) hidden.add(mode.id);
    }
    return hidden;
  }
  const Intake = () => (typeof require === 'function' ? require('../src/intake') : globalThis.SortedIntake);
  const locationsLib = () => (typeof require === 'function' ? require('../src/locations') : globalThis.SortedLocations);
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
      planning: t.planning || null,
      id: t.id, type: t.type, typeLabel: TASK_TYPES[t.type].label, status: t.status, category: t.category, reason: t.reason || null, sscc: t.sscc,
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
      id, kind: d.kind || 'truck', mode: d.mode, operator: d.operator || null, duty: d.duty || null, equipment: d.equipment || null, modes: Object.entries(TRUCK_MODES).filter(([k]) => !hiddenModes(wh).has(k)).map(([k, v]) => ({ id: k, label: v.label })),
      categories: d.categories, message: d.message ? { ...d.message, text: wh.display(d.message.text) } : null, stats: d.stats,
      instruction: { kind: ins.kind, task: taskView(wh, task) },
      abc: d.mode === 'count' && typeof wh.abcMine === 'function' && wh.module('abc') ? wh.abcMine(d.operator || id) : null,
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
    // Stacked pickup: every pallet on the forks with its own drop, the current one first.
    if (ins.stack) I.stack = ins.stack.map((s) => ({ taskId: s.taskId, sscc: s.sscc, itemNo: s.itemNo, to: s.to, toName: placeName(wh, s.to), current: s.current }));
    if (ins.canStack) I.canStack = true;
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
      pallets: wh._livePallets().filter((p) => p.loc).length,
      lost: wh.lostPallets().length,
      cantShip: wh._livePallets().filter((p) => p.loc && wh.shipState(p) !== 'ok').length,
      inProcess: wh._livePallets().filter((p) => p.proc).length,
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

  function createApi({ store, printers, hardware, backups = null, offsite = null }) {
    const wh = () => (store.warehouse ? store.warehouse(store.siteId) : store.wh);
    const routes = [];
    const on = (method, pattern, fn) => routes.push({ method, re: new RegExp(`^${pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`), fn });
    const run = (op, args, by) => {
      const result = store.exec(op, args, by);
      printers.flush(wh().printQueue);
      return result;
    };
    let currentActor = null;
    let rawBody = '';
    let webhookHeader = '';
    const ownClient = () => (currentActor && currentActor.role === 'client' ? String(currentActor.clientId || '').toUpperCase() : null);
    const seesItemValue = () => {
      const w = wh();
      if (typeof w.module === 'function' && !w.module('item-value')) return false;
      if (!w.feature('highValueSecurity')) return true;
      if (!currentActor) return true;
      if (currentActor.service || currentActor.role === 'administrator') return true;
      return Boolean(currentActor.permissions && currentActor.permissions.includes('items.value'));
    };
    const presentItem = (item) => {
      if (!item || seesItemValue() || !Object.prototype.hasOwnProperty.call(item, 'value')) return item;
      const copy = { ...item };
      delete copy.value;
      return copy;
    };
    const valueDenied = () => {
      const w = wh();
      if (typeof w.module === 'function' && !w.module('item-value')) return { status: 403, error: 'Item value is switched off', module: 'item-value' };
      return { status: 403, error: 'Item value is hidden for this role' };
    };
    const mentionsValue = (body) => {
      if (!body || typeof body !== 'object') return false;
      const filled = (row) => Boolean(row) && Object.prototype.hasOwnProperty.call(row, 'value');
      if (filled(body)) return true;
      const rows = Array.isArray(body) ? body : body.rows;
      if (Array.isArray(rows) && rows.some(filled)) return true;
      const doc = body.doc && typeof body.doc === 'object' ? body.doc : body;
      return ['items', 'lines', 'pallets'].some((key) => Array.isArray(doc[key]) && doc[key].some(filled));
    };
    const deny = () => ({ status: 403, error: 'That belongs to another client' });

    // Reads
    on('GET', '/api/summary', () => summary(wh()));
    // Confirmations for other systems, read from where the reader left off (docs/CONNECTIONS.md).
    // Orders and ASNs from other systems: one document, { documents: [...] }, or { type, csv }. Each is
    // taken in on its own, so one bad document does not hold up the rest; a resend answers "duplicate".
    on('POST', '/api/inbox', (_, q, b, by) => {
      const own = ownClient();
      let docs;
      try {
        docs = b.csv != null ? Intake().fromCsv(b.type, b.csv) : Array.isArray(b.documents) ? b.documents : [b];
      } catch (e) { return { status: 400, error: e.message }; }
      if (docs.some((doc) => mentionsValue(doc)) && !seesItemValue()) return valueDenied();
      if (!docs.length) return { status: 400, error: 'Nothing to take in' };
      if (docs.length > 500) return { status: 400, error: 'At most 500 documents a call' };
      const results = docs.map((doc) => {
        try {
          if (own && doc.clientId && String(doc.clientId).trim().toUpperCase() !== own) throw new Error('That belongs to another client');
          return run('intake', { doc: own ? { ...doc, clientId: own } : doc }, by);
        } catch (e) { return { status: 'refused', type: doc && doc.type, ref: doc && doc.ref, error: e.message }; }
      });
      const refused = results.filter((r) => r.status === 'refused').length;
      const single = b.csv == null && !Array.isArray(b.documents);
      if (single && refused) return { status: /sent before with other content/.test(results[0].error) ? 409 : 400, error: results[0].error };
      if (single) return results[0];
      return { taken: results.length - refused, refused, results };
    });
    on('GET', '/api/messages', (_, q) => wh().messageLog({ after: q.after, limit: q.limit, type: q.type || null, clientId: ownClient() }));
    on('GET', '/api/devices', () => [...Object.keys(wh().trucks), ...Object.keys(wh().desks)].map((id) => deviceView(wh(), id)));
    on('GET', '/api/scan-commands', () => {
      const hidden = hiddenModes(wh());
      return Object.entries(SCAN_COMMANDS).filter(([, c]) => !c.mode || !hidden.has(c.mode)).map(([k, c]) => ({ code: COMMAND_PREFIX + k, label: c.label, group: c.group, confirm: Boolean(c.confirm) }));
    });
    on('GET', '/api/devices/:id', ({ id }) => deviceView(wh(), id) || { status: 404, error: `No device ${id}` });
    on('GET', '/api/tasks', (_, q) => Object.values(wh().tasks).filter((t) => (q.status ? t.status === q.status : ['open', 'active', 'held'].includes(t.status))).map((t) => taskView(wh(), t)));
    on('GET', '/api/return-moves', () => ({
      tasks: Object.values(wh().tasks).filter((t) => t.reason === 'return-split' && ['open', 'active', 'held'].includes(t.status)).map((t) => taskView(wh(), t)),
    }));
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
    on('GET', '/api/items', () => { const own = ownClient(); return Object.values(wh().items).filter((i) => own == null || i.clientId === own).map(presentItem); });
    on('GET', '/api/stock', () => { const own = ownClient(); return wh().stockSummary().filter((r) => own == null || (r.item && r.item.clientId === own)).map((r) => ({ ...r, item: presentItem(r.item), next: palletView(wh(), r.next) })); });
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
      pallets: wh()._livePallets().filter((p) => p.status === 'blocked').map((p) => palletView(wh(), p)),
      locations: Object.values(wh().locations).filter((l) => l.blocked).map((l) => ({ code: l.code, name: placeName(wh(), l.code), kind: l.kind, sscc: l.sscc || null })),
    }));
    on('GET', '/api/lost', () => wh().lostPallets().map((p) => ({ ...palletView(wh(), p), missingFrom: p.missingFrom, missingFromName: placeName(wh(), p.missingFrom) })));
    // Stock counts: the open count jobs, the latest results, and how often the system was right.
    const abcReveal = () => Boolean(currentActor && currentActor.permissions && currentActor.permissions.includes('counts.approve'));
    on('GET', '/api/abc', (_, q) => wh().abcBoard({ reveal: abcReveal(), status: q.status || null, cls: q.class || null }));
    on('GET', '/api/abc/mine', (_, q, b, by) => ({ line: wh().abcMine(by) }));
    on('GET', '/api/abc/classes', () => wh().abcClasses());
    on('GET', '/api/abc.csv', () => ({ contentType: 'text/csv; charset=utf-8', raw: wh().abcCsv({ reveal: abcReveal() }) }));
    on('POST', '/api/abc/settings', (_, q, b, by) => run('setAbc', { settings: b }, by));
    on('POST', '/api/abc/class', (_, q, b, by) => run('setAbcClass', b, by));
    on('POST', '/api/abc/plan', (_, q, b, by) => run('planAbc', {}, by));
    on('POST', '/api/abc/:id/count', ({ id }, q, b, by) => run('submitAbc', { id: decodeURIComponent(id), qty: b.qty, reason: b.reason || null }, by));
    on('POST', '/api/abc/:id/recount', ({ id }, q, b, by) => run('recountAbc', { id: decodeURIComponent(id), qty: b.qty, reason: b.reason || null }, by));
    on('POST', '/api/abc/:id/approve', ({ id }, q, b, by) => run('approveAbc', { id: decodeURIComponent(id) }, by));
    on('POST', '/api/abc/:id/reject', ({ id }, q, b, by) => run('rejectAbc', { id: decodeURIComponent(id), reason: b.reason }, by));
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
    on('GET', '/api/pallets/:sscc/serials', ({ sscc }) => wh().palletSerialList(sscc));
    on('POST', '/api/pallets/:sscc/serials', ({ sscc }, q, b, by) => run('palletSerials', { sscc, serials: b.serials }, by));
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
    on('POST', '/api/import/items', (_, q, b, by) => {
      if (mentionsValue(b) && !seesItemValue()) return valueDenied();
      return run('importItems', { rows: b.rows || b }, by);
    });
    on('POST', '/api/import/locations', (_, q, b, by) => run('importLocations', { rows: b.rows || b }, by));
    on('POST', '/api/import/orders', (_, q, b, by) => run('importOrders', { rows: b.rows || b, planOnce: true }, by));
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
      return { ...clientView(c), itemList: Object.values(wh().items).filter((i) => i.clientId === c.id).map(presentItem), stock: wh().stockForClient(c.id).filter((p) => p.status !== 'shipped').map((p) => palletView(wh(), p)) };
    });
    on('POST', '/api/clients', (_, q, b, by) => run('addClient', b, by));
    on('POST', '/api/clients/:id', ({ id }, q, b, by) => run('updateClient', { ...b, id: decodeURIComponent(id) }, by));
    on('POST', '/api/clients/:id/archive', ({ id }, q, b, by) => run('archiveClient', { id: decodeURIComponent(id) }, by));
    on('POST', '/api/clients/:id/restore', ({ id }, q, b, by) => run('restoreClient', { id: decodeURIComponent(id) }, by));
    on('POST', '/api/items', (_, q, b, by) => {
      if (mentionsValue(b) && !seesItemValue()) return valueDenied();
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
      if (mentionsValue(b) && !seesItemValue()) return valueDenied();
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
      const { PRESETS, FEATURES } = presetsLib();
      const { EXAMPLES, LEVELS } = locationsLib();
      return {
        setup: wh().setup || { completed: false },
        features: wh().features,
        categories: wh().categories,
        presets: PRESETS.map((p) => ({ id: p.id, name: p.name, summary: p.summary, features: p.features, modules: p.modules, locationPlan: p.locationPlan, virtual: p.virtual, categories: p.categories })),
        featureList: FEATURES.map(([id, label, hint]) => ({ id, label, hint })),
        modules: wh().moduleList(),
        examples: Object.values(EXAMPLES).map((ex) => ({ ...ex, preview: locationsLib().expand(ex.plan, { limit: 6 }) })),
        levels: LEVELS,
      };
    });
    on('POST', '/api/setup/preset', (_, q, b, by) => run('applyPreset', b, by));
    on('POST', '/api/categories', (_, q, b, by) => run('addCategory', b, by));
    on('GET', '/api/modules', () => wh().moduleList());
    on('POST', '/api/setup/modules', (_, q, b, by) => {
      try {
        return run('setModules', { modules: b.modules || b, enableDependencies: Boolean(b.enableDependencies), disableDependents: Boolean(b.disableDependents) }, by);
      } catch (e) {
        if (e.needs || e.dependents || e.conflicts) return { status: 409, error: e.message, needs: e.needs || null, dependents: e.dependents || null, conflicts: e.conflicts || null, offer: e.offer || null };
        throw e;
      }
    });
    on('POST', '/api/modules/:id/settings', ({ id }, q, b, by) => run('setModuleSettings', { id: decodeURIComponent(id), settings: b.settings || b }, by));
    on('POST', '/api/setup/features', (_, q, b, by) => run('setFeatures', { features: b.features || b }, by));
    on('POST', '/api/setup/complete', (_, q, b, by) => run('completeSetup', {}, by));
    on('POST', '/api/locations/preview', (_, q, b) => locationsLib().expand(b.plan || b, { limit: 24 }));
    on('POST', '/api/locations/generate', (_, q, b, by) => run('generateLocations', b, by));
    on('POST', '/api/items/:itemNo/units', ({ itemNo }, q, b, by) => run('setItemUnits', { ...b, itemNo: decodeURIComponent(itemNo) }, by));
    on('POST', '/api/items/:itemNo/serials', ({ itemNo }, q, b, by) => run('setItemSerials', { itemNo: decodeURIComponent(itemNo), on: b.on !== false }, by));
    on('GET', '/api/serials', (_, q) => wh().serialsIn({ loc: q.loc || null, itemNo: q.item || null }));
    on('GET', '/api/serials/:sn', ({ sn }) => wh().serialTrace(decodeURIComponent(sn)));
    on('GET', '/api/bins/suggest', (_, q) => wh().suggestBin(q.item || '', q.qty || 1));
    on('GET', '/api/bins', (_, q) => (q.item || q.itemNo ? wh().binsFor(q.item || q.itemNo) : wh().binList()));
    on('GET', '/api/bins/:code', ({ code }) => wh().binContents(decodeURIComponent(code)));
    on('POST', '/api/bins/put', (_, q, b, by) => run('binPut', b, by));
    on('POST', '/api/bins/take', (_, q, b, by) => run('binTake', b, by));
    on('POST', '/api/bins/move', (_, q, b, by) => run('binMove', b, by));
    on('POST', '/api/bins/refill', (_, q, b, by) => run('binRefill', b, by));
    on('POST', '/api/bins/count', (_, q, b, by) => run('binCount', b, by));
    on('GET', '/api/best-before', (_, q) => ({ on: wh().feature('lotExpiry'), days: Number(q.days || 14), rows: wh().feature('lotExpiry') ? wh().bestBeforeWatch({ days: q.days == null || q.days === '' ? 14 : Number(q.days) }) : [] }));
    on('POST', '/api/bins/:code/mode', ({ code }, q, b, by) => run('setBinMode', { code: decodeURIComponent(code), mixed: b.mixed }, by));
    on('GET', '/api/waves', () => Object.values(wh().waves || {}).slice(-30).reverse().map((w) => ({ ...w, tasks: w.tasks.map((t) => ({ ...t, ...wh().waveTaskReadiness(t) })) })));
    on('GET', '/api/waves/queue', () => ({ settings: wh().waveSettings(), active: wh().activeWave() ? wh().activeWave().id : null, queue: wh().waveQueue() }));
    on('POST', '/api/waves/config', (_, q, b, by) => run('setWaveConfig', { config: b }, by));
    on('GET', '/api/waves/tasks', (_, q, b, by) => wh().waveTasks({ kind: q.kind || null, for: q.mine ? by : null, readyOnly: Boolean(q.mine) }));
    on('POST', '/api/waves/tasks/:task/claim', ({ task }, q, b, by) => run('claimWaveTask', { task: decodeURIComponent(task) }, by));
    on('POST', '/api/waves/tasks/:task/release', ({ task }, q, b, by) => run('releaseWaveTask', { task: decodeURIComponent(task) }, by));
    on('POST', '/api/waves/tasks/:task/short', ({ task }, q, b, by) => run('shortWaveTask', { task: decodeURIComponent(task), found: b.found }, by));
    on('POST', '/api/waves', (_, q, b, by) => run('planWave', b, by));
    on('POST', '/api/waves/tasks/:task/confirm', ({ task }, q, b, by) => run('confirmWaveTask', { task: decodeURIComponent(task), scan: b.scan, serials: b.serials || null }, by));
    on('POST', '/api/waves/:id/cancel', ({ id }, q, b, by) => run('cancelWave', { id: decodeURIComponent(id) }, by));
    on('POST', '/api/locations/rename/preview', (_, q, b) => ({ pairs: wh().renamePlan(b) }));
    on('POST', '/api/locations/rename', (_, q, b, by) => run('renameLocations', b, by));
    on('GET', '/api/locations/aliases', () => wh().aliasList());
    on('POST', '/api/locations/aliases/drop', (_, q, b, by) => run('dropAliases', b, by));
    on('POST', '/api/locations/guided/preview', (_, q, b) => {
      const out = locationsLib().guided(b.answers || b, { limit: 24 });
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
    on('POST', '/api/cartons/:id/pack', ({ id }, q, b, by) => run('packIntoCarton', { carton: decodeURIComponent(id), code: b.code, qty: b.qty, serials: b.serials || null }, by));
    on('GET', '/api/cartons/:id/slip.html', ({ id }) => ({ contentType: 'text/html; charset=utf-8', raw: wh().packingSlipHtml(decodeURIComponent(id)) }));
    on('POST', '/api/cartons/:id/close', ({ id }, q, b, by) => run('closeCarton', { carton: decodeURIComponent(id), ...b }, by));
    on('POST', '/api/work-orders', (_, q, b, by) => run('addWorkOrder', b, by));
    on('POST', '/api/pick-faces', (_, q, b, by) => run('setPickFace', b, by));
    on('GET', '/api/replenishment', () => wh().replenishmentStatus().filter((r) => {
      const own = ownClient();
      return own == null || wh().items[r.itemNo]?.clientId === own;
    }));
    on('POST', '/api/replenishment/plan', (_, q, b, by) => run('planReplenishment', {}, by));
    on('GET', '/api/returns', (_, q) => wh().returnList({ status: q.status || null, orderId: q.order || null }));
    on('GET', '/api/orders/:id/returnable', ({ id }) => wh().returnable(decodeURIComponent(id)));
    on('POST', '/api/returns', (_, q, b, by) => run('receiveReturn', b, by));
    on('POST', '/api/returns/:id/grade', ({ id }, q, b, by) => run('gradeReturn', { ...b, id: decodeURIComponent(id) }, by));
    on('GET', '/api/reports/availability', () => wh().availability());
    on('GET', '/api/reports/availability.json', () => wh().availability());
    on('GET', '/api/reports/availability.csv', () => ({
      contentType: 'text/csv; charset=utf-8',
      raw: csv([['sku', 'name', 'onHand', 'allocated', 'held', 'reserved', 'available', 'reorderPoint', 'low'], ...wh().availability().map((r) => [r.sku, r.name, r.onHand, r.allocated, r.held, r.reserved, r.available, r.reorderPoint == null ? '' : r.reorderPoint, r.low ? 'yes' : 'no'])]),
    }));
    on('GET', '/api/alerts/low-stock', () => wh().lowStock());
    on('GET', '/api/shopify', () => (shopify ? { ...shopify.status(), mappings: null } : { status: 400, error: 'Shopify runs on the server' }));
    on('GET', '/api/shopify/map/:id', ({ id }) => (shopify ? shopify.mappings(id) : { status: 400, error: 'Shopify runs on the server' }));
    on('POST', '/api/shopify/shops', (_, q, b) => (shopify ? shopify.saveShop(b || {}) : { status: 400, error: 'Shopify runs on the server' }));
    on('POST', '/api/shopify/map', (_, q, b) => (shopify ? shopify.mapSku(b.shopId, b.sku, b.itemNo, b) : { status: 400, error: 'Shopify runs on the server' }));
    on('POST', '/api/shopify/sync', (_, q, b) => (shopify ? shopify.pull(b.shopId) : { status: 400, error: 'Shopify runs on the server' }));
    on('POST', '/api/shopify/catalog', (_, q, b) => (shopify ? shopify.pullProducts(b.shopId) : { status: 400, error: 'Shopify runs on the server' }));
    on('POST', '/api/shopify/stock', () => (shopify ? shopify.flushStock() : { status: 400, error: 'Shopify runs on the server' }));
    on('GET', '/api/alerts/low-stock.csv', () => ({
      contentType: 'text/csv; charset=utf-8',
      raw: csv([['sku', 'name', 'onHand', 'available', 'reorderPoint'], ...wh().lowStock().map((r) => [r.sku, r.name, r.onHand, r.available, r.reorderPoint == null ? '' : r.reorderPoint])]),
    }));
    on('GET', '/api/notify', () => (alerts ? alerts.status(currentActor) : { status: 400, error: 'Alerts run on the server. Start it with ./start.sh' }));
    on('POST', '/api/notify/settings', (_, q, b) => {
      if (!alerts) return { status: 400, error: 'Alerts run on the server. Start it with ./start.sh' };
      alerts.save(b || {}, currentActor);
      return { ok: true };
    });
    on('POST', '/api/notify/test', () => (alerts ? alerts.testSend(currentActor) : { status: 400, error: 'Alerts run on the server. Start it with ./start.sh' }));
    on('GET', '/api/notify/inbox', () => (alerts ? alerts.inbox(currentActor) : { unread: [] }));
    on('POST', '/api/notify/read', (_, q, b) => (alerts ? alerts.markRead(currentActor, b.ids || []) : { unread: [] }));
    on('POST', '/api/notify/subscribe', (_, q, b) => {
      if (!alerts) return { status: 400, error: 'Alerts run on the server. Start it with ./start.sh' };
      return alerts.subscribe(currentActor, b || {});
    });
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
    on('GET', '/api/backups', () => (backups ? { dir: backups.dir, backups: backups.list().map(({ file, bytes, at }) => ({ file, bytes, at })) } : { dir: null, backups: [] }));
    on('GET', '/api/offsite', () => {
      if (!offsite) return { status: 400, error: 'Off-site backups run on the server. Start it with ./start.sh' };
      return offsite.status();
    });
    on('POST', '/api/offsite/settings', (_, q, b) => {
      if (!offsite) return { status: 400, error: 'Off-site backups run on the server. Start it with ./start.sh' };
      offsite.save(b || {});
      return { ok: true };
    });
    on('POST', '/api/offsite/run', () => {
      if (!offsite) return { status: 400, error: 'Off-site backups run on the server. Start it with ./start.sh' };
      return offsite.run('admin');
    });
    on('POST', '/api/offsite/restore', (_, q, b) => {
      if (!offsite) return { status: 400, error: 'Off-site backups run on the server. Start it with ./start.sh' };
      return offsite.restore({ targetId: b.targetId, name: b.name, file: b.file || null });
    });
    on('POST', '/api/offsite/prune-plain', (_, q, b) => {
      if (!offsite) return { status: 400, error: 'Off-site backups run on the server. Start it with ./start.sh' };
      return offsite.prunePlain({ confirm: b.confirm === true });
    });
    on('POST', '/api/backups', () => {
      if (!backups) return { status: 400, error: 'Backups are made by the server. Start it with ./start.sh' };
      const made = backups.now();
      return { file: made.file, bytes: made.bytes };
    });
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
    on('GET', '/api/search', (_, q) => {
      const found = wh().search(q.q || '');
      return { ...found, items: (found.items || []).map(presentItem) };
    });
    on('GET', '/api/exceptions', () => ({
      held: Object.values(wh().tasks).filter((t) => t.status === 'held' && !t.replacedBy).map((t) => taskView(wh(), t)),
      blocked: wh()._livePallets().filter((p) => p.status === 'blocked').map((p) => palletView(wh(), p)),
      lost: wh().lostPallets().map((p) => palletView(wh(), p)),
      faults: (wh().faults || []).filter((f) => f.status === 'open'),
      quality: wh()._livePallets().filter((p) => p.qualityHold).map((p) => palletView(wh(), p)),
    }));
    on('GET', '/api/reports/area', (_, q) => wh().reportArea(q, ownClient()));
    on('GET', '/api/reports/area/:name.csv', ({ name }, q) => {
      try { return { contentType: 'text/csv; charset=utf-8', raw: wh().reportCsv(decodeURIComponent(name), q, ownClient()) }; }
      catch (e) { return { status: e.status || 400, error: e.message }; }
    });
    on('GET', '/api/reports/area/:name', ({ name }, q) => {
      const report = wh().reportById(decodeURIComponent(name), q, ownClient());
      if (report.hidden) return { status: 404, error: report.reason };
      return report;
    });
    on('GET', '/api/reports/stock', () => wh().stockSummary().map((r) => ({ itemNo: r.item.itemNo, name: r.item.name, clientId: r.item.clientId || null, category: r.item.category, available: r.available, short: r.short, blocked: r.blocked, qty: r.qty, batches: r.batches, nextExpiry: r.next && r.next.expiry })));
    on('GET', '/api/reports/expiry', (_, q) => {
      const days = Math.min(Math.max(Number(q.days) || 30, 0), 3650);
      return wh()._livePallets().filter((p) => p.loc && p.status !== 'shipped' && wh().daysLeft(p) <= days).sort((a, b) => (a.expiry < b.expiry ? -1 : 1)).slice(0, 500).map((p) => ({ ...palletView(wh(), p), daysLeft: wh().daysLeft(p) }));
    });
    on('GET', '/api/reports/orders', () => Object.values(wh().orders).map((o) => ({ id: o.id, customer: o.customer, clientId: o.clientId || null, status: o.status, lane: o.lane, pallets: o.lines.reduce((n, l) => n + l.allocated.length, 0), short: o.lines.reduce((n, l) => n + l.short, 0) })));
    on('POST', '/api/item-value/currency', (_, q, b, by) => run('setCurrency', { currency: b.currency }, by));
    on('GET', '/api/reports/stock-value', (_, q) => {
      if (!seesItemValue()) return valueDenied();
      const own = ownClient();
      return wh().stockValueReport({ client: own || q.client || q.clientId || null });
    });
    on('GET', '/api/reports/stock-value.csv', (_, q) => {
      if (!seesItemValue()) return valueDenied();
      const own = ownClient();
      const report = wh().stockValueReport({ client: own || q.client || q.clientId || null });
      const head = ['client', 'item', 'name', 'location', 'qty', 'unit value', 'value', 'currency'];
      const rows = report.rows.map((r) => [r.client, r.itemNo, r.name, r.location, r.qty, r.unitValue == null ? '' : r.unitValue, r.value, r.currency]);
      return { contentType: 'text/csv; charset=utf-8', raw: csv([head, ...rows, ['', '', '', '', '', '', report.total, report.currency]]) };
    });
    on('GET', '/api/reports/stock.csv', () => ({
      contentType: 'text/csv; charset=utf-8',
      raw: csv([['item', 'name', 'client', 'category', 'available', 'short', 'blocked', 'qty', 'batches'], ...wh().stockSummary().map((r) => [r.item.itemNo, r.item.name, r.item.clientId || '', r.item.category, r.available, r.short, r.blocked, r.qty, r.batches])]),
    }));
    on('GET', '/api/woocommerce', () => (woo ? { ...woo.status(), mappings: null } : { status: 400, error: 'WooCommerce runs on the server' }));
    on('GET', '/api/woocommerce/map/:id', ({ id }) => (woo ? woo.mappings(id) : { status: 400, error: 'WooCommerce runs on the server' }));
    on('POST', '/api/woocommerce/shops', (_, q, b) => (woo ? woo.saveShop(b || {}) : { status: 400, error: 'WooCommerce runs on the server' }));
    on('POST', '/api/woocommerce/map', (_, q, b) => (woo ? woo.mapSku(b.shopId, b.sku, b.itemNo, b) : { status: 400, error: 'WooCommerce runs on the server' }));
    on('POST', '/api/woocommerce/sync', (_, q, b) => (woo ? woo.pull(b.shopId) : { status: 400, error: 'WooCommerce runs on the server' }));
    on('POST', '/api/woocommerce/catalog', (_, q, b) => (woo ? woo.pullProducts(b.shopId) : { status: 400, error: 'WooCommerce runs on the server' }));
    on('POST', '/api/woocommerce/stock', () => (woo ? woo.flushStock() : { status: 400, error: 'WooCommerce runs on the server' }));
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
    function handle(method, rawUrl, body = {}, by = 'office', requestId = null, actor = null, raw = '', signature = '') {
      currentActor = actor || null;
      rawBody = typeof raw === 'string' ? raw : '';
      webhookHeader = signature || '';
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

    function handleOnce(method, rawUrl, body, by) {
      const url = new URL(rawUrl, 'http://x');
      const reg = registryLib();
      const denied = reg && reg.denial(wh(), method, url.pathname);
      if (denied) return denied;
      const route = routes.find((r) => r.method === method && r.re.test(url.pathname));
      if (!route) return { status: 404, body: { error: `No route ${method} ${url.pathname}` } };
      const answer = (out) => {
      if (out && out.contentType) return { status: out.status || 200, body: out.raw != null ? out.raw : out.body, contentType: out.contentType };
      if (out && out.status && out.error) return { status: out.status, body: { error: out.error, needs: out.needs, dependents: out.dependents, conflicts: out.conflicts, offer: out.offer, module: out.module } };
      return { status: 200, body: out === undefined ? { ok: true } : out };
      };
      try {
        const out = route.fn(url.pathname.match(route.re).groups || {}, Object.fromEntries(url.searchParams), body || {}, by);
        // Asking a printer goes over the network: those routes answer with a promise.
        if (out && typeof out.then === 'function') return out.then(answer, (e) => ({ status: e.status || 400, body: { error: e.message } }));
        return answer(out);
      } catch (e) {
        return { status: e.status || 400, body: { error: e.message } };
      }
    }

    return { handle };
  }

  return { createApi, deviceView, summary, placeName, lookupView };
});
