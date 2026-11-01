/*
 * Returns: goods a customer sends back on a shipped order.
 *
 * A return is booked against the order, one or more lines, never more of an
 * item than went out on it less what came back already. The parcel waits at
 * a return location until someone grades it, all at once or a few at a time:
 * restock (back into a bin or a rack slot, where waves can pick it again),
 * hold (on a plate in quarantine, to be graded again later) or scrap. Traced
 * items come back by serial: the ones that left on that order, or any not in
 * stock when the order went out without its serials scanned. Restocked and
 * held stock shows on the stock-change report as a return; scrapping from a
 * hold shows as it leaving.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SortedReturns = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const GRADES = ['restock', 'quarantine', 'scrap'];
  const STOCK_KINDS = ['bin', 'mezzanine', 'rack'];

  function whole(value, label) {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1) throw new Error(`${label} must be a whole number above 0`);
    return n;
  }

  function snList(raw) {
    const g = typeof globalThis !== 'undefined' && globalThis.SortedSerials;
    const list = g ? g.list : (typeof require === 'function' ? require('./serials').list : null);
    return list(raw);
  }

  function install(Warehouse) {
    const proto = Warehouse.prototype;

    /** What left on an order, per item: units picked on piece lines, plus whole pallets. */
    proto._shippedQty = function (order, itemNo) {
      let n = 0;
      for (const l of order.lines) {
        if (l.itemNo !== itemNo) continue;
        if (l.kind === 'each') n += l.picked || 0;
        else for (const sscc of l.allocated || []) n += (this.pallets[sscc] || {}).qty || 0;
      }
      return n;
    };

    proto._returnedQty = function (orderId, itemNo) {
      let n = 0;
      for (const r of Object.values(this.returns || {})) {
        if (r.orderId !== orderId) continue;
        for (const l of this._returnLines(r)) if (l.itemNo === itemNo) n += l.qty;
      }
      return n;
    };

    /** Older returns had one item on the return itself. */
    proto._returnLines = function (rma) {
      if (!rma.lines) {
        const done = rma.status === 'restocked' || rma.status === 'scrapped';
        rma.lines = [{ itemNo: rma.itemNo, qty: rma.qty, serials: [], open: [], heldSerials: [], restocked: rma.status === 'restocked' ? rma.qty : 0, scrapped: rma.status === 'scrapped' ? rma.qty : 0, held: rma.status === 'quarantine' ? rma.qty : 0, holds: rma.status === 'quarantine' && rma.holderId ? [{ holder: rma.holderId, qty: rma.qty }] : [] }];
        if (!done && rma.status !== 'quarantine') rma.status = 'received';
        delete rma.itemNo;
        delete rma.qty;
      }
      return rma.lines;
    };

    proto._return = function (id) {
      const rma = (this.returns || {})[String(id || '').trim()];
      if (!rma) throw new Error(`Unknown return ${id}`);
      this._returnLines(rma);
      return rma;
    };

    /** Each item an order shipped, with how much can still come back and which serials. */
    proto.returnable = function (orderId) {
      const order = this.orders[String(orderId || '').trim()];
      if (!order) throw new Error(`No order ${orderId}`);
      const items = [...new Set(order.lines.map((l) => l.itemNo))];
      return {
        orderId: order.id, customer: order.customer, shipped: order.status === 'shipped',
        lines: items.map((itemNo) => {
          const shipped = this._shippedQty(order, itemNo);
          const returned = this._returnedQty(order.id, itemNo);
          const item = this.items[itemNo] || {};
          const serials = item.serialized ? this._serialRows().filter((r) => r.itemNo === itemNo && r.orderId === order.id && r.status === 'picked').map((r) => r.sn).sort() : [];
          return { itemNo, name: item.name || '', uom: item.uom || null, shipped, returned, left: Math.max(0, shipped - returned), serialized: Boolean(item.serialized), serials };
        }),
      };
    };

    /** The place returns wait to be graded: the one named, the first return location, or a new RETURNS. */
    proto._virtualPlace = function (code, role, fallback, name) {
      if (code) {
        const place = this._loc(this.resolve(code));
        return place;
      }
      const found = Object.values(this.locations).find((l) => l.kind === 'virtual' && l.role === role);
      if (found) return found;
      return this.locations[fallback] || this.createLocation({ code: fallback, kind: 'virtual', role, name });
    };

    /**
     * Book a return against a shipped order. Lines are `{ itemNo, qty, serials }`;
     * one item can also be given as `itemNo`, `qty` and `serials` directly.
     */
    proto.receiveReturn = function ({ id = null, orderId, lines = null, itemNo = null, qty = null, serials = null, loc = null, reason = null, note = null, by } = {}) {
      const order = this.orders[String(orderId || '').trim()];
      if (!order) throw new Error(`No order ${orderId}`);
      if (order.status !== 'shipped') throw new Error(`Order ${order.id} has not shipped yet`);
      this.returns = this.returns || {};
      let rid = String(id || '').trim();
      if (!rid) {
        let n = Object.keys(this.returns).length + 1;
        while (this.returns[`RMA-${n}`]) n++;
        rid = `RMA-${n}`;
      }
      if (this.returns[rid]) throw new Error(`Return ${rid} already exists`);
      const place = this._virtualPlace(loc, 'return', 'RETURNS', 'Returns');
      if (place.kind !== 'virtual' || !['return', 'quarantine', 'staging'].includes(place.role)) throw new Error('Receive a return at a return, quarantine or staging location');
      const asked = Array.isArray(lines) && lines.length ? lines : [{ itemNo, qty, serials }];
      const seen = new Set();
      const out = [];
      for (const raw of asked) {
        const item = this.items[raw && raw.itemNo];
        if (!item) throw new Error(`Unknown item ${raw && raw.itemNo}`);
        if (seen.has(item.itemNo)) throw new Error(`${item.itemNo} is on the return twice`);
        seen.add(item.itemNo);
        if (!order.lines.some((l) => l.itemNo === item.itemNo)) throw new Error(`${item.itemNo} was not on order ${order.id}`);
        const amount = whole(raw.qty, `Return quantity of ${item.itemNo}`);
        const left = this._shippedQty(order, item.itemNo) - this._returnedQty(order.id, item.itemNo);
        if (amount > left) throw new Error(left > 0 ? `Order ${order.id} has only ${left} ${item.itemNo} that can come back` : `Every ${item.itemNo} on order ${order.id} has come back already`);
        out.push({ item, amount, sns: this._returnSerials(order, item, raw.serials, amount) });
      }
      const actor = by || this._actor || 'inbound';
      const t = this.now();
      const rma = {
        id: rid, orderId: order.id, customer: order.customer, clientId: order.clientId || null, reason: reason ? String(reason).trim() : null, note: note ? String(note).trim() : null,
        loc: place.code, status: 'received', receivedAt: t, by: actor,
        lines: out.map(({ item, amount, sns }) => ({ itemNo: item.itemNo, qty: amount, serials: sns, open: sns.slice(), heldSerials: [], restocked: 0, held: 0, scrapped: 0, holds: [] })),
        history: [],
      };
      this.returns[rid] = rma;
      for (const l of rma.lines) {
        rma.history.push({ t, event: 'received', by: actor, itemNo: l.itemNo, to: place.code, qty: l.qty });
        this.recordMovement({ from: null, to: place.code, qty: l.qty, event: 'returned', by: actor, note: `${l.itemNo} on ${rid}, order ${order.id}` });
        this._serialsSet(l.serials, l.itemNo, { status: 'returned', loc: place.code, orderId: order.id, event: 'returned', by: actor, note: `return ${rid}` });
      }
      this.log(`Return ${rid} for order ${order.id} at ${place.code}: ${rma.lines.map((l) => `${l.itemNo} × ${l.qty}`).join(', ')}`);
      return rma;
    };

    /** Serials coming back: the ones that left on this order, or (when none were scanned out) any not in stock. */
    proto._returnSerials = function (order, item, raw, qty) {
      const sns = snList(raw);
      if (!item.serialized) {
        if (sns.length) throw new Error(`${item.itemNo} is not traced by serial number`);
        return [];
      }
      const out = this._serialRows().filter((r) => r.itemNo === item.itemNo && r.orderId === order.id && (r.status === 'picked' || r.status === 'returned' || r.status === 'scrapped'));
      if (!out.length) return this._serialsIn(item, sns, qty) || [];
      if (sns.length !== qty) throw new Error(`${qty} ${item.itemNo} back: scan ${qty} serial number${qty === 1 ? '' : 's'}, not ${sns.length}`);
      const dupes = new Set();
      for (const sn of sns) {
        if (dupes.has(sn)) throw new Error(`Serial ${sn} is scanned twice`);
        dupes.add(sn);
        const row = this._serial(sn);
        if (!row || row.itemNo !== item.itemNo || row.orderId !== order.id) throw new Error(`Serial ${sn} did not go out on order ${order.id}`);
        if (row.status !== 'picked') throw new Error(`Serial ${sn} has come back already`);
      }
      return sns;
    };

    /**
     * Grade some or all of a return line. It takes from what is still waiting,
     * or from what is on hold once nothing waits (or `from: 'hold'`).
     */
    proto.gradeReturn = function ({ id, itemNo = null, grade, qty = null, to = null, serials = null, batch = null, expiry = null, from = null, by } = {}) {
      const rma = this._return(id);
      if (grade === 'hold') grade = 'quarantine';
      if (!GRADES.includes(grade)) throw new Error('Grade a return as restock, quarantine or scrap');
      let line;
      if (itemNo) {
        line = rma.lines.find((l) => l.itemNo === String(itemNo).trim());
        if (!line) throw new Error(`${itemNo} is not on return ${rma.id}`);
      } else {
        const todo = rma.lines.filter((l) => this._returnLeft(l) || l.held);
        if (todo.length > 1) throw new Error(`Return ${rma.id} has ${todo.length} items still to grade: say which`);
        line = todo[0] || rma.lines[0];
      }
      const waiting = this._returnLeft(line);
      const fromHold = from === 'hold' || (from !== 'waiting' && !waiting);
      const have = fromHold ? line.held : waiting;
      if (!have) throw new Error(fromHold ? `No ${line.itemNo} on return ${rma.id} is on hold` : `No ${line.itemNo} on return ${rma.id} is waiting to be graded`);
      if (fromHold && grade === 'quarantine') throw new Error(`That ${line.itemNo} is on hold already`);
      const amount = qty == null || qty === '' ? have : whole(qty, 'Quantity to grade');
      if (amount > have) throw new Error(`Only ${have} ${line.itemNo} ${fromHold ? 'on hold' : 'waiting'} on return ${rma.id}`);
      const pool = fromHold ? line.heldSerials : line.open;
      const sns = this._gradeSerials(line, pool, serials, amount);
      const actor = by || this._actor || 'inbound';
      const item = this.items[line.itemNo];
      // Off the hold plate first, so a failed restock below leaves nothing half done: commands reload on a throw.
      let fromLoc = rma.loc;
      if (fromHold) {
        fromLoc = this._takeFromHold(line, amount);
        // Out of stock on hold, so a restock books them in again like any return.
        this._serialsSet(sns, item.itemNo, { status: 'returned', loc: fromLoc, orderId: null, event: 'released', by: actor, note: `return ${rma.id}` });
      }
      let dest = null;
      let holder = null;
      if (grade === 'restock') {
        const place = this._loc(this.resolve(to || ''));
        if (!STOCK_KINDS.includes(place.kind)) throw new Error('Restock into a bin, mezzanine or rack slot');
        dest = place.code;
        if (place.kind === 'rack') {
          const pallet = this.stockPallet(dest, { itemNo: item.itemNo, qty: amount, batch: batch || `RMA-${rma.id}`, expiry: expiry || null, receivedAt: this.now(), clientId: item.clientId || null });
          dest = pallet.loc;
          this._serialsSet(sns, item.itemNo, { status: 'in', loc: dest, sscc: pallet.sscc, orderId: null, event: 'restocked', by: actor, note: `return ${rma.id}` });
          this.recordMovement({ sscc: pallet.sscc, from: fromLoc, to: dest, qty: amount, event: 'restocked', by: actor, note: `return ${rma.id}` });
        } else {
          this.binPut({ loc: dest, itemNo: item.itemNo, qty: amount, batch, expiry, serials: sns.length ? sns : null, by: actor, event: 'restocked', note: `${item.itemNo} from return ${rma.id}` });
        }
        line.restocked += amount;
        this._adjust({ loc: dest, itemNo: item.itemNo, before: 0, after: amount, reason: fromHold ? 'return released' : 'returned', by: actor, returnId: rma.id });
        if (fromHold) this._adjust({ loc: fromLoc, itemNo: item.itemNo, before: amount, after: 0, reason: 'return released', by: actor, returnId: rma.id });
      } else if (grade === 'quarantine') {
        const place = this._virtualPlace(to, 'quarantine', 'QUARANTINE', 'Quarantine');
        if (place.kind !== 'virtual' || place.role !== 'quarantine') throw new Error('Hold a return at a quarantine location');
        dest = place.code;
        holder = this._makePlate(this.allocatePlate('ST'), { type: 'st', loc: dest, clientId: item.clientId || null, contents: [{ itemNo: item.itemNo, qty: amount, batch: batch || `RMA-${rma.id}`, expiry: expiry || null, clientId: item.clientId || null }] });
        line.held += amount;
        line.holds.push({ holder: holder.id, qty: amount });
        line.heldSerials.push(...sns);
        this._serialsSet(sns, item.itemNo, { status: 'in', loc: dest, orderId: null, event: 'held', by: actor, note: `return ${rma.id} on ${holder.id}` });
        this.recordMovement({ holder: holder.id, from: rma.loc, to: dest, qty: amount, event: 'held', by: actor, note: `return ${rma.id}` });
        this._adjust({ loc: dest, plate: holder.id, itemNo: item.itemNo, before: 0, after: amount, reason: 'returned (held)', by: actor, returnId: rma.id });
      } else {
        line.scrapped += amount;
        this._serialsSet(sns, item.itemNo, { status: 'scrapped', loc: null, event: 'scrapped', by: actor, note: `return ${rma.id}` });
        this.recordMovement({ from: fromLoc, to: null, qty: amount, event: 'scrapped', by: actor, note: `${item.itemNo} from return ${rma.id}` });
        if (fromHold) this._adjust({ loc: fromLoc, itemNo: item.itemNo, before: amount, after: 0, reason: 'return scrapped', by: actor, returnId: rma.id });
      }
      const gone = new Set(sns);
      if (fromHold) line.heldSerials = line.heldSerials.filter((sn) => !gone.has(sn));
      else line.open = line.open.filter((sn) => !gone.has(sn));
      rma.history.push({ t: this.now(), event: grade, by: actor, itemNo: item.itemNo, qty: amount, from: fromHold ? 'hold' : 'waiting', to: dest, holder: holder ? holder.id : null, serials: sns.length ? sns : undefined });
      rma.status = this._returnStatus(rma);
      if (holder) rma.holderId = holder.id;
      this.log(`Return ${rma.id}: ${item.itemNo} × ${amount} ${grade === 'restock' ? `restocked at ${dest}` : grade === 'quarantine' ? `on hold at ${dest}` : 'scrapped'}`);
      return rma;
    };

    proto._returnLeft = function (line) {
      return line.qty - line.restocked - line.held - line.scrapped;
    };

    proto._returnStatus = function (rma) {
      if (rma.lines.some((l) => this._returnLeft(l) > 0)) return 'received';
      if (rma.lines.some((l) => l.held > 0)) return 'held';
      return 'done';
    };

    /** Which serials a grade takes: all of them when it takes all, else the ones scanned. */
    proto._gradeSerials = function (line, pool, raw, qty) {
      const sns = snList(raw);
      if (!pool.length) {
        if (sns.length) throw new Error(`No serials came back with this ${line.itemNo}`);
        return [];
      }
      if (!sns.length) {
        if (qty === pool.length) return pool.slice();
        throw new Error(`Scan which ${qty} of the ${pool.length} ${line.itemNo} serials`);
      }
      if (sns.length !== qty) throw new Error(`Scan ${qty} serial number${qty === 1 ? '' : 's'}, not ${sns.length}`);
      const seen = new Set();
      for (const sn of sns) {
        if (seen.has(sn)) throw new Error(`Serial ${sn} is scanned twice`);
        seen.add(sn);
        if (!pool.includes(sn)) throw new Error(`Serial ${sn} is not ${pool === line.heldSerials ? 'on hold' : 'waiting'} on this return`);
      }
      return sns;
    };

    /** Take a quantity off this line's hold plates, oldest first. Returns where it was. */
    proto._takeFromHold = function (line, qty) {
      let left = qty;
      let where = null;
      for (const h of line.holds) {
        if (!left) break;
        if (!h.qty) continue;
        const take = Math.min(h.qty, left);
        const plate = this.holders[h.holder];
        const row = plate && (plate.contents || []).find((c) => c.itemNo === line.itemNo);
        if (!row || row.qty < take) throw new Error(`Hold plate ${h.holder} no longer has ${take} ${line.itemNo}`);
        row.qty -= take;
        if (!plate.contents.some((c) => c.qty > 0)) plate.status = 'retired';
        h.qty -= take;
        left -= take;
        where = where || plate.loc;
      }
      line.held -= qty;
      line.holds = line.holds.filter((h) => h.qty > 0);
      return where;
    };

    /** Returns newest first, with what each line still needs. */
    proto.returnList = function ({ status = null, orderId = null } = {}) {
      return Object.values(this.returns || {})
        .map((r) => { this._returnLines(r); return r; })
        .filter((r) => (!status || r.status === status) && (!orderId || r.orderId === String(orderId)))
        .sort((a, b) => (b.receivedAt || 0) - (a.receivedAt || 0) || String(b.id).localeCompare(String(a.id)))
        .map((r) => ({ ...r, lines: r.lines.map((l) => ({ ...l, waiting: this._returnLeft(l), name: (this.items[l.itemNo] || {}).name || '' })) }));
    };
  }

  return { install, GRADES };
});
