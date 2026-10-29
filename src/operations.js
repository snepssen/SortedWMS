/*
 * Order-driven floor work that sits on the reach-truck engine: piece picks,
 * kit work orders, cartons, pick-face replenishment, returns, availability
 * and 3PL charges. Installed onto Warehouse.prototype from foundation.js.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SortedOperations = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function positive(value, label) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`${label} must be a number above 0`);
    return n;
  }

  function whole(value, label) {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1) throw new Error(`${label} must be a whole number above 0`);
    return n;
  }

  function install(Warehouse, deps) {
    const Labels = (deps && deps.Labels) || (typeof globalThis !== 'undefined' && globalThis.Labels) || null;
    const proto = Warehouse.prototype;

    proto.addWorkOrder = function ({ id, kitId, qty, orderId = null, by } = {}) {
      const key = String(id || '').trim();
      if (!key) throw new Error('A work order needs an id');
      this.workOrders = this.workOrders || {};
      if (this.workOrders[key]) throw new Error(`Work order ${key} already exists`);
      const kit = this.kits[kitId];
      if (!kit) throw new Error(`Unknown kit ${kitId}`);
      const amount = whole(qty, 'Work order quantity');
      if (orderId && !this.orders[String(orderId)]) throw new Error(`No order ${orderId}`);
      const wo = {
        id: key, kitId: kit.id, output: kit.output || kit.base.itemNo, qty: amount, built: 0,
        orderId: orderId ? String(orderId) : null, status: 'open', consumed: [],
        createdAt: this.now(), by: by || this._actor || 'operator',
      };
      this.workOrders[key] = wo;
      this.log(`Work order ${key}: ${amount} × ${kit.name}`);
      return wo;
    };

    proto._advanceWorkOrder = function (job, by) {
      const wo = (this.workOrders || {})[job.workOrderId];
      if (!wo) return job;
      wo.built += 1;
      wo.consumed.push({ t: this.now(), by, got: job.got.map((g) => ({ ...g })) });
      if (wo.orderId) {
        const order = this.orders[wo.orderId];
        const line = order && order.lines.find((l) => l.kind === 'each' && (l.kitId === wo.kitId || l.itemNo === wo.output) && (l.picked || 0) < l.units);
        if (line) {
          line.picked = (line.picked || 0) + 1;
          line.picks = line.picks || [];
          line.picks.push({ workOrderId: wo.id, qty: 1, t: this.now(), by });
          order.staged = order.staged || [];
          order.staged.push({ itemNo: line.itemNo, qty: 1, holder: wo.id, batch: null, expiry: null });
          const piece = order.lines.filter((l) => l.kind === 'each');
          if (!order.lines.some((l) => l.pallets)) order.status = piece.every((l) => (l.picked || 0) >= l.units) ? 'ready' : 'picking';
        }
      }
      if (wo.built >= wo.qty) {
        wo.status = 'done';
        job.status = 'done';
      } else {
        job.got = [];
        job.status = 'open';
      }
      return job;
    };

    proto.openCarton = function ({ orderId, by } = {}) {
      const order = this.orders[String(orderId)];
      if (!order) throw new Error(`No order ${orderId}`);
      if (order.status === 'shipped') throw new Error(`Order ${order.id} is shipped`);
      const minted = this.allocatePlate('OUT');
      const carton = this._makePlate(minted, { type: 'carton', loc: null, clientId: order.clientId || null, contents: [] });
      carton.orderId = order.id;
      carton.cartonStatus = 'open';
      carton.packed = [];
      carton.customer = order.customer;
      this.recordMovement({ holder: carton.id, from: null, to: null, qty: null, event: 'labelled', by: by || this._actor || 'office', note: order.id });
      this.log(`Carton ${carton.id} opened for order ${order.id}`);
      return carton;
    };

    proto.packIntoCarton = function ({ carton, code, qty = 1, by } = {}) {
      const box = this._holder(carton);
      if (box.series !== 'OUT' || box.cartonStatus !== 'open') throw new Error(`${box.id} is not an open carton`);
      const take = whole(qty, 'Pack quantity');
      const order = this.orders[box.orderId];
      const key = String(code || '').trim().toUpperCase();
      const holder = this.holders[key] || null;
      const staged = (order.staged || []).find((s) => ((holder && s.holder === holder.id) || (!holder && s.holder === key)) && Number(s.qty) >= take);
      const content = staged || (holder && (holder.contents || []).find((c) => Number(c.qty) >= take));
      if (!content) throw new Error(`${code} does not have ${take} to pack`);
      if (!order.lines.some((l) => l.itemNo === content.itemNo)) throw new Error(`${content.itemNo} is not on order ${order.id}`);
      content.qty -= take;
      if (!staged && holder) {
        const line = order.lines.find((l) => l.kind === 'each' && l.itemNo === content.itemNo && (l.picked || 0) < l.units);
        if (line) line.picked = Math.min(line.units, (line.picked || 0) + take);
      }
      const fromId = holder ? holder.id : content.holder || null;
      const row = { itemNo: content.itemNo, qty: take, from: fromId, batch: content.batch || null, expiry: content.expiry || null };
      box.packed.push(row);
      box.contents = box.packed.map((p) => ({ ...p }));
      this.recordMovement({ holder: fromId, from: holder ? holder.loc : null, to: box.id, qty: take, event: 'packed', by: by || this._actor || 'office', note: order.id });
      this.log(`Packed ${content.itemNo} × ${take} into ${box.id}`);
      return box;
    };

    proto.closeCarton = function ({ carton, lengthMm, widthMm, heightMm, weightKg, by } = {}) {
      const box = this._holder(carton);
      if (box.cartonStatus !== 'open') throw new Error(`${box.id} is not an open carton`);
      if (!box.packed.length) throw new Error('An empty carton cannot be closed');
      box.lengthMm = positive(lengthMm, 'Length');
      box.widthMm = positive(widthMm, 'Width');
      box.heightMm = positive(heightMm, 'Height');
      box.weightKg = positive(weightKg, 'Weight');
      box.cartonStatus = 'closed';
      box.closedAt = this.now();
      const order = this.orders[box.orderId];
      const lines = box.packed.map((p) => ({ ...p, name: this.items[p.itemNo] ? this.items[p.itemNo].name : '' }));
      const slipData = { plate: box.id, orderId: order.id, customer: order.customer, lengthMm: box.lengthMm, widthMm: box.widthMm, heightMm: box.heightMm, weightKg: box.weightKg, lines };
      const zpl = Labels && Labels.packingSlip ? Labels.packingSlip(slipData) : '';
      const qty = box.packed.reduce((s, p) => s + p.qty, 0);
      const label = this._printPlate(box, { itemNo: box.packed[0].itemNo, itemName: lines[0].name, qty, location: order.lane, orderId: order.id });
      const slip = { id: ++this._seq.label, kind: 'slip', plate: box.id, sscc: null, at: this.now(), printer: 'SIM', data: { ...slipData, kind: 'slip', title: `Packing slip ${box.id}` }, zpl };
      this.labelLog.unshift(slip);
      this.printQueue.unshift({ id: slip.id, printer: 'SIM', at: slip.at, label: slip.data, zpl });
      const piece = order.lines.filter((l) => l.kind === 'each');
      const packedOf = (itemNo) => Object.values(this.holders).filter((h) => h.orderId === order.id && h.series === 'OUT' && h.cartonStatus && h.cartonStatus !== 'open').reduce((s, h) => s + h.packed.filter((p) => p.itemNo === itemNo).reduce((n, p) => n + p.qty, 0), 0);
      if (piece.length && piece.every((l) => (l.picked || 0) >= l.units && packedOf(l.itemNo) >= l.units) && !order.lines.some((l) => l.pallets)) order.status = 'packed';
      this.recordMovement({ holder: box.id, from: null, to: order.lane, qty, event: 'packed', by: by || this._actor || 'office', note: `${box.lengthMm}×${box.widthMm}×${box.heightMm} mm, ${box.weightKg} kg` });
      this.log(`Closed carton ${box.id} for order ${order.id}`);
      return { carton: box, label, slip };
    };

    proto.dispatchCartons = function ({ orderId, by } = {}) {
      const order = this.orders[String(orderId)];
      if (!order) throw new Error(`No order ${orderId}`);
      const boxes = Object.values(this.holders || {}).filter((h) => h.orderId === order.id && h.series === 'OUT' && h.cartonStatus === 'closed');
      if (!boxes.length) throw new Error('No closed cartons to dispatch');
      const piece = order.lines.filter((l) => l.kind === 'each');
      for (const line of piece) {
        const packed = boxes.reduce((s, h) => s + h.packed.filter((p) => p.itemNo === line.itemNo).reduce((n, p) => n + p.qty, 0), 0);
        if ((line.picked || 0) < line.units || packed < line.units) throw new Error(`Order ${order.id} still needs ${line.itemNo} packed`);
      }
      const actor = by || this._actor || 'office';
      for (const box of boxes) {
        const from = box.loc;
        box.loc = order.lane;
        box.cartonStatus = 'shipped';
        const qty = box.packed.reduce((s, p) => s + p.qty, 0);
        this.recordMovement({ holder: box.id, from, to: order.lane, qty, event: 'shipped', by: actor, note: order.id });
      }
      if (!order.lines.some((l) => l.pallets)) {
        order.status = 'shipped';
        order.shippedAt = this.now();
        (this.shipments = this.shipments || []).push({ orderId: order.id, customer: order.customer, t: this.now(), cartons: boxes.map((b) => b.id), pallets: [] });
      }
      this.log(`Dispatched ${boxes.length} carton(s) for order ${order.id}`);
      return { order, cartons: boxes };
    };

    proto.setPickFace = function ({ code, itemNo, min, max, trigger = null } = {}) {
      const loc = this._loc(this.resolve(code));
      if (!['bin', 'mezzanine', 'rack'].includes(loc.kind) || loc.structural) throw new Error('A pick face is a bin, mezzanine or rack');
      const item = this.items[itemNo];
      if (!item) throw new Error(`Unknown item ${itemNo}`);
      const minN = Number(min);
      const maxN = Number(max);
      if (!Number.isInteger(minN) || minN < 0) throw new Error('Minimum must be a whole number of 0 or more');
      if (!Number.isInteger(maxN) || maxN < minN) throw new Error('Maximum must be a whole number at or above the minimum');
      const trig = trigger == null || trigger === '' ? minN : Number(trigger);
      if (!Number.isInteger(trig) || trig < minN || trig > maxN) throw new Error('The trigger sits between the minimum and the maximum');
      const mode = arguments[0].mode === 'pallet' ? 'pallet' : 'units';
      loc.replenishment = { itemNo: item.itemNo, min: minN, max: maxN, trigger: trig, mode };
      this.log(`Pick face ${loc.code}: ${item.itemNo} min ${minN} trigger ${trig} max ${maxN} (${mode})`);
      return loc.replenishment;
    };

    proto._faceQty = function (loc) {
      const spec = loc.replenishment;
      if (!spec) return 0;
      let n = 0;
      if (loc.sscc && this.pallets[loc.sscc] && this.pallets[loc.sscc].itemNo === spec.itemNo && this.pallets[loc.sscc].status !== 'shipped') n += this.pallets[loc.sscc].qty;
      for (const id of loc.pallets || []) {
        const p = this.pallets[id];
        if (p && p.itemNo === spec.itemNo && p.status !== 'shipped') n += p.qty;
      }
      for (const h of Object.values(this.holders || {})) {
        if (h.loc !== loc.code || h.sscc) continue;
        for (const c of h.contents || []) if (c.itemNo === spec.itemNo) n += Number(c.qty) || 0;
      }
      return n;
    };

    proto.planReplenishment = function () {
      const created = [];
      for (const loc of Object.values(this.locations)) {
        const spec = loc.replenishment;
        if (!spec) continue;
        const onHand = this._faceQty(loc);
        if (onHand > spec.trigger) continue;
        const open = Object.values(this.tasks).some((t) => t.reason === 'replenish' && t.to === loc.code && t.status !== 'done' && t.status !== 'cancelled');
        if (open) continue;
        const need = spec.max - onHand;
        if (need < 1) continue;
        try {
          if (spec.mode === 'pallet') {
            created.push(this.replenish(spec.itemNo, loc.code, { topUp: true }));
            continue;
          }
          const source = this._fefo(spec.itemNo).find((p) => p.loc !== loc.code);
          if (!source) continue;
          if (source.qty <= need) {
            created.push(this.replenish(spec.itemNo, loc.code, { topUp: true }));
            continue;
          }
          const task = this._newTask({
            type: 'SHIFT', reason: 'replenish', sscc: source.sscc, from: source.loc, to: loc.code,
            category: this.items[spec.itemNo].category, splitQty: need,
          });
          loc.reservedBy = task.id;
          this.log(`Replenish ${need} of ${spec.itemNo} → ${loc.code} split from …${source.sscc.slice(-6)}`, { taskId: task.id });
          this.dispatch();
          created.push(task);
        } catch (e) { /* no free pallet, or the face cannot take one */ }
      }
      if (created.length) this.log(`${created.length} replenishment move(s) queued`);
      return created;
    };

    proto.applySplitDrop = function (truck, task) {
      const pallet = this.pallets[truck.load];
      const qty = Number(task.splitQty);
      if (!pallet || !Number.isInteger(qty) || qty < 1 || pallet.qty <= qty) throw new Error('Split replenishment needs a source plate with more than the top-up');
      const to = this.locations[task.to];
      if (to && to.reservedBy === task.id) to.reservedBy = null;
      const fromLoc = task.from;
      pallet.qty -= qty;
      this._place(pallet, fromLoc);
      const minted = this.allocatePlate('ST');
      const holder = this._makePlate(minted, {
        type: 'st', loc: task.to, clientId: pallet.clientId || null,
        contents: [{ itemNo: pallet.itemNo, qty, batch: pallet.batch, expiry: pallet.expiry, clientId: pallet.clientId || null }],
      });
      const actor = this._actor || truck.id;
      this.recordMovement({ sscc: pallet.sscc, holder: pallet.holderId || null, from: fromLoc, to: fromLoc, qty: pallet.qty, event: 'moved', by: actor, note: `Split ${qty} onto ${holder.id}` });
      this.recordMovement({ holder: holder.id, from: fromLoc, to: task.to, qty, event: 'moved', by: actor, note: 'replenishment' });
      truck.load = null;
      truck.position = task.to;
      task.alert = null;
      this._finish(truck, task);
      this.log(`Top-up ${qty} of ${pallet.itemNo} at ${task.to} on ${holder.id}`);
      this.dispatch();
      return { task, holder, source: pallet };
    };

    proto.receiveReturn = function ({ id, orderId, itemNo, qty, loc = null, by } = {}) {
      const order = this.orders[String(orderId)];
      if (!order) throw new Error(`No order ${orderId}`);
      if (!order.lines.some((l) => l.itemNo === itemNo)) throw new Error(`${itemNo} was not on order ${order.id}`);
      const amount = whole(qty, 'Return quantity');
      const code = loc ? this.resolve(loc) : null;
      if (code) {
        const place = this._loc(code);
        if (place.kind !== 'virtual' || !['return', 'quarantine', 'staging'].includes(place.role)) throw new Error('Receive a return at a virtual return, quarantine or staging location');
      }
      this.returns = this.returns || {};
      const rid = String(id || '').trim();
      if (!rid) throw new Error('A return needs an id');
      if (this.returns[rid]) throw new Error(`Return ${rid} already exists`);
      const actor = by || this._actor || 'office';
      const rma = { id: rid, orderId: order.id, itemNo, qty: amount, loc: code, status: 'received', grade: null, holderId: null, receivedAt: this.now(), by: actor, history: [{ t: this.now(), event: 'received', by: actor, to: code, qty: amount }] };
      this.returns[rid] = rma;
      this.recordMovement({ from: null, to: code, qty: amount, event: 'received', by: actor, note: `RMA ${rid} order ${order.id}` });
      this.log(`Return ${rid} received for order ${order.id}: ${itemNo} × ${amount}`);
      return rma;
    };

    proto.gradeReturn = function ({ id, grade, to = null, by } = {}) {
      const rma = (this.returns || {})[String(id)];
      if (!rma) throw new Error(`Unknown return ${id}`);
      if (rma.status !== 'received') throw new Error(`Return ${rma.id} is already ${rma.status}`);
      if (!['restock', 'quarantine', 'scrap'].includes(grade)) throw new Error('Grade a return as restock, quarantine or scrap');
      const actor = by || this._actor || 'office';
      if (grade === 'scrap') {
        rma.status = 'scrapped';
        rma.grade = 'scrap';
        rma.history.push({ t: this.now(), event: 'scrapped', by: actor, qty: rma.qty });
        this.recordMovement({ from: rma.loc, to: null, qty: rma.qty, event: 'scrapped', by: actor, note: `RMA ${rma.id}` });
        this.log(`Return ${rma.id} scrapped`);
        return rma;
      }
      const dest = this.resolve(to);
      const place = this._loc(dest);
      if (grade === 'quarantine') {
        if (place.kind !== 'virtual' || place.role !== 'quarantine') throw new Error('Quarantine a return at a virtual quarantine location');
        rma.status = 'quarantine';
      } else if (place.kind === 'virtual' && place.role !== 'staging') throw new Error('Restock into a bin, mezzanine, rack or staging location');
      const minted = this.allocatePlate('ST');
      const holder = this._makePlate(minted, { type: 'st', loc: dest, contents: [{ itemNo: rma.itemNo, qty: rma.qty, batch: `RMA-${rma.id}`, expiry: null }] });
      rma.holderId = holder.id;
      rma.loc = dest;
      rma.grade = grade;
      if (grade === 'restock') rma.status = 'restocked';
      rma.history.push({ t: this.now(), event: grade, by: actor, to: dest, qty: rma.qty, holder: holder.id });
      this.recordMovement({ holder: holder.id, from: null, to: dest, qty: rma.qty, event: grade === 'quarantine' ? 'moved' : 'received', by: actor, note: `RMA ${rma.id} ${grade}` });
      this.log(`Return ${rma.id} graded ${grade} at ${dest}`);
      return rma;
    };

    proto.exportStock = function ({ itemNo, qty, toSite, fromSite = null, by } = {}) {
      const amount = whole(qty, 'Transfer quantity');
      if (!toSite) throw new Error('A destination warehouse is required');
      const item = this.items[itemNo];
      if (!item) throw new Error(`Unknown item ${itemNo}`);
      const actor = by || this._actor || 'office';
      const pallet = Object.values(this.pallets).find((p) => p.itemNo === itemNo && p.status !== 'shipped' && p.loc && !p.orderId && p.qty === amount);
      let batch = null;
      let expiry = null;
      let clientId = item.clientId || null;
      if (pallet) {
        batch = pallet.batch;
        expiry = pallet.expiry;
        clientId = pallet.clientId || clientId;
        const from = pallet.loc;
        this._remove(pallet);
        pallet.status = 'shipped';
        pallet.transferredTo = String(toSite);
        this.recordMovement({ sscc: pallet.sscc, holder: pallet.holderId || null, from, to: `SITE-${toSite}`, qty: amount, event: 'transferred', by: actor, note: String(toSite) });
      } else {
        const holder = Object.values(this.holders || {}).find((h) => h.status !== 'retired' && !h.cartonStatus && (h.contents || []).some((c) => c.itemNo === itemNo && Number(c.qty) >= amount) && !(h.sscc && this.pallets[h.sscc] && this.pallets[h.sscc].orderId));
        if (!holder) throw new Error(`No ${itemNo} stock of ${amount} to transfer`);
        const line = holder.contents.find((c) => c.itemNo === itemNo && Number(c.qty) >= amount);
        line.qty -= amount;
        batch = line.batch || null;
        expiry = line.expiry || null;
        clientId = line.clientId || holder.clientId || clientId;
        this.recordMovement({ holder: holder.id, from: holder.loc, to: `SITE-${toSite}`, qty: amount, event: 'transferred', by: actor, note: String(toSite) });
      }
      this.log(`Transferred ${itemNo} × ${amount} to ${toSite}`);
      return { itemNo, qty: amount, batch, expiry, clientId, fromSite: fromSite || 'MAIN', toSite: String(toSite) };
    };

    proto.importStock = function ({ itemNo, qty, batch = null, expiry = null, clientId = null, fromSite = null, by } = {}) {
      const item = this.items[itemNo];
      if (!item) throw new Error(`This warehouse has no item ${itemNo}`);
      const amount = whole(qty, 'Transfer quantity');
      const loc = this.locations['DOCK-IN'] ? 'DOCK-IN' : Object.keys(this.locations)[0];
      if (!loc) throw new Error('This warehouse has nowhere to receive a transfer');
      const minted = this.allocatePlate('ST');
      const holder = this._makePlate(minted, {
        type: 'st', loc, clientId: clientId || item.clientId || null,
        contents: [{ itemNo, qty: amount, batch, expiry, clientId: clientId || item.clientId || null }],
      });
      this.recordMovement({ holder: holder.id, from: fromSite ? `SITE-${fromSite}` : null, to: loc, qty: amount, event: 'received', by: by || this._actor || 'office', note: fromSite || 'transfer' });
      this.log(`Received ${itemNo} × ${amount} from ${fromSite || 'a transfer'} as ${holder.id}`);
      return { holder, itemNo, qty: amount, batch, expiry, clientId, fromSite };
    };

    function htmlEscape(value) {
      return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    proto.stageShipment = function ({ orderId, truck = null, by } = {}) {
      const order = this.orders[String(orderId)];
      if (!order) throw new Error(`No order ${orderId}`);
      if (order.status === 'shipped') throw new Error(`Order ${order.id} is shipped`);
      const piece = order.lines.filter((l) => l.kind === 'each');
      for (const line of piece) if ((line.picked || 0) < line.units) throw new Error(`Order ${order.id} still needs ${line.itemNo} picked`);
      const holders = [];
      for (const sscc of order.lines.flatMap((l) => l.allocated || [])) {
        const pallet = this.pallets[sscc];
        if (!pallet) throw new Error(`Missing pallet ${sscc}`);
        holders.push({ kind: 'pallet', id: pallet.holderId || pallet.sscc, sscc: pallet.sscc, itemNo: pallet.itemNo, qty: pallet.qty, loc: pallet.loc, loaded: false });
      }
      const boxes = Object.values(this.holders || {}).filter((h) => h.orderId === order.id && h.series === 'OUT' && (h.cartonStatus === 'closed' || h.cartonStatus === 'staged'));
      for (const line of piece) {
        const packed = boxes.reduce((s, h) => s + (h.packed || []).filter((p) => p.itemNo === line.itemNo).reduce((n, p) => n + p.qty, 0), 0);
        if (packed < line.units) throw new Error(`Order ${order.id} still needs ${line.itemNo} packed`);
      }
      for (const box of boxes) {
        const qty = (box.packed || []).reduce((s, p) => s + p.qty, 0);
        holders.push({ kind: 'carton', id: box.id, sscc: null, itemNo: box.packed[0] ? box.packed[0].itemNo : null, qty, loc: box.loc, loaded: false });
        box.cartonStatus = 'staged';
      }
      if (!holders.length) throw new Error('Nothing to dispatch');
      const actor = by || this._actor || 'office';
      order.shipment = {
        status: 'staged', lane: order.lane, truck: truck ? String(truck).slice(0, 40) : null,
        holders, scans: [], stagedAt: this.now(), by: actor,
      };
      this.log(`Shipment for ${order.id} staged: ${holders.length} holder(s) on ${order.lane}`);
      return order.shipment;
    };

    proto.scanShipment = function ({ orderId, code, by } = {}) {
      const order = this.orders[String(orderId)];
      if (!order || !order.shipment) throw new Error(`Order ${orderId} has no staged shipment`);
      const ship = order.shipment;
      if (ship.status === 'dispatched') throw new Error(`Order ${order.id} is already dispatched`);
      const key = String(code || '').trim().toUpperCase();
      if (!key) throw new Error('Scan a pallet or a carton');
      const line = ship.holders.find((h) => h.id === key || h.sscc === key);
      if (!line) throw new Error(`${key} is not on this load`);
      if (line.loaded) throw new Error(`${key} is already confirmed`);
      if (line.kind === 'pallet') {
        const pallet = this.pallets[line.sscc];
        if (!pallet || pallet.loc !== ship.lane) throw new Error(`${key} is not at ${ship.lane}`);
      }
      line.loaded = true;
      line.loadedAt = this.now();
      line.loadedBy = by || this._actor || 'office';
      ship.scans.push({ code: key, t: line.loadedAt, by: line.loadedBy });
      ship.status = ship.holders.every((h) => h.loaded) ? 'loaded' : 'staged';
      this.recordMovement({ holder: line.kind === 'carton' ? line.id : null, sscc: line.sscc, from: line.loc, to: ship.lane, qty: line.qty, event: 'moved', by: line.loadedBy, note: `Load ${order.id}` });
      this.log(`Loaded ${key} on ${order.id} (${ship.holders.filter((h) => h.loaded).length}/${ship.holders.length})`);
      return ship;
    };

    proto.dispatchShipment = function ({ orderId, by } = {}) {
      const order = this.orders[String(orderId)];
      if (!order || !order.shipment) throw new Error(`Order ${orderId} has no staged shipment`);
      const ship = order.shipment;
      if (ship.status !== 'loaded') throw new Error('Confirm every pallet and carton before dispatch');
      const actor = by || this._actor || 'office';
      const shippedPallets = [];
      for (const line of ship.holders.filter((h) => h.kind === 'pallet')) {
        const pallet = this.pallets[line.sscc];
        const fromLoc = pallet.loc;
        this._remove(pallet);
        pallet.status = 'shipped';
        this.recordMovement({ holder: pallet.holderId || null, sscc: pallet.sscc, from: fromLoc, to: null, qty: pallet.qty, event: 'shipped', by: actor, note: order.id });
        shippedPallets.push({ sscc: pallet.sscc, itemNo: pallet.itemNo, qty: pallet.qty });
      }
      const shippedCartons = [];
      for (const line of ship.holders.filter((h) => h.kind === 'carton')) {
        const box = this.holders[line.id];
        box.cartonStatus = 'shipped';
        box.loc = ship.lane;
        this.recordMovement({ holder: box.id, from: line.loc, to: ship.lane, qty: line.qty, event: 'shipped', by: actor, note: order.id });
        shippedCartons.push(box.id);
      }
      ship.status = 'dispatched';
      ship.dispatchedAt = this.now();
      ship.dispatchedBy = actor;
      order.status = 'shipped';
      order.shippedAt = this.now();
      const record = { orderId: order.id, customer: order.customer, t: this.now(), lane: ship.lane, truck: ship.truck, pallets: shippedPallets, cartons: shippedCartons, status: 'dispatched' };
      (this.shipments = this.shipments || []).push(record);
      this.log(`Order ${order.id} dispatched as one shipment`);
      return ship;
    };

    proto.deliveryNote = function (orderId) {
      const order = this.orders[String(orderId)];
      if (!order || !order.shipment) throw new Error(`Order ${orderId} has no shipment`);
      const ship = order.shipment;
      const rows = ship.holders.map((h) => `<tr><td>${htmlEscape(h.kind)}</td><td>${htmlEscape(h.sscc || h.id)}</td><td>${htmlEscape(h.itemNo || '')}</td><td>${htmlEscape(h.qty)}</td><td>${h.loaded ? 'loaded' : 'staged'}</td></tr>`).join('');
      return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Delivery note ${htmlEscape(order.id)}</title>
        <style>body{font:15px/1.4 system-ui,sans-serif;margin:24px;color:#17202a}h1{font-size:22px;margin:0 0 4px}table{border-collapse:collapse;width:100%;margin-top:12px}th,td{border-bottom:1px solid #dde3e8;text-align:left;padding:6px 8px}th{color:#5d6b76}@media print{body{margin:12px}}</style></head>
        <body><h1>Delivery note ${htmlEscape(order.id)}</h1><p>${htmlEscape(order.customer)} · lane ${htmlEscape(ship.lane)}${ship.truck ? ` · truck ${htmlEscape(ship.truck)}` : ''} · ${htmlEscape(ship.status)}</p>
        <h2>Load manifest</h2><table><tr><th>Kind</th><th>Holder</th><th>Item</th><th>Qty</th><th>Load</th></tr>${rows}</table></body></html>`;
    };

    proto.ensureTransit = function () {
      if (this.locations['IN-TRANSIT']) return this.locations['IN-TRANSIT'];
      return this.createLocation({ code: 'IN-TRANSIT', kind: 'virtual', role: 'transit', name: 'In transit' });
    };

    proto.shipTransfer = function ({ id, itemNo, qty, toSite, fromSite = null, by } = {}) {
      const amount = whole(qty, 'Transfer quantity');
      const dest = String(toSite || '').trim().toUpperCase();
      if (!dest) throw new Error('A destination warehouse is required');
      const item = this.items[itemNo];
      if (!item) throw new Error(`Unknown item ${itemNo}`);
      const tid = String(id || '').trim().toUpperCase();
      if (!/^[A-Z0-9][A-Z0-9_-]{0,23}$/.test(tid)) throw new Error('Transfer id uses letters, digits, hyphen or underscore');
      this.siteTransfers = this.siteTransfers || {};
      if (this.siteTransfers[tid]) throw new Error(`Transfer ${tid} already exists`);
      this.ensureTransit();
      const actor = by || this._actor || 'office';
      const pallet = Object.values(this.pallets).find((p) => p.itemNo === itemNo && p.status !== 'shipped' && p.loc && p.loc !== 'IN-TRANSIT' && !p.orderId && p.qty === amount);
      let record;
      if (pallet) {
        const from = pallet.loc;
        this._remove(pallet);
        this._place(pallet, 'IN-TRANSIT');
        pallet.transitFrom = from;
        record = { id: tid, itemNo, qty: amount, batch: pallet.batch, expiry: pallet.expiry, clientId: pallet.clientId || item.clientId || null, toSite: dest, fromSite: fromSite || 'MAIN', from, sscc: pallet.sscc, holderId: pallet.holderId || null, partial: false, status: 'in-transit', by: actor, t: this.now() };
        this.recordMovement({ sscc: pallet.sscc, holder: pallet.holderId || null, from, to: 'IN-TRANSIT', qty: amount, event: 'transferred', by: actor, note: tid });
      } else {
        const holder = Object.values(this.holders || {}).find((h) => h.status !== 'retired' && h.status !== 'transferred' && !h.cartonStatus && h.loc !== 'IN-TRANSIT' && (h.contents || []).some((c) => c.itemNo === itemNo && Number(c.qty) >= amount));
        if (!holder) throw new Error(`No ${itemNo} stock of ${amount} to transfer`);
        const line = holder.contents.find((c) => c.itemNo === itemNo && Number(c.qty) >= amount);
        const from = holder.loc;
        if (Number(line.qty) === amount) {
          holder.loc = 'IN-TRANSIT';
          holder.transitFrom = from;
          record = { id: tid, itemNo, qty: amount, batch: line.batch || null, expiry: line.expiry || null, clientId: holder.clientId || item.clientId || null, toSite: dest, fromSite: fromSite || 'MAIN', from, sscc: null, holderId: holder.id, partial: false, status: 'in-transit', by: actor, t: this.now() };
        } else {
          line.qty -= amount;
          record = { id: tid, itemNo, qty: amount, batch: line.batch || null, expiry: line.expiry || null, clientId: holder.clientId || item.clientId || null, toSite: dest, fromSite: fromSite || 'MAIN', from, sscc: null, holderId: holder.id, partial: true, status: 'in-transit', by: actor, t: this.now() };
        }
        this.recordMovement({ holder: holder.id, from, to: 'IN-TRANSIT', qty: amount, event: 'transferred', by: actor, note: tid });
      }
      this.siteTransfers[tid] = record;
      this.log(`Transfer ${tid} in transit to ${dest}: ${itemNo} × ${amount}`);
      return record;
    };

    proto.cancelSiteTransfer = function ({ id, by } = {}) {
      const tid = String(id || '').trim().toUpperCase();
      const record = (this.siteTransfers || {})[tid];
      if (!record) throw new Error(`Unknown transfer ${tid}`);
      if (record.status !== 'in-transit') throw new Error(`Transfer ${tid} is ${record.status}`);
      const actor = by || this._actor || 'office';
      if (record.sscc) {
        const pallet = this.pallets[record.sscc];
        this._remove(pallet);
        this._place(pallet, record.from);
        delete pallet.transitFrom;
      } else {
        const holder = this.holders[record.holderId];
        const line = (holder.contents || []).find((c) => c.itemNo === record.itemNo);
        if (record.partial) line.qty += record.qty;
        else holder.loc = record.from;
      }
      record.status = 'cancelled';
      record.cancelledAt = this.now();
      this.recordMovement({ sscc: record.sscc, holder: record.holderId, from: 'IN-TRANSIT', to: record.from, qty: record.qty, event: 'moved', by: actor, note: `${tid} refused` });
      this.log(`Transfer ${tid} returned to ${record.from}`);
      return record;
    };

    proto.completeSiteTransfer = function ({ id, by } = {}) {
      const tid = String(id || '').trim().toUpperCase();
      const record = (this.siteTransfers || {})[tid];
      if (!record) throw new Error(`Unknown transfer ${tid}`);
      if (record.status !== 'in-transit') throw new Error(`Transfer ${tid} is ${record.status}`);
      if (record.sscc) {
        const pallet = this.pallets[record.sscc];
        this._remove(pallet);
        pallet.status = 'shipped';
        pallet.transferredTo = record.toSite;
      } else if (!record.partial) {
        const holder = this.holders[record.holderId];
        holder.loc = null;
        holder.status = 'transferred';
      }
      record.status = 'received';
      record.receivedAt = this.now();
      this.recordMovement({ sscc: record.sscc, holder: record.holderId, from: 'IN-TRANSIT', to: `SITE-${record.toSite}`, qty: record.qty, event: 'shipped', by: by || this._actor || 'office', note: tid });
      this.log(`Transfer ${tid} received at ${record.toSite}`);
      return record;
    };

    proto.receiveSiteTransfer = function (payload) {
      return this.importStock(payload);
    };

    function tariffNumber(value, label) {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0) throw new Error(`${label} must be a number of 0 or more`);
      return n;
    }

    proto.setTariff = function (clientId, tariff = {}) {
      const client = this._client(clientId);
      const storageBasis = tariff.storageBasis || 'pallet-day';
      const inboundBasis = tariff.inboundBasis || 'pallet';
      const outboundBasis = tariff.outboundBasis || 'order';
      if (!['pallet-day', 'location-day', 'm3-day'].includes(storageBasis)) throw new Error('Storage is charged per pallet-day, location-day or m3-day');
      if (!['pallet', 'line'].includes(inboundBasis)) throw new Error('Inbound is charged per pallet or line');
      if (!['order', 'line', 'carton'].includes(outboundBasis)) throw new Error('Outbound is charged per order, line or carton');
      client.tariff = {
        storageBasis, storageRate: tariffNumber(tariff.storageRate || 0, 'Storage rate'),
        inboundBasis, inboundRate: tariffNumber(tariff.inboundRate || 0, 'Inbound rate'),
        outboundBasis, outboundRate: tariffNumber(tariff.outboundRate || 0, 'Outbound rate'),
        valRate: tariffNumber(tariff.valRate || 0, 'VAL rate'),
        minimum: tariffNumber(tariff.minimum || 0, 'Minimum charge'),
      };
      this.log(`Tariff for ${client.id} updated`);
      return client.tariff;
    };

    function inPeriod(t, from, to) {
      if (from != null && t < from) return false;
      if (to != null && t > to) return false;
      return true;
    }

    proto.invoice = function ({ clientId, from = null, to = null } = {}) {
      const client = this._client(clientId);
      const tariff = client.tariff || {
        storageBasis: 'pallet-day', storageRate: Number(client.storageRate) || 0,
        inboundBasis: 'pallet', inboundRate: 0,
        outboundBasis: 'order', outboundRate: Number(client.handlingRate) || 0,
        valRate: 0, minimum: 0,
      };
      const start = from == null || from === '' ? null : (typeof from === 'number' ? from : Date.parse(`${from}T00:00:00Z`));
      const end = to == null || to === '' ? null : (typeof to === 'number' ? to : Date.parse(`${to}T23:59:59Z`));
      if (Number.isNaN(start) || Number.isNaN(end)) throw new Error('Use dates as YYYY-MM-DD');
      const day = 86400000;
      const now = this.now();
      let palletDays = 0;
      let locationDays = 0;
      let cubicDays = 0;
      let inboundPallets = 0;
      for (const p of Object.values(this.pallets)) {
        const owner = p.clientId || (this.items[p.itemNo] && this.items[p.itemNo].clientId);
        if (owner !== client.id || !p.receivedAt) continue;
        let stop = p.status === 'shipped' ? ((this.movements || []).find((m) => m.sscc === p.sscc && (m.event === 'shipped' || m.event === 'transferred')) || {}).t || p.receivedAt : now;
        const a = Math.max(p.receivedAt, start == null ? p.receivedAt : start);
        const b = Math.min(stop, end == null ? stop : end);
        const days = Math.max(0, (b - a) / day);
        palletDays += days;
        locationDays += days;
        const item = this.items[p.itemNo];
        if (item && item.lengthMm && item.widthMm && item.heightMm) cubicDays += days * (item.lengthMm * item.widthMm * item.heightMm) / 1e9;
        if (inPeriod(p.receivedAt, start, end)) inboundPallets += 1;
      }
      const ownedMove = (m) => {
        const pallet = m.sscc && this.pallets[m.sscc];
        const holder = m.holder && this.holders[m.holder];
        const owner = (pallet && (pallet.clientId || (this.items[pallet.itemNo] && this.items[pallet.itemNo].clientId))) || (holder && holder.clientId);
        return owner === client.id && inPeriod(m.t, start, end);
      };
      const moves = (this.movements || []).filter((m) => ownedMove(m) && ['moved', 'picked', 'consolidated', 'shipped', 'received', 'packed', 'transferred'].includes(m.event));
      const inboundLines = (this.movements || []).filter((m) => ownedMove(m) && m.event === 'received').length;
      const orders = Object.values(this.orders).filter((o) => o.clientId === client.id && o.shippedAt && inPeriod(o.shippedAt, start, end));
      const outboundLines = orders.reduce((s, o) => s + o.lines.length, 0);
      const outboundCartons = (this.shipments || []).filter((s) => orders.some((o) => o.id === s.orderId)).reduce((n, s) => n + (s.cartons || []).length, 0);
      const valUnits = (this.movements || []).filter((m) => ownedMove(m) && m.event === 'kitted').length;
      const storageQty = tariff.storageBasis === 'location-day' ? locationDays : tariff.storageBasis === 'm3-day' ? cubicDays : palletDays;
      const inboundQty = tariff.inboundBasis === 'line' ? inboundLines : inboundPallets;
      const outboundQty = tariff.outboundBasis === 'line' ? outboundLines : tariff.outboundBasis === 'carton' ? outboundCartons : orders.length;
      const lines = [
        { code: 'storage', label: `Storage (${tariff.storageBasis})`, qty: Math.round(storageQty * 100) / 100, rate: tariff.storageRate },
        { code: 'inbound', label: `Inbound (${tariff.inboundBasis})`, qty: inboundQty, rate: tariff.inboundRate },
        { code: 'outbound', label: `Outbound (${tariff.outboundBasis})`, qty: outboundQty, rate: tariff.outboundRate },
        { code: 'val', label: 'VAL / kitting (unit)', qty: valUnits, rate: tariff.valRate },
      ].map((l) => ({ ...l, amount: Math.round(l.qty * l.rate * 100) / 100 }));
      const subtotal = Math.round(lines.reduce((s, l) => s + l.amount, 0) * 100) / 100;
      const total = Math.round(Math.max(tariff.minimum || 0, subtotal) * 100) / 100;
      return {
        clientId: client.id, name: client.name, from: start, to: end, tariff, lines, subtotal,
        minimum: tariff.minimum || 0, total, palletDays: Math.round(palletDays * 100) / 100, moves: moves.length,
      };
    };

    proto.invoiceHtml = function (opts) {
      const inv = this.invoice(opts);
      const rows = inv.lines.map((l) => `<tr><td>${htmlEscape(l.label)}</td><td>${htmlEscape(l.qty)}</td><td>${htmlEscape(l.rate)}</td><td>${htmlEscape(l.amount)}</td></tr>`).join('');
      return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Invoice ${htmlEscape(inv.clientId)}</title>
        <style>body{font:15px/1.4 system-ui,sans-serif;margin:24px;color:#17202a}table{border-collapse:collapse;width:100%;margin-top:12px}th,td{border-bottom:1px solid #dde3e8;text-align:left;padding:6px 8px}th{color:#5d6b76}.total{font-size:18px;font-weight:700}@media print{body{margin:12px}}</style></head>
        <body><h1>Invoice ${htmlEscape(inv.clientId)}</h1><p>${htmlEscape(inv.name)}</p>
        <table><tr><th>Charge</th><th>Qty</th><th>Rate</th><th>Amount</th></tr>${rows}</table>
        <p>Subtotal ${htmlEscape(inv.subtotal)}. Minimum ${htmlEscape(inv.minimum)}.</p><p class="total">Total ${htmlEscape(inv.total)}</p></body></html>`;
    };

    proto.availability = function () {
      const rows = [];
      for (const item of Object.values(this.items)) {
        if (item.status === 'archived') continue;
        let onHand = 0;
        let allocated = 0;
        let held = 0;
        for (const p of Object.values(this.pallets)) {
          if (p.itemNo !== item.itemNo || p.status === 'shipped' || !p.loc) continue;
          onHand += p.qty;
          if (p.orderId) allocated += p.qty;
          if (p.status === 'blocked' || p.qualityHold || p.quarantine) held += p.qty;
        }
        for (const h of Object.values(this.holders || {})) {
          if (h.status === 'retired' || h.cartonStatus || (h.sscc && this.pallets[h.sscc])) continue;
          const place = h.loc && this.locations[h.loc];
          const blocked = place && (place.role === 'quarantine' || place.role === 'return' || place.quarantine);
          for (const c of h.contents || []) {
            if (c.itemNo !== item.itemNo) continue;
            const q = Number(c.qty) || 0;
            onHand += q;
            if (blocked) held += q;
          }
        }
        let reserved = 0;
        for (const order of Object.values(this.orders)) {
          if (order.status === 'shipped') continue;
          for (const line of order.lines) if (line.kind === 'each' && line.itemNo === item.itemNo) reserved += Math.max(0, line.units - (line.picked || 0));
        }
        const available = Math.max(0, onHand - allocated - held - reserved);
        rows.push({
          itemNo: item.itemNo, name: item.name, sku: item.itemNo, onHand, allocated, held, reserved, available,
          reorderPoint: item.reorderPoint == null ? null : item.reorderPoint,
          low: item.reorderPoint != null && onHand <= item.reorderPoint,
        });
      }
      return rows.sort((a, b) => (a.itemNo < b.itemNo ? -1 : 1));
    };

    proto.lowStock = function () {
      return this.availability().filter((r) => r.low);
    };

    proto.billingReport = function ({ clientId = null } = {}) {
      const day = 86400000;
      const now = this.now();
      const wanted = clientId ? String(clientId).toUpperCase() : null;
      return Object.values(this.clients || {}).filter((c) => !wanted || c.id === wanted).map((client) => {
        let palletDays = 0;
        for (const p of Object.values(this.pallets)) {
          const owner = p.clientId || (this.items[p.itemNo] && this.items[p.itemNo].clientId);
          if (owner !== client.id || !p.receivedAt) continue;
          let end = now;
          if (p.status === 'shipped') {
            const move = (this.movements || []).find((m) => m.sscc === p.sscc && (m.event === 'shipped' || m.event === 'transferred'));
            end = move ? move.t : p.receivedAt;
          }
          palletDays += Math.max(0, (end - p.receivedAt) / day);
        }
        const moves = (this.movements || []).filter((m) => {
          if (!['moved', 'picked', 'consolidated', 'shipped', 'received', 'packed', 'transferred'].includes(m.event)) return false;
          const pallet = m.sscc && this.pallets[m.sscc];
          const holder = m.holder && this.holders[m.holder];
          const owner = (pallet && (pallet.clientId || (this.items[pallet.itemNo] && this.items[pallet.itemNo].clientId))) || (holder && holder.clientId);
          return owner === client.id;
        }).length;
        const storageRate = Number(client.storageRate) || 0;
        const handlingRate = Number(client.handlingRate) || 0;
        const storage = Math.round(palletDays * storageRate * 100) / 100;
        const handling = Math.round(moves * handlingRate * 100) / 100;
        return { clientId: client.id, name: client.name, palletDays: Math.round(palletDays * 100) / 100, moves, storageRate, handlingRate, storage, handling, total: Math.round((storage + handling) * 100) / 100 };
      });
    };
  }

  return { install };
});
