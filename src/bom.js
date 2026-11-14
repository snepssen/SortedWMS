/*
 * Bills of materials for a client item. A build consumes the components
 * and puts the kit item into stock. Lots and serials apply only while
 * those modules are on.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SortedBom = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function on(wh, id) {
    return typeof wh.module !== 'function' || wh.module(id);
  }

  function whole(n, name) {
    const qty = Number(n);
    if (!Number.isInteger(qty) || qty < 1) throw new Error(`${name} must be a whole number above 0`);
    return qty;
  }

  function install(Warehouse) {
    const proto = Warehouse.prototype;

    proto.setBom = function ({ itemNo, lines } = {}) {
      const item = this.items[itemNo];
      if (!item) throw new Error(`Unknown item ${itemNo}`);
      if (!Array.isArray(lines) || !lines.length) throw new Error('A bill of materials needs components');
      const clean = [];
      for (const line of lines) {
        const part = this.items[line.itemNo];
        if (!part) throw new Error(`Unknown component ${line && line.itemNo}`);
        if ((part.clientId || null) !== (item.clientId || null)) throw new Error(`${part.itemNo} belongs to another client`);
        if (part.itemNo === item.itemNo) throw new Error('A kit cannot contain itself');
        clean.push({ itemNo: part.itemNo, qty: whole(line.qty, 'Component quantity') });
      }
      this.boms = this.boms || {};
      this.boms[item.itemNo] = { itemNo: item.itemNo, clientId: item.clientId || null, lines: clean };
      this.log(`Bill of materials for ${item.itemNo}`);
      return this.boms[item.itemNo];
    };

    proto._bomNeed = function (kit) {
      if (!on(this, 'bom')) return null;
      const output = kit.output || kit.base.itemNo;
      const bom = (this.boms || {})[output];
      if (!bom) return null;
      return bom.lines.map((line) => ({ itemNo: line.itemNo, qty: line.qty, role: 'component' }));
    };

    proto._bomFinish = function (job, by) {
      if (!on(this, 'bom')) return null;
      const kit = this.kits && this.kits[job.kitId];
      const output = kit && (kit.output || kit.base.itemNo);
      const bom = output && this.boms && this.boms[output];
      if (!bom) return null;
      const lotsOn = on(this, 'lots');
      const lot = lotsOn ? (job.got || []).find((g) => g.batch || g.expiry) : null;
      if (!this.locations['KIT-OUT']) this.createLocation({ code: 'KIT-OUT', kind: 'bin', name: 'Kit output' });
      return this.binPut({
        loc: 'KIT-OUT', itemNo: output, qty: 1,
        batch: lot ? lot.batch : null, expiry: lot ? lot.expiry : null,
        by, event: 'produced', note: job.kitId,
      });
    };

    proto._bomConsume = function (itemNo, qty, { lotsOn, serials, by } = {}) {
      const places = [];
      for (const [loc, lines] of Object.entries(this.binStock || {})) {
        for (const line of lines || []) {
          if (line.itemNo === itemNo && line.qty > 0) places.push({ loc, batch: line.batch || null, expiry: line.expiry || null, since: line.since || 0, qty: line.qty });
        }
      }
      places.sort((a, b) => (lotsOn && a.expiry !== b.expiry ? String(a.expiry || '9999').localeCompare(String(b.expiry || '9999')) : 0) || a.since - b.since);
      const serialsOn = on(this, 'serials') && this.items[itemNo] && this.items[itemNo].serialized;
      const leftSerials = serialsOn ? (Array.isArray(serials) ? serials.slice() : []) : null;
      if (serialsOn && leftSerials.length !== qty) throw new Error(`${itemNo} needs ${qty} serial numbers`);
      let left = qty;
      const taken = [];
      for (const place of places) {
        if (!left) break;
        const n = Math.min(left, place.qty);
        const sns = serialsOn ? leftSerials.splice(0, n) : null;
        this.binTake({
          loc: place.loc, itemNo, qty: n, by, event: 'kitted',
          batch: lotsOn ? place.batch : null,
          ...(lotsOn ? { expiry: place.expiry } : {}),
          serials: sns,
        });
        taken.push({ itemNo, qty: n, loc: place.loc, batch: lotsOn ? place.batch : null, expiry: lotsOn ? place.expiry : null });
        left -= n;
        place.qty -= n;
      }
      if (left) throw new Error(`Not enough ${itemNo} for the kit: ${left} short`);
      return taken;
    };

    proto.buildKit = function ({ itemNo, qty, loc, serials = null, by } = {}) {
      if (!on(this, 'bom')) throw new Error('Bills of materials are switched off');
      if (!on(this, 'kitting')) throw new Error('Kitting is switched off');
      const item = this.items[itemNo];
      if (!item) throw new Error(`Unknown item ${itemNo}`);
      const bom = (this.boms || {})[item.itemNo];
      if (!bom) throw new Error(`No bill of materials for ${itemNo}`);
      const n = whole(qty, 'Kit quantity');
      const lotsOn = on(this, 'lots');
      const consumed = [];
      for (const line of bom.lines) consumed.push(...this._bomConsume(line.itemNo, line.qty * n, { lotsOn, serials: serials && serials[line.itemNo], by }));
      const serialsOn = on(this, 'serials') && item.serialized;
      const outSerials = serialsOn ? (serials && serials[itemNo]) : null;
      if (serialsOn && (!outSerials || outSerials.length !== n)) throw new Error(`${itemNo} needs ${n} serial numbers`);
      const lot = lotsOn ? (consumed.find((row) => row.batch || row.expiry) || {}) : {};
      const made = this.binPut({
        loc, itemNo: item.itemNo, qty: n, by, event: 'produced', note: 'kit',
        batch: lot.batch || null, expiry: lot.expiry || null, serials: outSerials,
      });
      this.log(`Built ${n} ${item.itemNo} from its bill of materials`);
      return { itemNo: item.itemNo, qty: n, loc: made.loc, consumed };
    };
  }

  return { install };
});
