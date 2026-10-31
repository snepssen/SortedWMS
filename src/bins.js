/*
 * Loose stock in bins and on shelves, without a license plate: a quantity
 * of an item on a location, kept per batch and expiry when those are known.
 * A bin can hold several items unless it is set to one item only.
 *
 * Quantities are stored in the item's base unit (its uom, e.g. piece). An
 * item can list packs that hold a whole number of base units (a box of 12,
 * a case of 144); any quantity can be given in a pack and is converted.
 * A pack can carry its own barcode, so scanning a box puts in a box.
 *
 * Installed onto Warehouse.prototype from foundation.js, so the journal
 * replays these commands like the rest.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SortedBins = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const BIN_KINDS = ['bin', 'mezzanine'];
  const COUNT_REASONS = ['recount', 'damage', 'found', 'correction', 'other'];

  function whole(value, label) {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1) throw new Error(`${label} must be a whole number above 0`);
    return n;
  }

  // Units are stored lowercase (piece, box, case) and compared that way.
  function unitCode(value) {
    return String(value == null ? '' : value).trim().toLowerCase();
  }

  function install(Warehouse) {
    const proto = Warehouse.prototype;

    // ---- Units of measure -----------------------------------------------------

    /**
     * Base unit, optional weight per base unit, and the packs the item comes in.
     * packs: [{ unit: 'box', per: 12, barcode: '…' }]. `per` counts base units.
     */
    proto.setItemUnits = function (itemNo, { base = null, unitWeightKg, packs = null } = {}) {
      const item = this.items[itemNo];
      if (!item) throw new Error(`Unknown item ${itemNo}`);
      const baseUnit = base == null || base === '' ? unitCode(item.uom || 'piece') : unitCode(base);
      if (!/^[a-z][a-z0-9]{0,11}$/.test(baseUnit)) throw new Error('A unit is a short word, like piece or box');
      const next = [];
      for (const raw of packs == null ? (item.packs || []) : packs) {
        const unit = unitCode(raw.unit);
        if (!/^[a-z][a-z0-9]{0,11}$/.test(unit)) throw new Error('A pack unit is a short word, like box or case');
        if (unit === baseUnit) throw new Error(`${unit} is the base unit already`);
        if (next.some((p) => p.unit === unit)) throw new Error(`${unit} is listed twice`);
        const per = Number(raw.per);
        if (!Number.isInteger(per) || per < 2) throw new Error(`A ${unit} holds a whole number of ${baseUnit}, 2 or more`);
        const barcode = raw.barcode == null || raw.barcode === '' ? null : String(raw.barcode).trim().toUpperCase();
        if (barcode) {
          const taken = this._unitFromCode(barcode);
          if (taken && !(taken.item.itemNo === item.itemNo && taken.unit === unit)) throw new Error(`Barcode ${barcode} is already ${taken.item.itemNo}${taken.unit ? ' ' + taken.unit : ''}`);
        }
        next.push({ unit, per, barcode });
      }
      next.sort((a, b) => a.per - b.per);
      item.uom = baseUnit;
      item.packs = next;
      if (unitWeightKg !== undefined) {
        if (unitWeightKg == null || unitWeightKg === '') item.unitWeightKg = null;
        else {
          const kg = Number(unitWeightKg);
          if (!Number.isFinite(kg) || kg < 0) throw new Error('Weight per unit must be a number of 0 or more');
          item.unitWeightKg = kg;
        }
      }
      this.log(`Item ${item.itemNo} units: ${[baseUnit, ...next.map((p) => `${p.unit} = ${p.per}`)].join(', ')}`);
      return { itemNo: item.itemNo, base: baseUnit, unitWeightKg: item.unitWeightKg == null ? null : item.unitWeightKg, packs: next };
    };

    /** A quantity in base units. `unit` is the base unit, a pack, or empty for base. */
    proto.toBaseUnits = function (itemNo, qty, unit = null) {
      const item = this.items[itemNo];
      if (!item) throw new Error(`Unknown item ${itemNo}`);
      const n = whole(qty, 'Quantity');
      const u = unitCode(unit);
      if (!u || u === unitCode(item.uom || 'piece')) return n;
      const pack = (item.packs || []).find((p) => p.unit === u);
      if (!pack) throw new Error(`${item.itemNo} has no unit ${u}. Use ${[unitCode(item.uom || 'piece'), ...(item.packs || []).map((p) => p.unit)].join(', ')}`);
      return n * pack.per;
    };

    /** A scanned code as { item, unit, per }: a pack barcode, or the item's own codes (one base unit). */
    proto._unitFromCode = function (code) {
      const key = String(code == null ? '' : code).trim().toUpperCase();
      if (!key) return null;
      for (const item of Object.values(this.items)) {
        for (const pack of item.packs || []) if (pack.barcode === key) return { item, unit: pack.unit, per: pack.per };
      }
      const item = this.items[key] || Object.values(this.items).find((i) => i.gtin === key || i.unitGtin === key || (i.codes || []).includes(key) || (i.barcodes || []).some((b) => String(b.value).toUpperCase() === key));
      return item ? { item, unit: null, per: 1 } : null;
    };

    /** Turn { itemNo | code, qty, unit } into { item, qty in base units }. */
    proto._binQty = function ({ itemNo = null, code = null, qty = 1, unit = null }) {
      if (itemNo) {
        const item = this.items[itemNo];
        if (!item) throw new Error(`Unknown item ${itemNo}`);
        return { item, qty: this.toBaseUnits(item.itemNo, qty, unit) };
      }
      const found = this._unitFromCode(code);
      if (!found) throw new Error(`${code || 'That'} is not an item or a pack barcode`);
      if (unit) return { item: found.item, qty: this.toBaseUnits(found.item.itemNo, qty, unit) };
      return { item: found.item, qty: whole(qty, 'Quantity') * found.per };
    };

    // ---- Bins -----------------------------------------------------------------

    proto._bin = function (code) {
      const resolved = this.resolve(code);
      const loc = this._loc(resolved);
      if (!BIN_KINDS.includes(loc.kind)) throw new Error(`${loc.code} is not a bin or shelf location`);
      this.binStock = this.binStock || {};
      return loc;
    };

    proto._binWeight = function (code) {
      let kg = 0;
      for (const line of (this.binStock && this.binStock[code]) || []) {
        const item = this.items[line.itemNo];
        if (item && item.unitWeightKg != null) kg += item.unitWeightKg * line.qty;
      }
      return kg;
    };

    /** A bin takes one item only, or any mix (the default). */
    proto.setBinMode = function ({ code, mixed = true } = {}) {
      const loc = this._bin(code);
      const lines = this.binStock[loc.code] || [];
      if (!mixed && new Set(lines.map((l) => l.itemNo)).size > 1) throw new Error(`${loc.code} holds more than one item now`);
      loc.mixed = Boolean(mixed);
      this.log(`${loc.code} ${loc.mixed ? 'takes mixed items' : 'takes one item'}`);
      return { code: loc.code, mixed: loc.mixed };
    };

    /** Refuse before anything changes: one-item bins, category, and the weight limit. */
    proto._assertBinTakes = function (bin, item, amount) {
      const lines = (this.binStock && this.binStock[bin.code]) || [];
      if (bin.mixed === false && lines.some((l) => l.itemNo !== item.itemNo)) throw new Error(`${bin.code} takes one item only and holds ${lines[0].itemNo}`);
      if (bin.category && item.category && bin.category !== item.category) throw new Error(`${bin.code} is for ${bin.category}, not ${item.category}`);
      const cap = bin.capacity || {};
      if (cap.maxWeightKg != null && item.unitWeightKg != null) {
        const after = this._binWeight(bin.code) + item.unitWeightKg * amount;
        if (after > cap.maxWeightKg + 1e-9) throw new Error(`${bin.code} weight limit is ${cap.maxWeightKg} kg (that would be ${Math.round(after * 100) / 100} kg)`);
      }
    };

    proto.binPut = function ({ loc, itemNo = null, code = null, qty = 1, unit = null, batch = null, expiry = null, by, event = 'received', note = null } = {}) {
      const bin = this._bin(loc);
      const { item, qty: amount } = this._binQty({ itemNo, code, qty, unit });
      if (item.status === 'archived') throw new Error(`Item ${item.itemNo} is archived`);
      if (item.status === 'pending') throw new Error(`Item ${item.itemNo} is waiting for approval`);
      this._assertBinTakes(bin, item, amount);
      const lines = this.binStock[bin.code] = this.binStock[bin.code] || [];
      const lot = this.feature('lotExpiry') ? { batch: batch ? String(batch).trim() : null, expiry: expiry || null } : { batch: null, expiry: null };
      const same = lines.find((l) => l.itemNo === item.itemNo && l.batch === lot.batch && l.expiry === lot.expiry);
      if (same) same.qty += amount;
      else lines.push({ itemNo: item.itemNo, qty: amount, batch: lot.batch, expiry: lot.expiry, clientId: item.clientId || null, since: this.now() });
      const actor = by || this._actor || 'operator';
      this.recordMovement({ from: null, to: bin.code, qty: amount, event, by: actor, note: note || item.itemNo });
      this.log(`${bin.code} + ${amount} ${item.uom || ''} ${item.itemNo}`.replace(/\s+/g, ' '));
      if (typeof this.planReplenishment === 'function' && event === 'received') this.planReplenishment();
      return { loc: bin.code, itemNo: item.itemNo, qty: amount, unit: item.uom || null, contents: this.binContents(bin.code) };
    };

    /**
     * Take from a bin, earliest expiry first when lots are on, else oldest first.
     * With an order, the quantity counts against that order's piece line and
     * waits, staged under the bin code, for packing.
     */
    proto.binTake = function ({ loc, itemNo = null, code = null, qty = 1, unit = null, batch = null, orderId = null, by, event = 'picked', to = null } = {}) {
      const bin = this._bin(loc);
      const { item, qty: amount } = this._binQty({ itemNo, code, qty, unit });
      const lines = this.binStock[bin.code] || [];
      let mine = lines.filter((l) => l.itemNo === item.itemNo && (!batch || l.batch === batch));
      const have = mine.reduce((s, l) => s + l.qty, 0);
      if (have < amount) throw new Error(`${bin.code} has ${have} ${item.uom || ''} of ${item.itemNo}, not ${amount}`.replace(/\s+/g, ' '));
      let order = null;
      let open = null;
      if (orderId) {
        order = this.orders[String(orderId)];
        if (!order) throw new Error(`No order ${orderId}`);
        if (order.status === 'shipped') throw new Error(`Order ${order.id} is shipped`);
        open = order.lines.find((l) => l.kind === 'each' && l.itemNo === item.itemNo && (l.picked || 0) < l.units);
        if (!open) throw new Error(`Order ${order.id} has no open line for ${item.itemNo}`);
        const need = open.units - (open.picked || 0);
        if (amount > need) throw new Error(`Order ${order.id} only needs ${need} more of ${item.itemNo}`);
      }
      const fefo = this.feature('fefo');
      mine = mine.slice().sort((a, b) => (fefo && a.expiry !== b.expiry ? String(a.expiry || '9999').localeCompare(String(b.expiry || '9999')) : 0) || a.since - b.since);
      let left = amount;
      const taken = [];
      for (const line of mine) {
        if (!left) break;
        const n = Math.min(left, line.qty);
        line.qty -= n;
        left -= n;
        taken.push({ itemNo: item.itemNo, qty: n, batch: line.batch, expiry: line.expiry, clientId: line.clientId });
      }
      this.binStock[bin.code] = lines.filter((l) => l.qty > 0);
      if (!this.binStock[bin.code].length) delete this.binStock[bin.code];
      const actor = by || this._actor || 'operator';
      if (order) {
        open.picked = (open.picked || 0) + amount;
        open.picks = open.picks || [];
        open.picks.push({ bin: bin.code, qty: amount, from: bin.code, t: this.now(), by: actor });
        order.staged = order.staged || [];
        for (const t of taken) order.staged.push({ itemNo: t.itemNo, qty: t.qty, holder: bin.code, batch: t.batch, expiry: t.expiry });
        const piece = order.lines.filter((l) => l.kind === 'each');
        const done = piece.every((l) => (l.picked || 0) >= l.units);
        if (!order.lines.some((l) => l.kind !== 'each' && l.pallets)) order.status = done ? 'ready' : 'picking';
        else if (order.status === 'open') order.status = 'picking';
      }
      this.recordMovement({ from: bin.code, to: to || (order ? `ORDER-${order.id}` : null), qty: amount, event, by: actor, note: order ? `${item.itemNo} for ${order.id}` : item.itemNo });
      this.log(`${bin.code} - ${amount} ${item.uom || ''} ${item.itemNo}${order ? ` for ${order.id}` : ''}`.replace(/\s+/g, ' '));
      if (typeof this.planReplenishment === 'function') this.planReplenishment();
      return { loc: bin.code, itemNo: item.itemNo, qty: amount, taken, orderId: order ? order.id : null, contents: this.binContents(bin.code) };
    };

    /** Move loose stock from one bin to another, keeping batch and expiry. */
    proto.binMove = function ({ from, to, itemNo = null, code = null, qty = 1, unit = null, batch = null, by } = {}) {
      const source = this._bin(from);
      const dest = this._bin(to);
      if (source.code === dest.code) throw new Error('Move to a different bin');
      const { item, qty: amount } = this._binQty({ itemNo, code, qty, unit });
      if (item.status === 'archived') throw new Error(`Item ${item.itemNo} is archived`);
      this._assertBinTakes(dest, item, amount);
      const out = this.binTake({ loc: source.code, itemNo: item.itemNo, qty: amount, batch, by, event: 'moved', to: dest.code });
      for (const t of out.taken) this.binPut({ loc: dest.code, itemNo: t.itemNo, qty: t.qty, batch: t.batch, expiry: t.expiry, by, event: 'moved', note: `${item.itemNo} from ${source.code}` });
      return { from: source.code, to: dest.code, itemNo: item.itemNo, qty: amount, contents: { from: this.binContents(source.code), to: this.binContents(dest.code) } };
    };

    /** Count one item in a bin. A difference corrects the bin and is kept as an adjustment. */
    proto.binCount = function ({ loc, itemNo = null, code = null, counted, unit = null, reason = 'recount', by } = {}) {
      const bin = this._bin(loc);
      const found = itemNo ? this.items[itemNo] : (this._unitFromCode(code) || {}).item;
      if (!found) throw new Error(`Unknown item ${itemNo || code}`);
      if (!COUNT_REASONS.includes(reason)) throw new Error(`Reason is one of ${COUNT_REASONS.join(', ')}`);
      const n = Number(counted);
      if (!Number.isInteger(n) || n < 0) throw new Error('The count is a whole number, 0 or more');
      const target = n === 0 ? 0 : this.toBaseUnits(found.itemNo, n, unit);
      const lines = this.binStock[bin.code] || [];
      const before = lines.filter((l) => l.itemNo === found.itemNo).reduce((s, l) => s + l.qty, 0);
      const actor = by || this._actor || 'operator';
      if (target !== before) {
        if (target > before) {
          const newest = lines.filter((l) => l.itemNo === found.itemNo).sort((a, b) => b.since - a.since)[0];
          if (newest) newest.qty += target - before;
          else lines.push({ itemNo: found.itemNo, qty: target, batch: null, expiry: null, clientId: found.clientId || null, since: this.now() });
          this.binStock[bin.code] = lines;
        } else {
          let left = before - target;
          for (const line of lines.filter((l) => l.itemNo === found.itemNo).sort((a, b) => a.since - b.since)) {
            const k = Math.min(left, line.qty);
            line.qty -= k;
            left -= k;
          }
          this.binStock[bin.code] = lines.filter((l) => l.qty > 0);
          if (!this.binStock[bin.code].length) delete this.binStock[bin.code];
        }
        this.adjustments = this.adjustments || [];
        this.adjustments.unshift({ t: this.now(), loc: bin.code, itemNo: found.itemNo, before, after: target, reason, by: actor });
        if (this.adjustments.length > 500) this.adjustments.length = 500;
        this.recordMovement({ from: bin.code, to: bin.code, qty: target - before, event: 'counted', by: actor, note: `${found.itemNo} ${before} → ${target}` });
      }
      bin.lastCount = this.now();
      this.log(`Counted ${bin.code}: ${found.itemNo} ${before} → ${target}`);
      return { loc: bin.code, itemNo: found.itemNo, before, after: target, difference: target - before };
    };

    proto.binContents = function (code) {
      const loc = this._bin(code);
      const lines = (this.binStock[loc.code] || []).map((l) => {
        const item = this.items[l.itemNo] || {};
        return { itemNo: l.itemNo, name: item.name || '', qty: l.qty, unit: item.uom || null, batch: l.batch, expiry: l.expiry, clientId: l.clientId, packs: packText(item, l.qty) };
      });
      return { code: loc.code, kind: loc.kind, mixed: loc.mixed !== false, weightKg: Math.round(this._binWeight(loc.code) * 1000) / 1000, maxWeightKg: loc.capacity && loc.capacity.maxWeightKg != null ? loc.capacity.maxWeightKg : null, lines };
    };

    /** Every bin holding an item, the one to pick from first at the top. */
    proto.binsFor = function (itemNo) {
      const item = this.items[itemNo] || (this._unitFromCode(itemNo) || {}).item;
      if (!item) throw new Error(`Unknown item ${itemNo}`);
      const fefo = this.feature('fefo');
      const rows = [];
      for (const [code, lines] of Object.entries(this.binStock || {})) {
        for (const l of lines) if (l.itemNo === item.itemNo) rows.push({ loc: code, qty: l.qty, unit: item.uom || null, batch: l.batch, expiry: l.expiry, since: l.since, packs: packText(item, l.qty) });
      }
      rows.sort((a, b) => (fefo && a.expiry !== b.expiry ? String(a.expiry || '9999').localeCompare(String(b.expiry || '9999')) : 0) || a.since - b.since);
      return { itemNo: item.itemNo, name: item.name, unit: item.uom || null, packs: item.packs || [], total: rows.reduce((s, r) => s + r.qty, 0), bins: rows };
    };

    /** Every bin that holds something, in code order. */
    proto.binList = function ({ limit = 200 } = {}) {
      const codes = Object.keys(this.binStock || {}).filter((c) => (this.binStock[c] || []).length).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      return { total: codes.length, bins: codes.slice(0, limit).map((c) => this.binContents(c)) };
    };

    /** Loose quantity of an item across bins, split into on hand and held (quarantine or returns). */
    proto._binTotals = function (itemNo) {
      let onHand = 0;
      let held = 0;
      for (const [code, lines] of Object.entries(this.binStock || {})) {
        const place = this.locations[code];
        const blocked = place && (place.role === 'quarantine' || place.role === 'return' || place.quarantine || place.blocked);
        for (const l of lines) if (l.itemNo === itemNo) { onHand += l.qty; if (blocked) held += l.qty; }
      }
      return { onHand, held };
    };
  }

  /** "2 box + 6 piece" for a quantity in base units. */
  function packText(item, qty) {
    const packs = (item.packs || []).slice().sort((a, b) => b.per - a.per);
    if (!packs.length) return null;
    let left = qty;
    const parts = [];
    for (const p of packs) {
      const k = Math.floor(left / p.per);
      if (k) { parts.push(`${k} ${p.unit}`); left -= k * p.per; }
    }
    if (left) parts.push(`${left} ${item.uom || ''}`.trim());
    return parts.join(' + ');
  }

  return { install, BIN_KINDS, COUNT_REASONS, packText };
});
