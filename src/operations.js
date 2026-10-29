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
      loc.replenishment = { itemNo: item.itemNo, min: minN, max: maxN, trigger: trig };
      this.log(`Pick face ${loc.code}: ${item.itemNo} min ${minN} trigger ${trig} max ${maxN}`);
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
        if (this._faceQty(loc) > spec.trigger) continue;
        const open = Object.values(this.tasks).some((t) => t.reason === 'replenish' && t.to === loc.code && t.status !== 'done' && t.status !== 'cancelled');
        if (open) continue;
        try { created.push(this.replenish(spec.itemNo, loc.code, { topUp: true })); } catch (e) { /* no free pallet, or the face cannot take one */ }
      }
      if (created.length) this.log(`${created.length} replenishment move(s) queued`);
      return created;
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
