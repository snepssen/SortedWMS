/*
 * Serial numbers for items that need them (electronics, tools, anything
 * traced one by one). An item is marked as tracked; its serials live in one
 * register: where each one is, which order took it, and what happened to it.
 *
 * Out is where it counts: every pick or move of a tracked item scans one
 * serial per piece. A serial the register has not seen yet is recorded at the
 * pick, from the place it was picked (stock that came in sealed, with serials
 * only seen on the way out). In is optional: put-away may scan serials, and
 * when it does there is one per piece. A count of a tracked item is a scan of
 * its serials; one that should be there and was not scanned is missing.
 * A pallet can carry its serial list (from the supplier's pallet list, or
 * scanned at the pallet): those serials follow the pallet wherever it goes,
 * and go out with it to the order it ships on, without being scanned again.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SortedSerials = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SN = /^[A-Z0-9][A-Z0-9./_-]{1,39}$/;

  function list(raw) {
    if (raw == null || raw === '') return [];
    return (Array.isArray(raw) ? raw : String(raw).split(/[\s,;]+/)).map((s) => String(s).trim().toUpperCase()).filter(Boolean);
  }

  function install(Warehouse) {
    const proto = Warehouse.prototype;

    proto.setItemSerials = function (itemNo, on = true) {
      const item = this.items[itemNo];
      if (!item) throw new Error(`Unknown item ${itemNo}`);
      item.serialized = Boolean(on);
      this.log(`Item ${item.itemNo} ${item.serialized ? 'is traced by serial number' : 'no longer traced by serial number'}`);
      return { itemNo: item.itemNo, serialized: item.serialized };
    };

    proto._serial = function (sn) {
      const row = (this.serials && this.serials[sn]) || null;
      return row ? this._serialSync(row) : null;
    };

    /** Every row of the register, pallet serials brought up to date. */
    proto._serialRows = function () {
      return Object.values(this.serials || {}).map((r) => this._serialSync(r));
    };

    /**
     * A serial booked on a pallet is where the pallet is. Once the pallet
     * leaves, the serial leaves the same way: shipped on its order, moved to
     * another site, or taken out of stock.
     */
    proto._serialSync = function (row) {
      if (!row.sscc || row.status !== 'in') return row;
      const p = this.pallets[row.sscc];
      if (!p) return row;
      if (p.status !== 'shipped') {
        row.loc = p.loc || null;
        return row;
      }
      const how = p.removed === 'deleted' ? { status: 'removed', event: 'removed', note: `pallet …${p.sscc.slice(-6)} taken out of stock` }
        : p.transferredTo ? { status: 'transferred', event: 'transferred', note: `pallet …${p.sscc.slice(-6)} to ${p.transferredTo}` }
          : p.orderId ? { status: 'picked', event: 'shipped', note: `whole pallet …${p.sscc.slice(-6)}`, orderId: p.orderId }
            : { status: 'out', event: 'out', note: `pallet …${p.sscc.slice(-6)} left` };
      row.status = how.status;
      row.loc = null;
      if (how.orderId) row.orderId = how.orderId;
      row.history.unshift({ t: p.goneAt || this.now(), event: how.event, loc: null, orderId: row.orderId || null, by: 'system', note: how.note });
      return row;
    };

    /** Book the serials a pallet carries: one per piece on it, none in stock elsewhere. Replaces any list it had. */
    proto.palletSerials = function ({ sscc, serials, by } = {}) {
      const pallet = this._pallet(String(sscc || '').trim());
      if (pallet.status === 'shipped') throw new Error(`Pallet …${pallet.sscc.slice(-6)} is not in stock`);
      const item = this.items[pallet.itemNo];
      if (!item || !item.serialized) throw new Error(`${pallet.itemNo} is not traced by serial number`);
      const sns = list(serials);
      check(sns, item, pallet.qty);
      for (const sn of sns) {
        const known = this._serial(sn);
        if (known && known.itemNo !== item.itemNo) throw new Error(`Serial ${sn} belongs to ${known.itemNo}`);
        if (known && known.status === 'in' && known.sscc !== pallet.sscc) throw new Error(`Serial ${sn} is already in stock at ${known.loc}`);
        if (known && known.status === 'picked') throw new Error(`Serial ${sn} was picked for order ${known.orderId}`);
      }
      const actor = by || this._actor || 'inbound';
      const keep = new Set(sns);
      const dropped = this._serialRows().filter((r) => r.sscc === pallet.sscc && r.status === 'in' && !keep.has(r.sn)).map((r) => r.sn);
      this._serialsSet(dropped, item.itemNo, { status: 'missing', loc: null, event: 'missing', by: actor, note: `not on pallet …${pallet.sscc.slice(-6)} any more` });
      this._serialsSet(sns, item.itemNo, { status: 'in', loc: pallet.loc, sscc: pallet.sscc, orderId: null, event: 'received', by: actor, note: `on pallet …${pallet.sscc.slice(-6)}` });
      this.log(`Pallet …${pallet.sscc.slice(-6)}: ${sns.length} serial numbers booked`);
      return { sscc: pallet.sscc, itemNo: item.itemNo, serials: sns, dropped };
    };

    /** The serials booked on a pallet. */
    proto.palletSerialList = function (sscc) {
      const pallet = this._pallet(String(sscc || '').trim());
      const sns = this._serialRows().filter((r) => r.sscc === pallet.sscc && (r.status === 'in' || r.orderId === pallet.orderId)).map((r) => r.sn).sort();
      return { sscc: pallet.sscc, itemNo: pallet.itemNo, qty: pallet.qty, serialized: Boolean((this.items[pallet.itemNo] || {}).serialized), serials: sns };
    };

    function check(sns, item, qty) {
      const seen = new Set();
      for (const sn of sns) {
        if (!SN.test(sn)) throw new Error(`${sn} is not a serial number`);
        if (seen.has(sn)) throw new Error(`Serial ${sn} is scanned twice`);
        seen.add(sn);
      }
      if (sns.length !== qty) throw new Error(`${qty} ${item.uom || 'piece'}${qty === 1 ? '' : 's'} of ${item.itemNo}: scan ${qty} serial number${qty === 1 ? '' : 's'}, not ${sns.length}`);
    }

    /** Serials for stock coming in. Optional; when given, one per piece and none already in stock. */
    proto._serialsIn = function (item, raw, qty) {
      const sns = list(raw);
      if (!item.serialized) {
        if (sns.length) throw new Error(`${item.itemNo} is not traced by serial number`);
        return null;
      }
      if (!sns.length) return [];
      check(sns, item, qty);
      for (const sn of sns) {
        const known = this._serial(sn);
        if (known && known.status === 'in') throw new Error(`Serial ${sn} is already in stock at ${known.loc}`);
        if (known && known.itemNo !== item.itemNo) throw new Error(`Serial ${sn} belongs to ${known.itemNo}`);
      }
      return sns;
    };

    /** Serials for stock going out of `loc`. Required for a traced item: one per piece, and in stock there. */
    proto._serialsOut = function (item, raw, qty, loc) {
      const sns = list(raw);
      if (!item.serialized) {
        if (sns.length) throw new Error(`${item.itemNo} is not traced by serial number`);
        return null;
      }
      check(sns, item, qty);
      for (const sn of sns) {
        const known = this._serial(sn);
        if (!known) continue; // first seen now: recorded from this place
        if (known.itemNo !== item.itemNo) throw new Error(`Serial ${sn} belongs to ${known.itemNo}`);
        if (known.status !== 'in') throw new Error(`Serial ${sn} is ${known.status}${known.orderId ? ` (order ${known.orderId})` : ''}`);
        if (known.loc !== loc) throw new Error(`Serial ${sn} is booked at ${known.loc}, not ${loc}`);
      }
      return sns;
    };

    /** Write what happened to these serials. */
    proto._serialsSet = function (sns, itemNo, { status, loc = null, sscc = null, orderId = null, event, by, note = null }) {
      if (!sns || !sns.length) return;
      this.serials = this.serials || {};
      const t = this.now();
      for (const sn of sns) {
        const row = this.serials[sn] || (this.serials[sn] = { sn, itemNo, status: null, loc: null, orderId: null, history: [] });
        row.status = status;
        row.loc = loc;
        // Booked on a pallet only while it stays on it.
        row.sscc = sscc || null;
        if (status === 'in') row.carton = null;
        if (orderId !== undefined) row.orderId = orderId;
        row.history.unshift({ t, event, loc, orderId: orderId || null, by: by || this._actor || 'unknown', note });
        if (row.history.length > 50) row.history.length = 50;
      }
    };

    /** A blind count of a traced item: the serials scanned are what is there. */
    proto._serialsCount = function (item, raw, loc, by) {
      const sns = list(raw);
      const seen = new Set();
      for (const sn of sns) {
        if (!SN.test(sn)) throw new Error(`${sn} is not a serial number`);
        if (seen.has(sn)) throw new Error(`Serial ${sn} is scanned twice`);
        seen.add(sn);
        const known = this._serial(sn);
        if (known && known.itemNo !== item.itemNo) throw new Error(`Serial ${sn} belongs to ${known.itemNo}`);
        if (known && known.status === 'picked') throw new Error(`Serial ${sn} was picked for order ${known.orderId}`);
      }
      const missing = this._serialRows().filter((r) => r.itemNo === item.itemNo && r.status === 'in' && r.loc === loc && !seen.has(r.sn)).map((r) => r.sn);
      const moved = sns.filter((sn) => { const k = this._serial(sn); return k && k.status === 'in' && k.loc !== loc; });
      const added = sns.filter((sn) => { const k = this._serial(sn); return !k || k.status !== 'in'; });
      return {
        sns,
        commit: () => {
          this._serialsSet(missing, item.itemNo, { status: 'missing', loc: null, event: 'missing', by, note: `not found counting ${loc}` });
          this._serialsSet(sns, item.itemNo, { status: 'in', loc, event: 'counted', by, note: `counted at ${loc}` });
          return { missing, moved, added };
        },
      };
    };

    /**
     * Which picked serials go into a carton. Scanned ones must have been picked
     * for this order and not packed yet; without a scan, the ones still to pack
     * go in when they all fit, otherwise the packer scans which.
     */
    proto._serialsForCarton = function (item, orderId, raw, qty) {
      const sns = list(raw);
      if (!item || !item.serialized) {
        if (sns.length) throw new Error(`${item ? item.itemNo : 'That item'} is not traced by serial number`);
        return null;
      }
      if (sns.length) {
        check(sns, item, qty);
        for (const sn of sns) {
          const row = this._serial(sn);
          if (!row || row.itemNo !== item.itemNo || row.status !== 'picked' || row.orderId !== orderId) throw new Error(`Serial ${sn} was not picked for order ${orderId}`);
          if (row.carton) throw new Error(`Serial ${sn} is already in carton ${row.carton}`);
        }
        return sns;
      }
      const open = this._serialRows().filter((r) => r.itemNo === item.itemNo && r.status === 'picked' && r.orderId === orderId && !r.carton && !r.sscc).map((r) => r.sn).sort();
      if (open.length <= qty) return open;
      throw new Error(`${open.length} serials of ${item.itemNo} picked for ${orderId} are not packed yet: scan the ${qty} going into this carton`);
    };

    proto._serialsPack = function (sns, cartonId, by) {
      const t = this.now();
      for (const sn of sns || []) {
        const row = this._serial(sn);
        row.carton = cartonId;
        row.history.unshift({ t, event: 'packed', loc: cartonId, orderId: row.orderId, by: by || this._actor || 'unknown', note: `in carton ${cartonId}` });
      }
    };

    /** Serials that went out on an order, by carton (or none, when picked but not packed). */
    proto.serialsForOrder = function (orderId) {
      return this._serialRows().filter((r) => r.orderId === String(orderId)).map((r) => ({ sn: r.sn, itemNo: r.itemNo, carton: r.carton || r.sscc || null, status: this._serialState(r) })).sort((a, b) => String(a.carton).localeCompare(String(b.carton)) || a.itemNo.localeCompare(b.itemNo) || a.sn.localeCompare(b.sn));
    };

    /** Mark every serial of an item booked at a place as removed (a correction took that stock out). */
    proto._serialsRemoveAt = function (itemNo, loc, note, by) {
      const gone = this._serialRows().filter((r) => r.itemNo === itemNo && r.status === 'in' && r.loc === loc).map((r) => r.sn);
      this._serialsSet(gone, itemNo, { status: 'removed', loc: null, event: 'removed', by, note });
      return gone;
    };

    proto._serialState = function (row) {
      const order = row.orderId && this.orders[row.orderId];
      return row.status === 'picked' && order && order.status === 'shipped' ? 'shipped' : row.status;
    };

    /** Where a serial is, or which order and customer it went to. */
    proto.serialTrace = function (raw) {
      const sn = String(raw || '').trim().toUpperCase();
      const row = this._serial(sn);
      if (!row) throw new Error(`Serial ${sn} is not known`);
      const order = row.orderId && this.orders[row.orderId];
      const item = this.items[row.itemNo] || {};
      return { sn: row.sn, itemNo: row.itemNo, name: item.name || '', status: this._serialState(row), loc: row.loc, sscc: row.sscc || null, carton: row.carton || null, orderId: row.orderId, customer: order ? order.customer : null, shippedAt: order && order.status === 'shipped' ? order.shippedAt || null : null, history: row.history };
    };

    /** Serials in stock, at a place and/or of an item. */
    proto.serialsIn = function ({ loc = null, itemNo = null } = {}) {
      const code = loc ? this.resolve(loc) : null;
      return this._serialRows()
        .filter((r) => r.status === 'in' && (!code || r.loc === code) && (!itemNo || r.itemNo === itemNo))
        .map((r) => ({ sn: r.sn, itemNo: r.itemNo, loc: r.loc, sscc: r.sscc || null }))
        .sort((a, b) => a.sn.localeCompare(b.sn));
    };
  }

  return { install, list };
});
