/*
 * Clients, items, locations, holders, labels, equipment and the stock
 * adjustments that sit on top of the reach-truck rules. Installed onto
 * Warehouse.prototype so the journal can replay the new commands.
 *
 * Loaded before the engine in the browser (window.SortedFoundation) and
 * required by the engine in Node.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SortedFoundation = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const KINDS = ['zone', 'aisle', 'rack', 'level', 'bin', 'block', 'lane'];
  const HOLDER_TYPES = ['pallet', 'crate', 'tote'];
  const ADJUST_REASONS = ['damage', 'expiry', 'found', 'recount', 'correction', 'other'];
  const EQUIPMENT_STATUS = ['running', 'idle', 'fault', 'down', 'maintenance'];

  function num(v, label) {
    if (v == null || v === '') return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) throw new Error(`${label} must be a number of 0 or more`);
    return n;
  }

  function capacityOf(spec) {
    if (!spec) return null;
    const cap = {
      heightMm: num(spec.heightMm, 'Height'),
      widthMm: num(spec.widthMm, 'Width'),
      depthMm: num(spec.depthMm, 'Depth'),
      maxWeightKg: num(spec.maxWeightKg, 'Weight capacity'),
    };
    return Object.values(cap).some((v) => v != null) ? cap : null;
  }

  function barcodeSvg(text) {
    let Barcode = typeof globalThis !== 'undefined' ? globalThis.SortedBarcode : null;
    if (!Barcode && typeof require === 'function') {
      try { Barcode = require('./barcode'); } catch (e) { Barcode = null; }
    }
    if (!Barcode) return '';
    return Barcode.svg(String(text), { gs1: true, module: 1.6, height: 70 });
  }

  function install(Warehouse, deps) {
    const { GS1, Labels } = deps;
    const proto = Warehouse.prototype;

    proto._forgetPlaces = function () {
      this._rackList = null;
      this._bayCache = null;
    };

    proto._client = function (id, { allowArchived = false } = {}) {
      const clientId = String(id || '').trim().toUpperCase();
      const client = this.clients && this.clients[clientId];
      if (!client) throw new Error(`Unknown client ${clientId || id}`);
      if (!allowArchived && client.status === 'archived') throw new Error(`Client ${client.name} is archived`);
      return client;
    };

    proto.addClient = function ({ id, name, contact = '', email = '', phone = '', notes = '' }) {
      this.clients = this.clients || {};
      const clientId = String(id || '').trim().toUpperCase();
      if (!/^[A-Z0-9][A-Z0-9_-]{0,24}$/.test(clientId)) throw new Error('Client id uses letters, digits, hyphen or underscore');
      if (this.clients[clientId]) throw new Error(`Client ${clientId} already exists`);
      const client = {
        id: clientId, name: String(name || '').trim(), contact: String(contact || '').trim(),
        email: String(email || '').trim(), phone: String(phone || '').trim(), notes: String(notes || '').trim(),
        status: 'active', createdAt: this.now(), archivedAt: null,
      };
      if (!client.name) throw new Error('Client name is required');
      this.clients[clientId] = client;
      this.log(`Client ${clientId} ${client.name} added`);
      return client;
    };

    proto.updateClient = function (id, patch) {
      const client = this._client(id, { allowArchived: true });
      if (patch.name != null) {
        const name = String(patch.name).trim();
        if (!name) throw new Error('Client name is required');
        client.name = name;
      }
      for (const key of ['contact', 'email', 'phone', 'notes']) if (patch[key] != null) client[key] = String(patch[key]).trim();
      this.log(`Client ${client.id} updated`);
      return client;
    };

    proto.archiveClient = function (id) {
      const client = this._client(id, { allowArchived: true });
      client.status = 'archived';
      client.archivedAt = this.now();
      this.log(`Client ${client.id} ${client.name} archived`);
      return client;
    };

    proto.restoreClient = function (id) {
      const client = this._client(id, { allowArchived: true });
      client.status = 'active';
      client.archivedAt = null;
      this.log(`Client ${client.id} ${client.name} restored`);
      return client;
    };

    proto.stockForClient = function (id) {
      const clientId = String(id).trim().toUpperCase();
      return Object.values(this.pallets).filter((p) => p.clientId === clientId || (this.items[p.itemNo] && this.items[p.itemNo].clientId === clientId));
    };

    proto.updateItem = function (itemNo, patch) {
      const item = this.items[itemNo];
      if (!item) throw new Error(`Unknown item ${itemNo}`);
      if (patch.name != null) {
        const name = String(patch.name).trim();
        if (!name) throw new Error('Item name is required');
        item.name = name;
      }
      if (patch.uom != null) item.uom = String(patch.uom).trim() || 'case';
      if (patch.storage != null && patch.storage !== item.storage) {
        if (!['rack', 'block'].includes(patch.storage)) throw new Error('Storage is rack or block');
        if (Object.values(this.pallets).some((p) => p.itemNo === itemNo && p.status !== 'shipped')) throw new Error('Storage cannot change while the item is in stock');
        item.storage = patch.storage;
      }
      if (patch.category != null && patch.category !== item.category) {
        if (!this.categories[patch.category]) throw new Error(`Unknown category ${patch.category}`);
        if (Object.values(this.pallets).some((p) => p.itemNo === itemNo && p.status !== 'shipped')) throw new Error('Category cannot change while the item is in stock');
        item.category = patch.category;
      }
      if (patch.palletQty != null) {
        const q = Number(patch.palletQty);
        if (!Number.isInteger(q) || q < 1) throw new Error('Pallet quantity must be a whole number above 0');
        item.palletQty = q;
      }
      for (const [key, label] of [['lengthMm', 'Length'], ['widthMm', 'Width'], ['heightMm', 'Height'], ['weightKg', 'Weight']]) {
        if (key in patch) item[key] = num(patch[key], label);
      }
      if (patch.gtin != null) {
        if (patch.gtin === '') item.gtin = null;
        else {
          if (!GS1.isValidGtin(patch.gtin)) throw new Error(`GTIN ${patch.gtin} has a wrong check digit`);
          item.gtin = GS1.gtin14(patch.gtin);
        }
      }
      if (patch.unitGtin != null) {
        if (patch.unitGtin === '') { item.unitGtin = null; item.unitsPerCase = null; }
        else {
          if (!GS1.isValidGtin(patch.unitGtin)) throw new Error(`Unit EAN ${patch.unitGtin} has a wrong check digit`);
          const units = Number(patch.unitsPerCase != null ? patch.unitsPerCase : item.unitsPerCase);
          if (!(Number.isInteger(units) && units > 0)) throw new Error('Units per case must be a whole number above 0');
          item.unitGtin = GS1.gtin14(patch.unitGtin);
          item.unitsPerCase = units;
        }
      }
      if (patch.codes != null) item.codes = (Array.isArray(patch.codes) ? patch.codes : String(patch.codes).split(/[\s,;]+/)).map((c) => String(c).trim().toUpperCase()).filter(Boolean);
      if (patch.barcodes != null) {
        item.barcodes = (Array.isArray(patch.barcodes) ? patch.barcodes : []).map((b) => (typeof b === 'string' ? { type: 'CODE128', value: b } : { type: b.type || 'CODE128', value: String(b.value || '').trim() })).filter((b) => b.value);
      }
      if (item.gtin && !(item.barcodes || []).some((b) => b.type === 'GTIN' && b.value === item.gtin)) {
        item.barcodes = [{ type: 'GTIN', value: item.gtin }, ...(item.barcodes || [])];
      }
      if ('clientId' in patch) {
        if (!patch.clientId) item.clientId = null;
        else item.clientId = this._client(patch.clientId).id;
      }
      if (patch.minShipDays != null) this.setMinShipDays(itemNo, Number(patch.minShipDays));
      if (patch.status === 'archived' || patch.status === 'active') item.status = patch.status;
      this.log(`Item ${itemNo} updated`);
      return item;
    };

    proto.archiveItem = function (itemNo) {
      const item = this.items[itemNo];
      if (!item) throw new Error(`Unknown item ${itemNo}`);
      item.status = 'archived';
      this.log(`Item ${itemNo} archived`);
      return item;
    };

    proto.removeItem = function (itemNo) {
      const item = this.items[itemNo];
      if (!item) throw new Error(`Unknown item ${itemNo}`);
      if (Object.values(this.pallets).some((p) => p.itemNo === itemNo)) throw new Error('Item has stock history; archive it instead');
      if (Object.values(this.orders).some((o) => o.lines.some((l) => l.itemNo === itemNo))) throw new Error('Item is on an order');
      if (Object.values(this.holders || {}).some((h) => (h.contents || []).some((c) => c.itemNo === itemNo))) throw new Error('Item is on a holder');
      if (Object.values(this.deliveries).some((d) => d.list && Object.values(d.list).some((l) => l.itemNo === itemNo))) throw new Error('Item is on a delivery');
      delete this.items[itemNo];
      this.log(`Item ${itemNo} removed`);
      return { removed: itemNo };
    };

    proto._createBlockLane = function (spec) {
      const id = String(spec.code || spec.id || '').trim().toUpperCase();
      if (!/^[A-Z0-9][A-Z0-9-]{0,16}$/.test(id)) throw new Error('Lane id uses letters, digits or hyphen');
      if ((this.layout.blocks || []).includes(id)) throw new Error(`Block lane ${id} already exists`);
      const stacks = Number(spec.stacks || 1);
      const height = Number(spec.stackHeight || spec.height || 6);
      if (!Number.isInteger(stacks) || stacks < 1 || stacks > 30) throw new Error('Stacks must be a whole number from 1 to 30');
      if (!Number.isInteger(height) || height < 1 || height > 12) throw new Error('Stack height must be a whole number from 1 to 12');
      const category = spec.category || null;
      if (category && !this.categories[category]) throw new Error(`Unknown category ${category}`);
      this.layout.blocks = this.layout.blocks || [];
      this.layout.blocks.push(id);
      const cap = capacityOf(spec);
      const codes = [];
      for (let st = 1; st <= stacks; st++) {
        const code = `${id}-${String(st).padStart(2, '0')}`;
        if (this.locations[code]) throw new Error(`Location ${code} already exists`);
        this.locations[code] = {
          code, kind: 'block', custom: true, aisle: id, lane: id, stack: st, stacks, height,
          category, pallets: [], blocked: false, reservedBy: null, capacity: cap,
          zone: spec.zone || null, parent: spec.parent || null, name: spec.name || null,
        };
        codes.push(code);
      }
      this._forgetPlaces();
      this.log(`Block lane ${id}: ${stacks} stacks, ${height} high`);
      return { lane: id, locations: codes };
    };

    proto.createLocation = function (spec) {
      const kindIn = String(spec.kind || 'bin').trim().toLowerCase();
      if (!KINDS.includes(kindIn)) throw new Error(`Kind is one of ${KINDS.join(', ')}`);
      if (kindIn === 'block' || kindIn === 'lane') return this._createBlockLane(spec);
      const code = String(spec.code || '').trim().toUpperCase();
      if (!/^[A-Z0-9][A-Z0-9-]{0,24}$/.test(code)) throw new Error('Location code uses letters, digits or hyphen');
      if (this.locations[code]) throw new Error(`Location ${code} already exists`);
      if (spec.parent && !this.locations[String(spec.parent).trim().toUpperCase()]) throw new Error(`Unknown parent ${spec.parent}`);
      if (spec.category && !this.categories[spec.category]) throw new Error(`Unknown category ${spec.category}`);
      const structural = kindIn === 'zone' || kindIn === 'aisle' || kindIn === 'rack' || kindIn === 'level';
      const loc = {
        code, kind: kindIn === 'rack' ? 'rack' : kindIn, structural, custom: true,
        name: spec.name ? String(spec.name).trim() : null,
        zone: spec.zone || null, aisle: spec.aisle || null, rack: spec.rack || null,
        level: spec.level == null || spec.level === '' ? null : spec.level,
        bin: spec.bin || null, parent: spec.parent ? String(spec.parent).trim().toUpperCase() : null,
        category: spec.category || null, blocked: false, reservedBy: null, capacity: capacityOf(spec),
      };
      if (kindIn === 'bin') loc.pallets = [];
      if (kindIn === 'rack') loc.sscc = null;
      this.locations[code] = loc;
      this._forgetPlaces();
      this.log(`Location ${code} created (${structural && kindIn === 'rack' ? 'rack' : kindIn})`);
      return loc;
    };

    proto.setLocationCapacity = function (code, spec) {
      const loc = this._loc(this.resolve(code));
      const cap = capacityOf(spec);
      if (loc.sscc && this.pallets[loc.sscc] && cap && !this._fits({ ...loc, capacity: cap }, this.pallets[loc.sscc])) {
        throw new Error(`Stock already in ${loc.code} would not fit that capacity`);
      }
      loc.capacity = cap;
      this.log(`Capacity of ${loc.code} updated`);
      return loc;
    };

    proto.deleteLocation = function (code) {
      const raw = String(code || '').trim().toUpperCase();
      if ((this.layout.blocks || []).includes(raw)) {
        const stacks = Object.values(this.locations).filter((l) => l.lane === raw);
        if (stacks.some((l) => !l.custom)) throw new Error(`${raw} is part of the site layout`);
        if (stacks.some((l) => (l.pallets && l.pallets.length) || l.reservedBy)) throw new Error(`${raw} is not empty`);
        for (const l of stacks) delete this.locations[l.code];
        this.layout.blocks = this.layout.blocks.filter((id) => id !== raw);
        this._forgetPlaces();
        this.log(`Block lane ${raw} removed`);
        return { deleted: raw };
      }
      const resolved = this.locations[raw] ? raw : this.resolve(raw);
      const loc = this.locations[resolved];
      if (!loc) throw new Error(`${code} is not a location`);
      if (loc.code === 'DOCK-IN' || /^OUT-\d+$/.test(loc.code) || loc.code.startsWith('ST-') || loc.kind === 'trailer' || loc.kind === 'station') {
        throw new Error(`${loc.code} is a system location`);
      }
      if (loc.kind === 'block' && !loc.custom) throw new Error(`${loc.code} is part of the site layout`);
      if (loc.sscc || (loc.pallets && loc.pallets.length)) throw new Error(`${loc.code} is not empty`);
      if (loc.reservedBy) throw new Error(`${loc.code} is reserved`);
      if (Object.values(this.holders || {}).some((h) => h.loc === loc.code)) throw new Error(`${loc.code} has a holder`);
      if (Object.values(this.locations).some((l) => l.parent === loc.code)) throw new Error(`Remove locations inside ${loc.code} first`);
      if (Object.values(this.tasks).some((t) => (t.from === loc.code || t.to === loc.code) && ['open', 'active', 'held'].includes(t.status))) {
        throw new Error(`${loc.code} is on a job`);
      }
      delete this.locations[loc.code];
      this._forgetPlaces();
      this.log(`Location ${loc.code} removed`);
      return { deleted: loc.code };
    };

    proto._holder = function (id) {
      const key = String(id || '').trim().toUpperCase();
      const holder = this.holders && this.holders[key];
      if (!holder) throw new Error(`Unknown holder ${id}`);
      return holder;
    };

    proto._holderWeight = function (h) {
      let w = Number(h.tareKg) || 0;
      for (const line of h.contents || []) {
        const item = line.itemNo && this.items[line.itemNo];
        const qty = line.sscc && this.pallets[line.sscc] ? this.pallets[line.sscc].qty : line.qty;
        if (item && item.weightKg != null && item.palletQty) w += item.weightKg * (Number(qty) / item.palletQty);
      }
      return w;
    };

    proto._assertHolderFits = function (loc, holder) {
      if (!loc || !loc.capacity) return;
      const cap = loc.capacity;
      if (cap.heightMm != null && holder.heightMm != null && holder.heightMm > cap.heightMm) throw new Error(`Holder ${holder.id} is too tall for ${loc.code}`);
      if (cap.widthMm != null && cap.depthMm != null && holder.lengthMm != null && holder.widthMm != null) {
        const load = [holder.lengthMm, holder.widthMm].sort((a, b) => a - b);
        const slot = [cap.widthMm, cap.depthMm].sort((a, b) => a - b);
        if (load[0] > slot[0] || load[1] > slot[1]) throw new Error(`Holder ${holder.id} does not fit ${loc.code}`);
      }
      if (cap.maxWeightKg != null) {
        let total = this._holderWeight(holder);
        for (const other of Object.values(this.holders || {})) {
          if (other.loc === loc.code && other.id !== holder.id && other.parentId !== holder.id) total += this._holderWeight(other);
        }
        if (total > cap.maxWeightKg) throw new Error(`${loc.code} weight limit is ${cap.maxWeightKg} kg`);
      }
    };

    proto.addHolder = function (spec) {
      this.holders = this.holders || {};
      const id = String(spec.id || '').trim().toUpperCase();
      if (!id) throw new Error('Holder id is required');
      if (this.holders[id] || this.pallets[id]) throw new Error(`Holder ${id} already exists`);
      const type = String(spec.type || 'pallet').toLowerCase();
      if (!HOLDER_TYPES.includes(type)) throw new Error(`Holder type is one of ${HOLDER_TYPES.join(', ')}`);
      if (spec.clientId) this._client(spec.clientId);
      if (spec.parentId && !this.holders[String(spec.parentId).trim().toUpperCase()]) throw new Error(`Unknown holder ${spec.parentId}`);
      const holder = {
        id, type, loc: null, clientId: spec.clientId ? String(spec.clientId).trim().toUpperCase() : null,
        parentId: spec.parentId ? String(spec.parentId).trim().toUpperCase() : null,
        tareKg: num(spec.tareKg, 'Tare'), lengthMm: num(spec.lengthMm, 'Length'), widthMm: num(spec.widthMm, 'Width'),
        heightMm: num(spec.heightMm, 'Height'), maxWeightKg: num(spec.maxWeightKg, 'Weight capacity'),
        contents: [], createdAt: this.now(),
      };
      this.holders[id] = holder;
      if (spec.loc) this.moveHolder(id, spec.loc);
      for (const line of spec.contents || []) this.loadHolder(id, line);
      this.log(`Holder ${id} (${type}) added`);
      return holder;
    };

    proto.updateHolder = function (id, patch) {
      const holder = this._holder(id);
      if (patch.type != null) {
        const type = String(patch.type).toLowerCase();
        if (!HOLDER_TYPES.includes(type)) throw new Error(`Holder type is one of ${HOLDER_TYPES.join(', ')}`);
        holder.type = type;
      }
      if ('clientId' in patch) holder.clientId = patch.clientId ? this._client(patch.clientId).id : null;
      if ('parentId' in patch) {
        const parentId = patch.parentId ? String(patch.parentId).trim().toUpperCase() : null;
        if (parentId === holder.id) throw new Error('A holder cannot contain itself');
        if (parentId && !this.holders[parentId]) throw new Error(`Unknown holder ${parentId}`);
        let p = parentId;
        while (p) {
          if (p === holder.id) throw new Error('Holder parent cycle');
          p = this.holders[p] && this.holders[p].parentId;
        }
        holder.parentId = parentId;
      }
      for (const [key, label] of [['tareKg', 'Tare'], ['lengthMm', 'Length'], ['widthMm', 'Width'], ['heightMm', 'Height'], ['maxWeightKg', 'Weight capacity']]) {
        if (key in patch) holder[key] = num(patch[key], label);
      }
      if (holder.loc) this._assertHolderFits(this.locations[holder.loc], holder);
      this.log(`Holder ${holder.id} updated`);
      return holder;
    };

    proto.moveHolder = function (id, locCode) {
      const holder = this._holder(id);
      const code = this.resolve(locCode);
      const loc = this._loc(code);
      if (loc.structural || loc.kind === 'zone' || loc.kind === 'aisle' || loc.kind === 'level' || loc.kind === 'frame') throw new Error(`${code} cannot hold a carrier`);
      if (loc.kind === 'rack' && (loc.sscc || Object.values(this.holders).some((x) => x.id !== holder.id && x.loc === code))) {
        throw new Error(`${code} already holds a load`);
      }
      this._assertHolderFits(loc, holder);
      holder.loc = code;
      for (const child of Object.values(this.holders)) if (child.parentId === holder.id && child.loc !== code) this.moveHolder(child.id, code);
      this.log(`Holder ${holder.id} at ${code}`);
      return holder;
    };

    proto.loadHolder = function (id, line) {
      const holder = this._holder(id);
      const sscc = line.sscc ? String(line.sscc).trim() : null;
      if (sscc) {
        const pallet = this._pallet(sscc);
        if (pallet.holderId && pallet.holderId !== holder.id) throw new Error(`Pallet …${sscc.slice(-6)} is on holder ${pallet.holderId}`);
        if (holder.clientId && pallet.clientId && holder.clientId !== pallet.clientId) throw new Error('Pallet belongs to another client');
        pallet.holderId = holder.id;
        if (holder.loc && pallet.loc !== holder.loc) {
          const moved = this.transferPallet(sscc, holder.loc, { by: 'holder' });
          if (!moved.ok) throw new Error(moved.text);
        }
        const item = this.items[pallet.itemNo];
        holder.contents = (holder.contents || []).filter((c) => c.sscc !== sscc);
        holder.contents.push({ sscc, itemNo: pallet.itemNo, batch: pallet.batch, expiry: pallet.expiry, qty: pallet.qty, clientId: pallet.clientId || item.clientId || null });
      } else {
        const item = this.items[line.itemNo];
        if (!item) throw new Error(`Unknown item ${line.itemNo}`);
        if (item.status === 'archived') throw new Error(`Item ${line.itemNo} is archived`);
        if (holder.clientId && item.clientId && holder.clientId !== item.clientId) throw new Error(`Item ${line.itemNo} belongs to another client`);
        const qty = Number(line.qty);
        if (!Number.isInteger(qty) || qty < 1) throw new Error('Quantity must be a whole number above 0');
        holder.contents.push({ sscc: null, itemNo: item.itemNo, batch: line.batch || null, expiry: line.expiry || null, qty, clientId: item.clientId || holder.clientId || null });
      }
      if (holder.loc) this._assertHolderFits(this.locations[holder.loc], holder);
      if (holder.maxWeightKg != null && this._holderWeight(holder) > holder.maxWeightKg) throw new Error(`Holder ${holder.id} weight limit is ${holder.maxWeightKg} kg`);
      this.log(`Holder ${holder.id} loaded`);
      return holder;
    };

    proto.unloadHolder = function (id, line) {
      const holder = this._holder(id);
      const before = holder.contents.length;
      if (line.sscc) {
        const sscc = String(line.sscc).trim();
        holder.contents = holder.contents.filter((c) => c.sscc !== sscc);
        if (this.pallets[sscc] && this.pallets[sscc].holderId === holder.id) this.pallets[sscc].holderId = null;
      } else if (line.index != null) {
        const i = Number(line.index);
        if (!holder.contents[i]) throw new Error('Nothing at that position on the holder');
        const gone = holder.contents.splice(i, 1)[0];
        if (gone.sscc && this.pallets[gone.sscc] && this.pallets[gone.sscc].holderId === holder.id) this.pallets[gone.sscc].holderId = null;
      } else throw new Error('Say which sscc or index to unload');
      if (holder.contents.length === before && line.sscc) throw new Error(`Holder ${holder.id} does not hold ${line.sscc}`);
      this.log(`Holder ${holder.id} unloaded`);
      return holder;
    };

    proto.removeHolder = function (id) {
      const holder = this._holder(id);
      if ((holder.contents || []).length) throw new Error(`Holder ${holder.id} is not empty`);
      if (Object.values(this.holders).some((h) => h.parentId === holder.id)) throw new Error(`Holder ${holder.id} still has a carrier on it`);
      delete this.holders[holder.id];
      this.log(`Holder ${holder.id} removed`);
      return { removed: holder.id };
    };

    proto.issueLabel = function (spec) {
      const kind = spec.kind === 'master' ? 'master' : 'pallet';
      let sscc = spec.sscc ? String(spec.sscc).trim() : null;
      let data;
      let children = [];
      if (kind === 'master') {
        const list = spec.children || [];
        if (!list.length) throw new Error('A master label needs at least one child SSCC');
        children = list.map((c) => {
          const id = String(c.sscc || c).trim();
          const pallet = this.pallets[id];
          if (!pallet) throw new Error(`No pallet ${id}`);
          return { sscc: pallet.sscc, itemNo: pallet.itemNo, qty: pallet.qty, batch: pallet.batch, expiry: pallet.expiry };
        });
        sscc = sscc || this.nextSscc();
        if (!GS1.isValidSscc(sscc)) throw new Error(`SSCC ${sscc} has a wrong check digit`);
        data = { kind, sscc, title: spec.title || 'Master logistic unit', customer: spec.customer || null, orderId: spec.orderId || null, children };
        for (const child of children) if (this.pallets[child.sscc]) this.pallets[child.sscc].masterSscc = sscc;
      } else {
        const pallet = sscc && this.pallets[sscc];
        const holder = !pallet && spec.holderId ? this._holder(spec.holderId) : null;
        if (pallet) {
          const item = this.items[pallet.itemNo];
          const client = (pallet.clientId && this.clients[pallet.clientId]) || (item.clientId && this.clients[item.clientId]);
          sscc = pallet.sscc;
          data = {
            kind, sscc, itemNo: item.itemNo, itemName: item.name, batch: pallet.batch, expiry: pallet.expiry, qty: pallet.qty,
            client: client ? client.name : null, gtin: item.gtin, location: pallet.loc, title: item.name,
          };
        } else if (holder) {
          sscc = GS1.isValidSscc(holder.id) ? holder.id : (sscc || this.nextSscc());
          const line = (holder.contents || [])[0];
          const item = line && this.items[line.itemNo];
          data = {
            kind, sscc, itemNo: line ? line.itemNo : holder.id, itemName: item ? item.name : holder.type, batch: line ? line.batch : '',
            expiry: line ? line.expiry : this.today(), qty: line ? line.qty : '', client: holder.clientId, gtin: item && item.gtin, location: holder.loc,
            title: item ? item.name : `${holder.type} ${holder.id}`,
          };
        } else {
          sscc = sscc || this.nextSscc();
          if (!spec.itemNo || !this.items[spec.itemNo]) throw new Error('Pallet label needs an SSCC in stock or an item');
          const item = this.items[spec.itemNo];
          data = { kind, sscc, itemNo: item.itemNo, itemName: item.name, batch: spec.batch || '', expiry: spec.expiry || this.today(), qty: spec.qty || item.palletQty, client: spec.client || null, gtin: item.gtin, location: spec.location || null, title: item.name };
        }
        if (!GS1.isValidSscc(sscc)) throw new Error(`SSCC ${sscc} has a wrong check digit`);
        data.sscc = sscc;
      }
      const zpl = kind === 'master' ? Labels.masterLabel(data) : Labels.palletLabel(data);
      const record = { id: ++this._seq.label, kind, sscc, at: this.now(), printer: spec.printer || 'SIM', data, children, zpl };
      this.labelLog = this.labelLog || [];
      this.labelLog.unshift(record);
      if (this.labelLog.length > 100) this.labelLog.length = 100;
      this.printQueue.unshift({ id: record.id, printer: record.printer, at: record.at, label: { ...data, kind }, zpl });
      if (this.printQueue.length > 50) this.printQueue.length = 50;
      this.log(`${kind === 'master' ? 'Master' : 'Pallet'} label (00) ${sscc}`);
      return record;
    };

    proto.labelDocument = function (id) {
      const record = (this.labelLog || []).find((r) => String(r.id) === String(id));
      if (!record) throw new Error(`No label ${id}`);
      const d = record.data;
      const lines = d.kind === 'master'
        ? [['SSCC', `(00) ${d.sscc}`], ['Title', d.title || ''], ['Order', d.orderId || ''], ['Units', String((d.children || []).length)]]
        : [['SSCC', `(00) ${d.sscc}`], ['Item', `${d.itemNo || ''} ${d.itemName || ''}`], ['Batch', d.batch || ''], ['Best before', d.expiry || ''], ['Qty', d.qty == null ? '' : String(d.qty)], ['Client', d.client || ''], ['GTIN', d.gtin || ''], ['Location', d.location || '']];
      const html = Labels.labelHtml({ ...d, lines: lines.filter(([, v]) => v), barcodeSvg: barcodeSvg(`00${d.sscc}`) });
      return { ...record, html };
    };

    proto.adjustQuantity = function (sscc, qty, reason, by) {
      const pallet = this._pallet(sscc);
      if (pallet.status === 'shipped') throw new Error('Cannot adjust shipped stock');
      const next = Number(qty);
      if (!Number.isInteger(next) || next < 0) throw new Error('Quantity must be a whole number, 0 or more');
      if (!ADJUST_REASONS.includes(reason)) throw new Error(`Reason must be one of: ${ADJUST_REASONS.join(', ')}`);
      const before = pallet.qty;
      pallet.qty = next;
      const entry = { t: this.now(), sscc, itemNo: pallet.itemNo, batch: pallet.batch, before, after: next, reason, by: by || 'office' };
      this.adjustments = this.adjustments || [];
      this.adjustments.unshift(entry);
      if (this.adjustments.length > 500) this.adjustments.length = 500;
      this.log(`Adjusted …${sscc.slice(-6)} from ${before} to ${next}: ${reason}`);
      return entry;
    };

    proto.replenish = function (itemNo, toCode) {
      const item = this.items[itemNo];
      if (!item) throw new Error(`Unknown item ${itemNo}`);
      const dest = this._loc(this.resolve(toCode));
      if (dest.kind !== 'rack' && dest.kind !== 'bin') throw new Error('Replenish into a rack slot or a bin');
      if (dest.structural) throw new Error(`${dest.code} cannot hold stock`);
      if (dest.kind === 'rack' && dest.sscc) throw new Error(`${dest.code} is not empty`);
      if (dest.kind === 'bin' && dest.pallets.length) throw new Error(`${dest.code} is not empty`);
      if (dest.category && dest.category !== item.category) throw new Error(`${dest.code} is ${this.categories[dest.category] || dest.category}, not ${this.categories[item.category]}`);
      const source = this._fefo(itemNo).find((p) => p.loc !== dest.code);
      if (!source) throw new Error(`No free stock of ${itemNo} to replenish`);
      if (!this._fits(dest, source)) throw new Error(`Pallet …${source.sscc.slice(-6)} does not fit ${dest.code}`);
      const task = this._newTask({ type: 'SHIFT', reason: 'replenish', sscc: source.sscc, from: source.loc, to: dest.code, category: item.category });
      if (dest.kind === 'rack' || dest.kind === 'bin') dest.reservedBy = task.id;
      this.log(`Replenish ${itemNo} → ${dest.code} with …${source.sscc.slice(-6)}`, { taskId: task.id });
      this.dispatch();
      return task;
    };

    proto.recordPacking = function (orderId, note, by) {
      const order = this.orders[String(orderId)];
      if (!order) throw new Error(`No order ${orderId}`);
      const entry = { t: this.now(), note: String(note || 'Packed').trim() || 'Packed', by: by || 'office' };
      order.packing = order.packing || [];
      order.packing.push(entry);
      this.log(`Order ${order.id} packing: ${entry.note}`);
      return entry;
    };

    proto.addEquipment = function (spec) {
      this.equipment = this.equipment || {};
      const id = String(spec.id || '').trim().toUpperCase();
      if (!id) throw new Error('Equipment id is required');
      if (this.equipment[id]) throw new Error(`Equipment ${id} already exists`);
      const status = spec.status || 'idle';
      if (!EQUIPMENT_STATUS.includes(status)) throw new Error(`Status is one of ${EQUIPMENT_STATUS.join(', ')}`);
      const eq = {
        id, name: String(spec.name || id).trim(), kind: spec.kind || 'machine', status,
        location: spec.location || null, stationId: spec.stationId || null, notes: spec.notes || '',
      };
      this.equipment[id] = eq;
      this.log(`Equipment ${id} ${eq.name} added`);
      return eq;
    };

    proto.reportFault = function (spec, by) {
      const eq = this.equipment && this.equipment[String(spec.equipmentId || '').trim().toUpperCase()];
      if (!eq) throw new Error(`Unknown equipment ${spec.equipmentId}`);
      const summary = String(spec.summary || '').trim();
      if (!summary) throw new Error('A fault summary is required');
      const fault = {
        id: ++this._seq.fault, equipmentId: eq.id, summary, detail: String(spec.detail || '').trim(),
        status: 'open', openedAt: this.now(), openedBy: by || 'technician', closedAt: null, closedBy: null, closeNote: null,
      };
      this.faults = this.faults || [];
      this.faults.unshift(fault);
      eq.status = 'fault';
      this.log(`Fault on ${eq.id}: ${summary}`);
      return fault;
    };

    proto.closeFault = function (id, note, by) {
      const fault = (this.faults || []).find((f) => String(f.id) === String(id));
      if (!fault) throw new Error(`No fault ${id}`);
      if (fault.status === 'closed') return fault;
      const text = String(note || '').trim();
      if (!text) throw new Error('A close note is required');
      fault.status = 'closed';
      fault.closedAt = this.now();
      fault.closedBy = by || 'technician';
      fault.closeNote = text;
      const eq = this.equipment[fault.equipmentId];
      if (eq && !(this.faults || []).some((f) => f.equipmentId === eq.id && f.status === 'open')) eq.status = 'running';
      this.log(`Fault #${fault.id} on ${fault.equipmentId} closed`);
      return fault;
    };

    proto.recordMaintenance = function (spec, by) {
      const eq = this.equipment && this.equipment[String(spec.equipmentId || '').trim().toUpperCase()];
      if (!eq) throw new Error(`Unknown equipment ${spec.equipmentId}`);
      const note = String(spec.note || '').trim();
      if (!note) throw new Error('A maintenance note is required');
      const entry = { id: ++this._seq.maint, equipmentId: eq.id, note, at: this.now(), by: spec.by || by || 'technician' };
      this.maintenance = this.maintenance || [];
      this.maintenance.unshift(entry);
      if (this.maintenance.length > 400) this.maintenance.length = 400;
      this.log(`Maintenance on ${eq.id}: ${note}`);
      return entry;
    };

    proto.assignOperator = function (truckId, operator) {
      const truck = this.trucks[truckId] || this.desks[truckId];
      if (!truck) throw new Error(`No device ${truckId}`);
      truck.operator = operator ? String(operator).trim() : null;
      this.log(`${truckId} assigned to ${truck.operator || 'nobody'}`);
      return truck;
    };

    proto.search = function (q) {
      const s = String(q || '').trim().toLowerCase();
      const has = (...parts) => parts.some((p) => String(p == null ? '' : p).toLowerCase().includes(s));
      if (!s) return { clients: [], items: [], locations: [], holders: [], pallets: [], orders: [], deliveries: [] };
      return {
        clients: Object.values(this.clients || {}).filter((c) => has(c.id, c.name, c.contact, c.email)).slice(0, 20),
        items: Object.values(this.items).filter((i) => has(i.itemNo, i.name, i.gtin, ...(i.codes || []), ...((i.barcodes || []).map((b) => b.value)))).slice(0, 20),
        locations: Object.values(this.locations).filter((l) => has(l.code, l.name, l.kind, l.zone, l.aisle)).slice(0, 30).map((l) => ({ code: l.code, kind: l.kind, name: l.name || null, structural: Boolean(l.structural) })),
        holders: Object.values(this.holders || {}).filter((h) => has(h.id, h.type, h.loc)).slice(0, 20),
        pallets: Object.values(this.pallets).filter((p) => has(p.sscc, p.itemNo, p.batch, p.loc, p.clientId)).slice(0, 20).map((p) => ({ sscc: p.sscc, itemNo: p.itemNo, batch: p.batch, expiry: p.expiry, loc: p.loc, qty: p.qty, clientId: p.clientId || null })),
        orders: Object.values(this.orders).filter((o) => has(o.id, o.customer, o.status, o.clientId)).slice(0, 20).map((o) => ({ id: o.id, customer: o.customer, status: o.status, lane: o.lane })),
        deliveries: Object.values(this.deliveries).filter((d) => has(d.id, d.supplier, d.asn, d.status)).slice(0, 20).map((d) => ({ id: d.id, supplier: d.supplier, status: d.status, asn: d.asn || null })),
      };
    };
  }

  return { install, ADJUST_REASONS, HOLDER_TYPES, KINDS, EQUIPMENT_STATUS };
});
