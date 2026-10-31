/*
 * Stock checks and item corrections.
 *
 * A check puts a location on hold: a customer reports the wrong item from an
 * order picked there, or someone on the floor sees something off. Nothing at
 * that location can be picked, allocated, transferred or moved out until stock
 * control has looked. Open wave picks there are cancelled and planned again
 * from other stock.
 *
 * A correction replaces stock that was booked under the wrong item, as one
 * record: the old pallet, plate or bin line goes out (−64 of 845356) and the
 * right item comes in at the same place (+64 of 845359), on a new ST plate for
 * a pallet or plate, or as loose stock for a bin. The old plate number is
 * retired. Both sides are kept as adjustments that point at the correction,
 * so the daily stock-changes report shows them side by side.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SortedCorrections = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DAY = 86400000;

  function install(Warehouse) {
    const proto = Warehouse.prototype;

    proto._checkAt = function (code) {
      const loc = code && this.locations[code];
      return loc && loc.checkHold ? this.checks[loc.checkHold] : null;
    };

    /** Refuse to take stock out of a location that is held for a check. */
    proto._assertNotHeld = function (code, what = 'Stock') {
      const check = this._checkAt(code);
      if (check) throw new Error(`${what} at ${code} is held for stock check ${check.id}: ${check.note}`);
    };

    proto.raiseCheck = function ({ loc, itemNo = null, orderId = null, note = '', by } = {}) {
      const code = this.resolve(loc);
      const place = this._loc(code);
      if (place.structural) throw new Error(`${code} holds no stock`);
      if (place.checkHold) throw new Error(`${code} is already held for check ${place.checkHold}`);
      const text = String(note || '').trim();
      if (!text) throw new Error('Say what to check, for example: wrong item reported in order 4501');
      if (itemNo && !this.items[itemNo]) throw new Error(`Unknown item ${itemNo}`);
      if (orderId && !this.orders[String(orderId)]) throw new Error(`No order ${orderId}`);
      this.checks = this.checks || {};
      this._seq.check = (this._seq.check || 0) + 1;
      const id = `K${String(this._seq.check).padStart(4, '0')}`;
      const actor = by || this._actor || 'office';
      const check = { id, loc: code, itemNo: itemNo || null, orderId: orderId ? String(orderId) : null, note: text, status: 'open', raisedBy: actor, raisedAt: this.now() };
      this.checks[id] = check;
      place.checkHold = id;
      let cancelled = 0;
      for (const wave of Object.values(this.waves || {})) {
        for (const t of wave.tasks) if (t.status === 'open' && t.loc === code) { t.status = 'cancelled'; t.cancelReason = `Stock check ${id}`; cancelled++; }
      }
      this.log(`Stock check ${id} on ${code}: ${text}${cancelled ? ` (${cancelled} wave pick${cancelled === 1 ? '' : 's'} cancelled)` : ''}`, { by: actor });
      return { ...check, cancelledPicks: cancelled };
    };

    proto.closeCheck = function ({ id, outcome = 'ok', note = '', by } = {}) {
      const check = this.checks && this.checks[String(id || '').trim().toUpperCase()];
      if (!check) throw new Error(`No stock check ${id}`);
      if (check.status !== 'open') throw new Error(`Stock check ${check.id} is ${check.status}`);
      if (!['ok', 'corrected'].includes(outcome)) throw new Error('Outcome is ok or corrected');
      check.status = 'closed';
      check.outcome = outcome;
      check.closeNote = String(note || '').trim() || null;
      check.closedBy = by || this._actor || 'stock';
      check.closedAt = this.now();
      const place = this.locations[check.loc];
      if (place && place.checkHold === check.id) delete place.checkHold;
      this.log(`Stock check ${check.id} on ${check.loc} closed: ${outcome === 'ok' ? 'stock is right' : 'corrected'}${check.closeNote ? ` (${check.closeNote})` : ''}`);
      return check;
    };

    proto.openChecks = function () {
      return Object.values(this.checks || {}).filter((c) => c.status === 'open').map((c) => ({ ...c, stock: this._stockAt(c.loc) }));
    };

    /** Everything booked at a location: pallets, plates without a pallet, and bin lines. */
    proto._stockAt = function (code) {
      const out = [];
      for (const p of Object.values(this.pallets)) {
        if (p.loc !== code || p.status === 'shipped') continue;
        out.push({ kind: 'pallet', sscc: p.sscc, plate: p.holderId || null, itemNo: p.itemNo, name: (this.items[p.itemNo] || {}).name || '', qty: p.qty, batch: p.batch || null });
      }
      for (const h of Object.values(this.holders || {})) {
        if (h.loc !== code || h.sscc || h.status === 'retired' || h.cartonStatus) continue;
        for (const c of h.contents || []) if (Number(c.qty) > 0) out.push({ kind: 'plate', plate: h.id, itemNo: c.itemNo, name: (this.items[c.itemNo] || {}).name || '', qty: Number(c.qty), batch: c.batch || null });
      }
      for (const l of (this.binStock && this.binStock[code]) || []) out.push({ kind: 'bin', itemNo: l.itemNo, name: (this.items[l.itemNo] || {}).name || '', qty: l.qty, batch: l.batch || null });
      return out;
    };

    proto._adjust = function (entry) {
      this.adjustments = this.adjustments || [];
      this.adjustments.unshift({ t: this.now(), ...entry });
      if (this.adjustments.length > 5000) this.adjustments.length = 5000;
    };

    proto._retirePlate = function (holder, actor, note) {
      const qty = (holder.contents || []).reduce((s, c) => s + (Number(c.qty) || 0), 0);
      holder.contents = [];
      holder.status = 'retired';
      holder.retiredAt = this.now();
      holder.retiredBy = actor;
      this.recordMovement({ holder: holder.id, sscc: holder.sscc || null, from: holder.loc, to: null, qty, event: 'retired', by: actor, note });
      holder.loc = null;
    };

    /**
     * Replace stock booked under the wrong item. `target` is the pallet SSCC,
     * the plate (INB, ST, PAL) or, with `fromItem`, a bin location. The right
     * item comes in at the same location with the counted quantity.
     */
    proto.correctItem = function ({ target, fromItem = null, itemNo, qty, reason = 'wrong item', by } = {}) {
      const actor = by || this._actor || 'stock';
      const item = this.items[itemNo];
      if (!item) throw new Error(`Unknown item ${itemNo}`);
      if (item.status === 'archived') throw new Error(`Item ${itemNo} is archived`);
      const amount = Number(qty);
      if (!Number.isInteger(amount) || amount < 1) throw new Error('Count what is really there: a whole number above 0');
      const why = String(reason || '').trim() || 'wrong item';
      const key = String(target || '').trim();
      const pallet = this.pallets[key];
      const holder = !pallet && this.holders && this.holders[key.toUpperCase()];
      this.corrections = this.corrections || {};
      this._seq.correction = (this._seq.correction || 0) + 1;
      const id = `C${String(this._seq.correction).padStart(4, '0')}`;
      let code;
      let from;
      if (pallet) {
        if (pallet.status === 'shipped') throw new Error(`Pallet …${pallet.sscc.slice(-6)} is not in stock`);
        if (pallet.orderId) throw new Error(`Pallet …${pallet.sscc.slice(-6)} is on order ${pallet.orderId}. Take it off the order first`);
        const live = this._liveTaskFor(pallet.sscc);
        if (live) throw new Error(`Pallet …${pallet.sscc.slice(-6)} has job #${live.id}`);
        code = pallet.loc;
        from = { kind: 'pallet', itemNo: pallet.itemNo, qty: pallet.qty, sscc: pallet.sscc, plate: pallet.holderId || null, batch: pallet.batch || null };
        for (const wave of Object.values(this.waves || {})) for (const t of wave.tasks) if (t.status === 'open' && t.sscc === pallet.sscc) { t.status = 'cancelled'; t.cancelReason = `Correction ${id}`; }
        this._remove(pallet);
        pallet.status = 'shipped';
        pallet.removed = 'corrected';
        pallet.goneAt = this.now();
        pallet.correctedBy = id;
        this.recordMovement({ holder: pallet.holderId || null, sscc: pallet.sscc, from: code, to: null, qty: pallet.qty, event: 'deleted', by: actor, note: `${id}: ${why}` });
        const pal = pallet.holderId && this.holders[pallet.holderId];
        if (pal && pal.status !== 'retired') this._retirePlate(pal, actor, `${id}: ${why}`);
        // A MASTER over other pallets stays; one that only held this pallet is retired with it.
        const master = pallet.masterId && this.holders[pallet.masterId];
        if (master && master.status !== 'retired' && (master.children || []).every((c) => c === pallet.holderId)) this._retirePlate(master, actor, `${id}: ${why}`);
        else if (master) master.children = (master.children || []).filter((c) => c !== pallet.holderId);
      } else if (holder) {
        if (holder.status === 'retired') throw new Error(`Plate ${holder.id} is retired`);
        if (holder.cartonStatus) throw new Error(`${holder.id} is a packed carton`);
        if (!holder.loc) throw new Error(`Plate ${holder.id} is not on a location`);
        code = holder.loc;
        const line = (holder.contents || []).find((c) => Number(c.qty) > 0) || {};
        from = { kind: 'plate', itemNo: line.itemNo || null, qty: (holder.contents || []).reduce((s, c) => s + (Number(c.qty) || 0), 0), plate: holder.id, batch: line.batch || null };
        this._retirePlate(holder, actor, `${id}: ${why}`);
      } else {
        code = this.resolve(key);
        const lines = (this.binStock && this.binStock[code]) || [];
        if (!lines.length) throw new Error(`${key} is not a pallet, a plate, or a bin with stock`);
        const wrong = fromItem || (new Set(lines.map((l) => l.itemNo)).size === 1 ? lines[0].itemNo : null);
        if (!wrong) throw new Error(`${code} holds more than one item. Say which one is wrong`);
        const had = lines.filter((l) => l.itemNo === wrong).reduce((s, l) => s + l.qty, 0);
        if (!had) throw new Error(`${code} has no ${wrong}`);
        from = { kind: 'bin', itemNo: wrong, qty: had };
        this.binStock[code] = lines.filter((l) => l.itemNo !== wrong);
        if (!this.binStock[code].length) delete this.binStock[code];
        this.recordMovement({ from: code, to: null, qty: had, event: 'deleted', by: actor, note: `${id}: ${wrong} ${why}` });
      }
      this._adjust({ loc: code, sscc: from.sscc || null, plate: from.plate || null, itemNo: from.itemNo, before: from.qty, after: 0, reason: why, by: actor, correctionId: id });
      // The right item, at the same place.
      const to = { itemNo: item.itemNo, qty: amount };
      if (from.kind === 'bin') {
        const lines = this.binStock[code] = this.binStock[code] || [];
        lines.push({ itemNo: item.itemNo, qty: amount, batch: null, expiry: null, clientId: item.clientId || null, since: this.now() });
        this.recordMovement({ from: null, to: code, qty: amount, event: 'created', by: actor, note: `${id}: ${item.itemNo}` });
      } else if (from.kind === 'pallet') {
        const fresh = this.stockPallet(code, { itemNo: item.itemNo, qty: amount, batch: from.batch, receivedAt: this.now() });
        const minted = this.allocatePlate('ST');
        const line = { sscc: fresh.sscc, itemNo: item.itemNo, batch: fresh.batch || null, expiry: fresh.expiry || null, qty: amount, clientId: item.clientId || null };
        const plate = this._makePlate(minted, { type: 'st', loc: code, clientId: line.clientId, sscc: fresh.sscc, contents: [line] });
        fresh.holderId = plate.id;
        this.recordMovement({ holder: plate.id, sscc: fresh.sscc, from: null, to: code, qty: amount, event: 'created', by: actor, note: `${id}: replaces ${from.plate || '…' + from.sscc.slice(-6)}` });
        this._printPlate(plate, { sscc: fresh.sscc, itemNo: item.itemNo, itemName: item.name, qty: amount, location: code });
        to.sscc = fresh.sscc;
        to.plate = plate.id;
      } else {
        const out = this.issueSeries({ series: 'ST', itemNo: item.itemNo, qty: amount, loc: code, batch: from.batch, by: actor });
        to.plate = out.holder.id;
      }
      this._adjust({ loc: code, sscc: to.sscc || null, plate: to.plate || null, itemNo: item.itemNo, before: 0, after: amount, reason: why, by: actor, correctionId: id });
      const check = this._checkAt(code);
      const record = { id, t: this.now(), by: actor, reason: why, loc: code, from, to, checkId: check ? check.id : null };
      this.corrections[id] = record;
      this.log(`Correction ${id} at ${code}: −${from.qty} ${from.itemNo}, +${amount} ${item.itemNo} (${why})`, { by: actor });
      if (check) this.closeCheck({ id: check.id, outcome: 'corrected', note: id, by: actor });
      return record;
    };

    /**
     * Every stock change by hand in a period: counts, corrections, created and
     * deleted stock. One row per change, plus the net per item.
     */
    proto.stockChanges = function ({ from = null, to = null } = {}) {
      const tz = typeof this.localDay === 'function';
      const start = from ? (tz ? this.zonedMidnight(from) : Date.parse(from)) : -Infinity;
      const end = to ? (tz ? this.zonedMidnight(to) : Date.parse(to)) + DAY : Infinity;
      // Stored newest first; the report reads in the order things happened.
      const rows = (this.adjustments || []).slice().reverse()
        .filter((a) => a.t >= start && a.t < end)
        .map((a) => ({
          t: a.t, day: tz ? this.localDay(a.t) : new Date(a.t).toISOString().slice(0, 10), itemNo: a.itemNo, name: (this.items[a.itemNo] || {}).name || '',
          change: (Number(a.after) || 0) - (Number(a.before) || 0), before: a.before, after: a.after, reason: a.reason, loc: a.loc || (a.sscc && this.pallets[a.sscc] ? this.pallets[a.sscc].loc : null),
          sscc: a.sscc || null, plate: a.plate || null, by: a.by, correctionId: a.correctionId || null,
        }))
        .filter((r) => r.change !== 0)
        .sort((a, b) => a.t - b.t);
      const net = {};
      for (const r of rows) net[r.itemNo] = (net[r.itemNo] || 0) + r.change;
      return { from, to, rows, net: Object.entries(net).map(([itemNo, change]) => ({ itemNo, name: (this.items[itemNo] || {}).name || '', change })) };
    };

    proto.stockChangesCsv = function (opts) {
      const out = this.stockChanges(opts);
      const cell = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
      const lines = [['day', 'item', 'name', 'change', 'reason', 'location', 'pallet', 'plate', 'by', 'correction']];
      for (const r of out.rows) lines.push([r.day, r.itemNo, r.name, r.change > 0 ? `+${r.change}` : r.change, r.reason, r.loc, r.sscc, r.plate, r.by, r.correctionId]);
      return lines.map((l) => l.map(cell).join(',')).join('\n');
    };
  }

  return { install };
});
