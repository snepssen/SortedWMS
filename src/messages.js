/*
 * Messages out: what the warehouse tells the systems around it.
 *
 * Each confirmation another system needs (goods received on a delivery, an
 * order shipped with its pallets, cartons, batches and serial numbers, a
 * return booked or graded, stock adjusted) is written to a numbered log when
 * it happens. The log is part of the warehouse state, so replaying the journal
 * numbers it the same way. A connection reads it from where it left off
 * (`after` the last number it took), as often as it likes; nothing is lost
 * while it is offline. The newest MAX messages are kept: a reader that falls
 * further behind is told so and starts again from a full stock report.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SortedMessages = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX = 20000;
  const TYPES = ['delivery.received', 'order.shipped', 'return.received', 'return.graded', 'stock.adjusted', 'stock.low', 'stock.recovered', 'stock.digest', 'backup.failed', 'alert.test'];
  const iso = (t) => new Date(t).toISOString();

  function install(Warehouse) {
    const proto = Warehouse.prototype;

    proto._emit = function (type, data, clientId = null) {
      this.messages = this.messages || [];
      this._seq.message = (this._seq.message || 0) + 1;
      this.messages.push({ seq: this._seq.message, type, t: iso(this.now()), clientId: clientId || null, data });
      if (this.messages.length > MAX) this.messages.splice(0, this.messages.length - MAX);
    };

    /**
     * Messages after `after`, oldest first, at most `limit`. A client's
     * connection sees only that client's. `next` is what to ask after next
     * time; `gap` says older messages it never read were dropped.
     */
    proto.messageLog = function ({ after = 0, limit = 100, clientId = null, type = null } = {}) {
      const from = Math.max(0, Math.floor(Number(after) || 0));
      const n = Math.min(Math.max(1, Math.floor(Number(limit) || 100)), 1000);
      const all = this.messages || [];
      const first = all.length ? all[0].seq : (this._seq.message || 0) + 1;
      const types = type ? String(type).split(',').map((s) => s.trim()).filter(Boolean) : null;
      const out = [];
      let next = from;
      for (const m of all) {
        if (m.seq <= from) continue;
        if (out.length >= n) break;
        next = m.seq;
        if (clientId && m.clientId !== clientId) continue;
        if (types && !types.includes(m.type)) continue;
        out.push(m);
      }
      const last = this._seq.message || 0;
      return { messages: out, next, last, more: next < last, gap: from + 1 < first };
    };

    /** Goods received: the delivery as it was closed, pallet by pallet. */
    proto._emitReceived = function (delivery) {
      const pallets = delivery.received.map((sscc) => {
        const p = this.pallets[sscc] || {};
        const row = { sscc, itemNo: p.itemNo || null, qty: p.qty == null ? null : p.qty, batch: p.batch || null, expiry: p.expiry || null };
        if (p.status === 'blocked') row.held = p.blockReason || 'blocked';
        const sns = this.serials ? this._serialRows().filter((r) => r.sscc === sscc).map((r) => r.sn).sort() : [];
        if (sns.length) row.serials = sns;
        return row;
      });
      this._emit('delivery.received', {
        deliveryId: delivery.id, asn: delivery.asn || null, ref: delivery.ref || null, supplier: delivery.supplier,
        expected: delivery.expected, received: delivery.received.length, short: Math.max(0, delivery.expected - delivery.received.length), pallets,
      }, delivery.clientId);
    };

    /** An order left: what was ordered, what went, on which pallets and in which cartons, with batches and serials. */
    proto._emitShipped = function (order, shipment = {}) {
      const items = [...new Set(order.lines.map((l) => l.itemNo))];
      const lines = items.map((itemNo) => {
        const mine = order.lines.filter((l) => l.itemNo === itemNo);
        const units = mine.reduce((s, l) => s + (l.units || 0), 0);
        const pallets = mine.reduce((s, l) => s + (l.pallets || 0), 0);
        return { itemNo, ordered: units ? { units } : { pallets }, shipped: this._shippedQty ? this._shippedQty(order, itemNo) : null };
      });
      const pallets = (shipment.pallets || []).map((p) => {
        const had = this.pallets[p.sscc] || {};
        return { sscc: p.sscc, itemNo: p.itemNo, qty: p.qty, batch: p.batch || had.batch || null, expiry: p.expiry || had.expiry || null };
      });
      const cartons = (shipment.cartons || []).map((id) => {
        const box = this.holders[id] || {};
        return { id, weightKg: box.weightKg || null, sizeMm: box.lengthMm ? [box.lengthMm, box.widthMm, box.heightMm] : null, lines: (box.packed || []).map((p) => ({ itemNo: p.itemNo, qty: p.qty, batch: p.batch || null, expiry: p.expiry || null, ...(p.serials && p.serials.length ? { serials: p.serials } : {}) })) };
      });
      const serials = this.serialsForOrder ? this.serialsForOrder(order.id).map((s) => ({ sn: s.sn, itemNo: s.itemNo, on: s.carton })) : [];
      this._emit('order.shipped', {
        orderId: order.id, ref: order.ref || null, customer: order.customer, lane: order.lane,
        carrier: order.carrierName || shipment.truck || null, trailer: shipment.trailer || null, seal: shipment.seal || null,
        tracking: order.tracking || null, trackingUrl: order.trackingUrl || null,
        shippedAt: iso(order.shippedAt || this.now()), lines, pallets, cartons, ...(serials.length ? { serials } : {}),
      }, order.clientId);
    };

    /** Stock changed by hand: a count, a correction, stock found or written off. */
    proto._emitAdjusted = function (entry) {
      const item = this.items[entry.itemNo] || {};
      this._emit('stock.adjusted', {
        loc: entry.loc || null, sscc: entry.sscc || null, plate: entry.plate || null, itemNo: entry.itemNo, batch: entry.batch || null,
        before: entry.before, after: entry.after, change: (entry.after || 0) - (entry.before || 0), reason: entry.reason || null, by: entry.by || null,
      }, item.clientId || null);
    };
  }

  return { install, MAX, TYPES };
});
