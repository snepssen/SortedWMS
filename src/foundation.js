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

  const KINDS = ['zone', 'aisle', 'rack', 'level', 'bin', 'mezzanine', 'virtual', 'block', 'lane'];
  const VIRTUAL_ROLES = ['consolidation', 'staging', 'return', 'quarantine', 'transit', 'other'];
  const SERIES = ['PAL', 'MASTER', 'ST', 'INB', 'OUT'];
  const HOLDER_TYPES = ['pallet', 'crate', 'tote'];
  const ADJUST_REASONS = ['damage', 'expiry', 'found', 'recount', 'correction', 'other'];
  const EQUIPMENT_STATUS = ['running', 'idle', 'fault', 'down', 'maintenance'];
  const PROFILE_PRESETS = {
    'high-value': { name: 'High value', storageType: 'rack', temperature: 'ambient', security: 'high', autoSort: 'secure nearest', label: 'High-value plate', capacity: { heightMm: 1600, widthMm: 1000, depthMm: 1200, maxWeightKg: 600, positionsPerLevel: 1 } },
    'food-chilled': { name: 'Food / chilled', storageType: 'rack', temperature: 'chilled', security: 'standard', autoSort: 'fefo', label: 'Chilled food', capacity: { heightMm: 1800, widthMm: 1000, depthMm: 1200, maxWeightKg: 1000, positionsPerLevel: 1 } },
    frozen: { name: 'Frozen', storageType: 'rack', temperature: 'frozen', security: 'standard', autoSort: 'fefo', label: 'Frozen', capacity: { heightMm: 1800, widthMm: 1000, depthMm: 1200, maxWeightKg: 1000, positionsPerLevel: 1 } },
    'low-value': { name: 'Low value', storageType: 'shelf', temperature: 'ambient', security: 'low', autoSort: 'nearest', label: 'Bin', capacity: { maxUnits: 24, maxWeightKg: 250, maxVolumeM3: 1.2 } },
    home: { name: 'Home / small maker', storageType: 'shelf', temperature: 'ambient', security: 'low', autoSort: 'nearest', label: 'Home shelf', capacity: { maxUnits: 8, maxWeightKg: 40, maxVolumeM3: 0.3 } },
  };

  function profileRange(from, to, label) {
    const a = String(from == null ? '' : from).trim();
    const b = String(to == null || to === '' ? a : to).trim();
    if (!a) throw new Error(`${label} needs a from and to`);
    if (/^\d+$/.test(a) && /^\d+$/.test(b)) {
      const width = Math.max(a.length, b.length);
      const out = [];
      for (let n = Number(a); n <= Number(b); n++) out.push(String(n).padStart(width, '0'));
      if (!out.length || out.length > 40) throw new Error(`${label} range is empty or too long`);
      return out;
    }
    if (/^[A-Za-z]$/.test(a) && /^[A-Za-z]$/.test(b)) {
      const out = [];
      for (let c = a.toUpperCase().charCodeAt(0); c <= b.toUpperCase().charCodeAt(0); c++) out.push(String.fromCharCode(c));
      if (!out.length || out.length > 26) throw new Error(`${label} range is empty or too long`);
      return out;
    }
    throw new Error(`${label} is a number range or a letter range`);
  }

  function profileCapacity(storageType, raw) {
    const src = raw || {};
    const n = (value, label) => {
      if (value == null || value === '') return null;
      const num = Number(value);
      if (!Number.isFinite(num) || num <= 0) throw new Error(`${label} must be a number above 0`);
      return num;
    };
    if (storageType === 'shelf') {
      const cap = { maxUnits: n(src.maxUnits, 'Boxes'), maxVolumeM3: n(src.maxVolumeM3, 'Volume'), maxWeightKg: n(src.maxWeightKg, 'Weight') };
      if (cap.maxUnits == null && cap.maxVolumeM3 == null && cap.maxWeightKg == null) throw new Error('A shelf needs a box count, a volume or a weight');
      return cap;
    }
    if (storageType === 'block') {
      const cap = { stackHeight: n(src.stackHeight, 'Stack height'), footprintLengthMm: n(src.footprintLengthMm, 'Footprint length'), footprintWidthMm: n(src.footprintWidthMm, 'Footprint width'), maxWeightKg: n(src.maxWeightKg, 'Weight') };
      if (cap.stackHeight == null || cap.footprintLengthMm == null || cap.footprintWidthMm == null) throw new Error('A block stack needs a footprint and a stack height in pallets');
      return cap;
    }
    if (storageType !== 'rack') throw new Error('Storage is shelf, rack or block');
    const cap = { positionsPerLevel: n(src.positionsPerLevel, 'Positions per level') || 1, heightMm: n(src.heightMm, 'Height'), widthMm: n(src.widthMm, 'Width'), depthMm: n(src.depthMm, 'Depth'), maxWeightKg: n(src.maxWeightKg, 'Weight') };
    if (cap.heightMm == null || cap.widthMm == null || cap.maxWeightKg == null) throw new Error('A rack needs positions per level plus height, width and weight');
    return cap;
  }

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

  function barcodeSvg(text, gs1) {
    let Barcode = typeof globalThis !== 'undefined' ? globalThis.SortedBarcode : null;
    if (!Barcode && typeof require === 'function') {
      try { Barcode = require('./barcode'); } catch (e) { Barcode = null; }
    }
    if (!Barcode) return '';
    return Barcode.svg(String(text), { gs1: Boolean(gs1), module: 1.6, height: 70 });
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
      for (const key of ['storageRate', 'handlingRate']) {
        if (patch[key] == null || patch[key] === '') continue;
        const rate = Number(patch[key]);
        if (!Number.isFinite(rate) || rate < 0) throw new Error(`${key === 'storageRate' ? 'Storage' : 'Handling'} rate must be a number of 0 or more`);
        client[key] = rate;
      }
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
      if ('reorderPoint' in patch) {
        if (patch.reorderPoint == null || patch.reorderPoint === '') item.reorderPoint = null;
        else {
          const point = Number(patch.reorderPoint);
          if (!Number.isInteger(point) || point < 0) throw new Error('Reorder point must be a whole number of 0 or more');
          item.reorderPoint = point;
        }
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
      for (const key of ['food', 'frozen', 'highValue']) if (key in patch) {
        item.flags = item.flags || {};
        item.flags[key] = Boolean(patch[key]);
      }
      const actor = this._actor || 'unknown';
      this.log(`Item ${itemNo} updated by ${actor}`, { by: actor });
      return item;
    };

    proto.archiveItem = function (itemNo) {
      const item = this.items[itemNo];
      if (!item) throw new Error(`Unknown item ${itemNo}`);
      item.status = 'archived';
      this.log(`Item ${itemNo} archived by ${this._actor || 'unknown'}`, { by: this._actor || 'unknown' });
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
      const preserve = Boolean(spec.preserveCase);
      const kindIn = String(spec.kind || 'bin').trim().toLowerCase();
      if (!KINDS.includes(kindIn)) throw new Error(`Kind is one of ${KINDS.join(', ')}`);
      if (kindIn === 'block' || kindIn === 'lane') return this._createBlockLane(spec);
      const code = preserve ? String(spec.code || '').trim() : String(spec.code || '').trim().toUpperCase();
      if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/.test(code)) throw new Error('Location code uses letters, digits or hyphen');
      if (this.locations[code]) throw new Error(`Location ${code} already exists`);
      if (spec.parent && !this.locations[String(spec.parent).trim().toUpperCase()]) throw new Error(`Unknown parent ${spec.parent}`);
      if (spec.category && !this.categories[spec.category]) throw new Error(`Unknown category ${spec.category}`);
      const structural = kindIn === 'zone' || kindIn === 'aisle' || kindIn === 'rack' || kindIn === 'level';
      const role = spec.role ? String(spec.role).trim().toLowerCase() : (kindIn === 'virtual' ? 'other' : null);
      if (kindIn === 'virtual' && role && !VIRTUAL_ROLES.includes(role)) throw new Error(`Virtual role is one of ${VIRTUAL_ROLES.join(', ')}`);
      const loc = {
        code, kind: kindIn === 'rack' ? 'rack' : kindIn, structural, custom: true, virtual: kindIn === 'virtual',
        role: kindIn === 'virtual' ? role : (spec.role || null),
        name: spec.name ? String(spec.name).trim() : null,
        zone: spec.zone || null, aisle: spec.aisle || null, rack: spec.rack || null,
        level: spec.level == null || spec.level === '' ? null : spec.level,
        bin: spec.bin || null, parent: spec.parent ? String(spec.parent).trim().toUpperCase() : null,
        category: spec.category || null, blocked: false, reservedBy: null, capacity: capacityOf(spec),
      };
      if (kindIn === 'bin' || kindIn === 'mezzanine' || kindIn === 'virtual') loc.pallets = [];
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

    proto.locationProfilesView = function () {
      const saved = this.locationProfiles || {};
      const ids = new Set([...Object.keys(PROFILE_PRESETS), ...Object.keys(saved)]);
      return [...ids].map((id) => {
        const profile = { ...(PROFILE_PRESETS[id] || {}), ...(saved[id] || {}), id };
        profile.builtin = Boolean(PROFILE_PRESETS[id]);
        profile.custom = Boolean(saved[id]) && !PROFILE_PRESETS[id];
        return profile;
      });
    };

    proto.saveLocationProfile = function (input = {}) {
      const id = String(input.id || input.name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32);
      if (!id) throw new Error('A profile needs a name');
      const storageType = String(input.storageType || (PROFILE_PRESETS[id] && PROFILE_PRESETS[id].storageType) || '').trim();
      const capacity = profileCapacity(storageType, input.capacity || input);
      const profile = {
        id, name: String(input.name || (PROFILE_PRESETS[id] && PROFILE_PRESETS[id].name) || id).trim(),
        storageType, temperature: String(input.temperature || 'ambient').trim(),
        security: String(input.security || 'standard').trim(),
        autoSort: String(input.autoSort || '').trim(),
        label: String(input.label || '').trim(),
        capacityMode: input.capacityMode === 'warn' ? 'warn' : 'refuse',
        capacity,
      };
      if (!profile.name) throw new Error('A profile needs a name');
      this.locationProfiles = this.locationProfiles || {};
      this.locationProfiles[id] = profile;
      const actor = this._actor || 'unknown';
      this.log(`Location profile ${id} saved by ${actor}`, { by: actor });
      return profile;
    };

    proto.bulkLocations = function ({ profileId, aisleFrom, aisleTo, bayFrom, bayTo, heightFrom, heightTo } = {}) {
      const key = String(profileId || '').trim().toLowerCase();
      const known = this.locationProfilesView().find((p) => p.id === key);
      if (!known) throw new Error(`Unknown location profile ${profileId}`);
      const profile = (this.locationProfiles && this.locationProfiles[key]) || known;
      const aisles = profileRange(aisleFrom, aisleTo, 'Aisle');
      const bays = profileRange(bayFrom, bayTo, 'Bay');
      const heights = profileRange(heightFrom, heightTo, 'Height');
      const positions = profile.storageType === 'rack' ? Math.max(1, Math.round(profile.capacity.positionsPerLevel || 1)) : 1;
      if (aisles.length * bays.length * heights.length * positions > 2000) throw new Error('That range would create more than 2000 locations');
      let created = 0;
      for (const aisle of aisles) for (const bay of bays) for (const height of heights) {
        for (let pos = 1; pos <= positions; pos++) {
          const code = profile.storageType === 'rack'
            ? `${aisle}-${bay}-${height}-${String(pos).padStart(2, '0')}`
            : profile.storageType === 'block' ? `BLK-${aisle}-${bay}-${height}` : `SH-${aisle}-${bay}-${height}`;
          if (this.locations[code]) continue;
          const kind = profile.storageType === 'rack' ? 'rack' : 'bin';
          const cap = profile.capacity || {};
          const loc = this.createLocation({
            code, kind, name: profile.name, aisle, bay, level: height,
            heightMm: cap.heightMm, widthMm: cap.widthMm, depthMm: cap.depthMm, maxWeightKg: cap.maxWeightKg,
          });
          loc.profileId = profile.id;
          loc.storageType = profile.storageType;
          if (kind === 'rack') loc.structural = false;
          loc.temperature = profile.temperature;
          loc.security = profile.security;
          loc.capacityMode = profile.capacityMode || 'refuse';
          loc.capacity = { ...(loc.capacity || {}), ...cap };
          if (kind === 'block') {
            loc.pallets = loc.pallets || [];
            loc.height = cap.stackHeight;
            loc.lane = code;
          }
          if (kind === 'bin' && !loc.pallets) loc.pallets = [];
          created += 1;
        }
      }
      const actor = this._actor || 'unknown';
      this.log(`Bulk locations from ${profile.id}: ${created} created by ${actor}`, { by: actor });
      return { created, profileId: profile.id };
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
      const from = holder.loc;
      holder.loc = code;
      if (from && from !== code) this.recordMovement({ holder: holder.id, sscc: holder.sscc || null, from, to: code, qty: holder.contents && holder.contents[0] ? holder.contents[0].qty : null, event: 'moved', by: this._actor || 'office' });
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
      if (holder.issued) throw new Error(`License plate ${holder.id} is issued and its number is never reused`);
      if ((holder.contents || []).length) throw new Error(`Holder ${holder.id} is not empty`);
      if (Object.values(this.holders).some((h) => h.parentId === holder.id)) throw new Error(`Holder ${holder.id} still has a carrier on it`);
      delete this.holders[holder.id];
      this.log(`Holder ${holder.id} removed`);
      return { removed: holder.id };
    };

    proto.formatPlate = function (series, n) {
      const spec = this._series(series);
      return `${spec.prefix}${String(n).padStart(spec.pad, '0')}`;
    };

    proto._series = function (series) {
      const key = String(series || '').trim().toUpperCase();
      const spec = this.holderSeries && this.holderSeries[key];
      if (!spec) throw new Error(`Holder series is one of ${SERIES.join(', ')}`);
      return spec;
    };

    /** Next license plate. The counter only ever increases, so a number is never reused. */
    proto.allocatePlate = function (series) {
      const key = String(series).trim().toUpperCase();
      const spec = this._series(key);
      const seq = spec.next;
      const id = `${spec.prefix}${String(seq).padStart(spec.pad, '0')}`;
      if (this.holders[id]) throw new Error(`License plate ${id} already exists`);
      spec.next = seq + 1;
      return { id, series: key, seq };
    };

    proto.setHolderSeries = function (patch) {
      for (const [series, spec] of Object.entries(patch || {})) {
        const current = this._series(series);
        if (spec.prefix != null) {
          const prefix = String(spec.prefix).trim().toUpperCase();
          if (!/^[A-Z][A-Z0-9]{0,11}$/.test(prefix)) throw new Error('A holder prefix is letters and digits, starting with a letter');
          current.prefix = prefix;
        }
        if (spec.pad != null) {
          const pad = Number(spec.pad);
          if (!Number.isInteger(pad) || pad < 1 || pad > 12) throw new Error('Holder padding is a whole number from 1 to 12');
          current.pad = pad;
        }
        if (spec.next != null) {
          const next = Number(spec.next);
          if (!Number.isInteger(next) || next < current.next) throw new Error(`${series} next number cannot go backwards (now ${current.next})`);
          current.next = next;
        }
      }
      this.log('Holder label series updated');
      return this.holderSeries;
    };

    proto._makePlate = function (minted, fields) {
      const holder = {
        id: minted.id, series: minted.series, seq: minted.seq, issued: true,
        type: fields.type || minted.series.toLowerCase(), loc: fields.loc || null,
        clientId: fields.clientId || null, parentId: fields.parentId || null, children: fields.children || [],
        sscc: fields.sscc || null, contents: fields.contents || [], history: [], createdAt: this.now(),
      };
      this.holders[holder.id] = holder;
      return holder;
    };

    /**
     * A received full pallet gets a PAL and a MASTER. The MASTER starts with that one PAL under it.
     */
    proto.issuePlates = function ({ sscc, by } = {}) {
      if (!this.feature('highValueSecurity')) throw new Error('High-value license plates are not enabled. Turn that on, or use an ST, INB or OUT plate.');
      const pallet = this._pallet(sscc);
      if (pallet.holderId) throw new Error(`Pallet …${sscc.slice(-6)} already has license plate ${pallet.holderId}`);
      const palMint = this.allocatePlate('PAL');
      const masterMint = this.allocatePlate('MASTER');
      const item = this.items[pallet.itemNo];
      const line = { sscc: pallet.sscc, itemNo: pallet.itemNo, batch: pallet.batch, expiry: pallet.expiry, qty: pallet.qty, clientId: pallet.clientId || (item && item.clientId) || null };
      const master = this._makePlate(masterMint, { type: 'master', loc: pallet.loc, clientId: line.clientId, children: [palMint.id], sscc: pallet.sscc, contents: [line] });
      const pal = this._makePlate(palMint, { type: 'pallet', loc: pallet.loc, clientId: line.clientId, parentId: master.id, sscc: pallet.sscc, contents: [line] });
      pallet.holderId = pal.id;
      pallet.masterId = master.id;
      const actor = by || this._actor || 'office';
      this.recordMovement({ holder: pal.id, sscc: pallet.sscc, from: null, to: pallet.loc, qty: pallet.qty, event: 'received', by: actor });
      this.recordMovement({ holder: pal.id, sscc: pallet.sscc, from: pallet.loc, to: pallet.loc, qty: pallet.qty, event: 'labelled', by: actor, note: master.id });
      this.recordMovement({ holder: master.id, sscc: pallet.sscc, from: pallet.loc, to: pallet.loc, qty: pallet.qty, event: 'labelled', by: actor, note: pal.id });
      const palLabel = this._printPlate(pal, { sscc: pallet.sscc, itemNo: line.itemNo, itemName: item && item.name, batch: pallet.batch, expiry: pallet.expiry, qty: pallet.qty, location: pallet.loc });
      const masterLabel = this._printPlate(master, { sscc: pallet.sscc, itemNo: line.itemNo, itemName: item && item.name, qty: pallet.qty, location: pallet.loc, children: [{ plate: pal.id, sscc: pallet.sscc, itemNo: line.itemNo, qty: pallet.qty }] });
      this.log(`Labelled …${pallet.sscc.slice(-6)} as ${pal.id} under ${master.id}`);
      return { pal, master, labels: [palLabel, masterLabel] };
    };

    /** INB, ST and OUT plates track lower-value stock without a full-pallet SSCC. */
    proto.issueSeries = function ({ series, itemNo, qty, loc = null, batch = null, expiry = null, by } = {}) {
      const key = String(series || '').toUpperCase();
      if (!['ST', 'INB', 'OUT'].includes(key)) throw new Error('This plate is ST, INB or OUT');
      const item = itemNo ? this.items[itemNo] : null;
      if (itemNo && !item) throw new Error(`Unknown item ${itemNo}`);
      const amount = Number(qty);
      if (!Number.isInteger(amount) || amount < 1) throw new Error('Quantity must be a whole number above 0');
      const code = loc ? this.resolve(loc) : null;
      if (code) this._loc(code);
      const minted = this.allocatePlate(key);
      const holder = this._makePlate(minted, {
        type: key.toLowerCase(), loc: code, clientId: item && item.clientId, 
        contents: [{ sscc: null, itemNo: item ? item.itemNo : null, batch, expiry, qty: amount, clientId: item && item.clientId }],
      });
      const actor = by || this._actor || 'office';
      this.recordMovement({ holder: holder.id, from: null, to: code, qty: amount, event: 'received', by: actor });
      this.recordMovement({ holder: holder.id, from: code, to: code, qty: amount, event: 'labelled', by: actor });
      const label = this._printPlate(holder, { itemNo: item && item.itemNo, itemName: item && item.name, batch, expiry, qty: amount, location: code });
      this.log(`${holder.id} issued for ${item ? item.itemNo : 'stock'} × ${amount}`);
      return { holder, label };
    };

    proto._printPlate = function (holder, extra) {
      const data = {
        kind: holder.series === 'MASTER' ? 'master' : 'pallet',
        plate: holder.id, series: holder.series, sscc: extra.sscc || holder.sscc || null,
        title: holder.id, itemNo: extra.itemNo || null, itemName: extra.itemName || holder.series,
        batch: extra.batch || '', expiry: extra.expiry || '', qty: extra.qty, location: extra.location || holder.loc,
        children: extra.children || (holder.children || []).map((id) => ({ plate: id })),
      };
      const zpl = Labels.licenseLabel(data);
      const record = { id: ++this._seq.label, kind: data.kind, plate: holder.id, sscc: data.sscc, at: this.now(), printer: 'SIM', data, zpl };
      this.labelLog = this.labelLog || [];
      this.labelLog.unshift(record);
      if (this.labelLog.length > 100) this.labelLog.length = 100;
      this.printQueue.unshift({ id: record.id, printer: 'SIM', at: record.at, label: data, zpl });
      if (this.printQueue.length > 50) this.printQueue.length = 50;
      return record;
    };

    /**
     * Put two or more PAL plates under one MASTER that already exists.
     * The earliest MASTER (lowest sequence number) survives unless `master` names
     * another MASTER that already parents one of these PAL plates. Every other
     * source MASTER is retired. Its number is not reused.
     */
    proto.consolidate = function ({ pals, at, master = null, by } = {}) {
      const code = this.resolve(at);
      const loc = this._loc(code);
      if (loc.kind !== 'virtual') throw new Error('Consolidate at a virtual location such as CONSO00');
      const ids = (pals || []).map((id) => String(id).trim().toUpperCase());
      if (ids.length < 2) throw new Error('Consolidation needs at least two PAL labels');
      const plates = ids.map((id) => this._holder(id));
      if (plates.some((h) => h.series !== 'PAL')) throw new Error('Only PAL labels are consolidated under a MASTER');
      const actor = by || this._actor || 'office';
      const parents = [];
      for (const pal of plates) {
        const current = pal.parentId && this.holders[pal.parentId];
        if (!current || current.series !== 'MASTER') throw new Error(`${pal.id} has no MASTER plate to reuse`);
        if (current.status === 'retired') throw new Error(`${current.id} is retired`);
        if (!parents.some((p) => p.id === current.id)) parents.push(current);
      }
      let parent;
      if (master) {
        parent = this._holder(String(master).trim().toUpperCase());
        if (parent.series !== 'MASTER') throw new Error('The parent label is a MASTER');
        if (parent.status === 'retired') throw new Error(`${parent.id} is retired`);
        if (!parents.some((p) => p.id === parent.id)) throw new Error('Choose a MASTER that already parents one of these PAL plates');
      } else {
        parent = parents.slice().sort((a, b) => a.seq - b.seq || a.createdAt - b.createdAt)[0];
      }
      for (const old of parents) {
        if (old.id === parent.id) continue;
        old.children = (old.children || []).filter((id) => !ids.includes(id));
        old.status = 'retired';
        old.retiredAt = this.now();
        old.retiredBy = actor;
        old.supersededBy = parent.id;
        this.recordMovement({ holder: old.id, from: old.loc, to: code, qty: null, event: 'retired', by: actor, note: `Closed. Stock continues under ${parent.id}` });
      }
      const parentFrom = parent.loc;
      parent.children = parent.children || [];
      for (const pal of plates) {
        const from = pal.loc;
        pal.parentId = parent.id;
        if (!parent.children.includes(pal.id)) parent.children.push(pal.id);
        pal.loc = code;
        const sscc = pal.sscc || (pal.contents[0] && pal.contents[0].sscc);
        const qty = pal.contents[0] ? pal.contents[0].qty : null;
        if (sscc && this.pallets[sscc] && this.pallets[sscc].loc !== code) {
          this.pallets[sscc].masterId = parent.id;
          const moved = this.transferPallet(sscc, code, { by: actor });
          if (!moved.ok) throw new Error(moved.text);
        } else if (sscc && this.pallets[sscc]) this.pallets[sscc].masterId = parent.id;
        this.recordMovement({ holder: pal.id, sscc: sscc || null, from, to: code, qty, event: 'consolidated', by: actor, note: parent.id });
      }
      parent.loc = code;
      this.recordMovement({ holder: parent.id, from: parentFrom, to: code, qty: plates.length, event: 'consolidated', by: actor, note: plates.map((p) => p.id).join(', ') });
      this.log(`Consolidated ${plates.map((p) => p.id).join(', ')} under ${parent.id} at ${code}`);
      return { master: parent, pals: plates, at: code };
    };

    proto.pickHolder = function ({ id, orderId = null, qty = null, by } = {}) {
      const holder = this._holder(id);
      const loc = holder.loc && this.locations[holder.loc];
      if (!loc || loc.kind !== 'mezzanine') throw new Error(`${holder.id} is not standing on a mezzanine location`);
      const line = (holder.contents || []).find((c) => Number(c.qty) > 0) || holder.contents[0];
      const available = line ? Number(line.qty) || 0 : 0;
      const take = qty == null || qty === '' ? available : Number(qty);
      if (!Number.isInteger(take) || take < 1) throw new Error('Pick quantity must be a whole number above 0');
      if (take > available) throw new Error(`${holder.id} has ${available}, not ${take}`);
      const actor = by || this._actor || 'operator';
      let note = null;
      if (orderId) {
        const order = this.orders[String(orderId)];
        if (!order) throw new Error(`No order ${orderId}`);
        if (order.status === 'shipped') throw new Error(`Order ${order.id} is shipped`);
        const itemNo = line && line.itemNo;
        const open = order.lines.find((l) => l.kind === 'each' && l.itemNo === itemNo && (l.picked || 0) < l.units);
        if (!open) throw new Error(`Order ${order.id} has no open line for ${itemNo}`);
        const need = open.units - (open.picked || 0);
        if (take > need) throw new Error(`Order ${order.id} only needs ${need} more of ${itemNo}`);
        open.picked = (open.picked || 0) + take;
        open.picks = open.picks || [];
        open.picks.push({ holder: holder.id, qty: take, from: holder.loc, t: this.now(), by: actor });
        order.staged = order.staged || [];
        order.staged.push({ itemNo, qty: take, holder: holder.id, batch: line.batch || null, expiry: line.expiry || null });
        note = order.id;
        const piece = order.lines.filter((l) => l.kind === 'each');
        const done = piece.every((l) => (l.picked || 0) >= l.units);
        if (!order.lines.some((l) => l.kind !== 'each' && l.pallets)) order.status = done ? 'ready' : 'picking';
        else if (order.status === 'open') order.status = 'picking';
      }
      if (line) line.qty = available - take;
      this.recordMovement({ holder: holder.id, sscc: holder.sscc || null, from: holder.loc, to: orderId ? `ORDER-${orderId}` : null, qty: take, event: 'picked', by: actor, note });
      this.log(`Mezzanine pick ${holder.id} × ${take}${orderId ? ` for ${orderId}` : ''} from ${holder.loc}`);
      if (typeof this.planReplenishment === 'function') this.planReplenishment();
      return holder;
    };

    proto.movementsFor = function ({ user = null, holder = null } = {}) {
      return (this.movements || []).filter((m) => (!user || m.by === user) && (!holder || m.holder === String(holder).toUpperCase() || m.sscc === holder)).slice(0, 500);
    };

    proto.setTechnical = function (patch) {
      this.technical = this.technical || { autoSort: {}, locationDefaults: {} };
      if (patch.autoSort) {
        const strategy = patch.autoSort.strategy || this.technical.autoSort.strategy || 'fefo';
        if (!['fefo', 'fifo', 'nearest'].includes(strategy)) throw new Error('Auto-sort strategy is fefo, fifo or nearest');
        const rules = patch.autoSort.rules == null ? this.technical.autoSort.rules : patch.autoSort.rules;
        if (!Array.isArray(rules)) throw new Error('Auto-sort rules are a list');
        this.technical.autoSort = {
          enabled: patch.autoSort.enabled == null ? this.technical.autoSort.enabled !== false : Boolean(patch.autoSort.enabled),
          strategy,
          sameBatchTogether: patch.autoSort.sameBatchTogether == null ? this.technical.autoSort.sameBatchTogether !== false : Boolean(patch.autoSort.sameBatchTogether),
          groundForNextOut: patch.autoSort.groundForNextOut == null ? this.technical.autoSort.groundForNextOut !== false : Boolean(patch.autoSort.groundForNextOut),
          rules,
        };
      }
      if (patch.locationDefaults) {
        this.technical.locationDefaults = { ...(this.technical.locationDefaults || {}), ...patch.locationDefaults };
      }
      if (patch.holderSeries) this.setHolderSeries(patch.holderSeries);
      this.log('Technical settings updated');
      return this.technical;
    };

    proto.addKit = function ({ id, name, base, components, output = null }) {
      if (!id || !name) throw new Error('A kit needs an id and a name');
      if (!base || !base.itemNo || !this.items[base.itemNo]) throw new Error('Kit base item is unknown');
      if (!Array.isArray(components) || !components.length) throw new Error('A kit needs components');
      for (const c of components) {
        if (!this.items[c.itemNo]) throw new Error(`Unknown component ${c.itemNo}`);
        if (!Number.isInteger(Number(c.qty)) || Number(c.qty) < 1) throw new Error('Component quantity must be a whole number above 0');
      }
      if (output && !this.items[output]) throw new Error(`Unknown kit output ${output}`);
      this.kits[id] = { id, name, base: { itemNo: base.itemNo, qty: Number(base.qty || 1) }, components: components.map((c) => ({ itemNo: c.itemNo, qty: Number(c.qty) })), output: output || null };
      this.log(`Kit ${id} ${name}`);
      return this.kits[id];
    };

    proto.addValStation = function ({ id, name, kitId }) {
      if (!this.kits[kitId]) throw new Error(`Unknown kit ${kitId}`);
      if (this.valStations.some((s) => s.id === id)) throw new Error(`VAL station ${id} already exists`);
      const station = { id, name: name || id, kitId };
      this.valStations.push(station);
      return station;
    };

    proto.startVal = function ({ stationId, workOrderId = null, by } = {}) {
      const station = this.valStations.find((s) => s.id === stationId);
      if (!station) throw new Error(`Unknown kitting station ${stationId}`);
      const kit = this.kits[station.kitId];
      const job = {
        id: (this.valJobs[0] ? this.valJobs[0].id : 0) + 1, stationId, kitId: kit.id, kitName: kit.name,
        need: [{ itemNo: kit.base.itemNo, qty: kit.base.qty, role: 'base' }, ...kit.components.map((c) => ({ itemNo: c.itemNo, qty: c.qty, role: 'component' }))],
        got: [], status: 'open', startedAt: this.now(), by: by || this._actor || 'operator', workOrderId: null, orderId: null,
      };
      if (workOrderId) {
        const wo = (this.workOrders || {})[String(workOrderId)];
        if (!wo) throw new Error(`Unknown work order ${workOrderId}`);
        if (wo.status !== 'open') throw new Error(`Work order ${wo.id} is ${wo.status}`);
        if (wo.kitId !== kit.id) throw new Error(`Station ${stationId} builds ${kit.id}, not ${wo.kitId}`);
        job.workOrderId = wo.id;
        job.orderId = wo.orderId || null;
      }
      this.valJobs.unshift(job);
      if (this.valJobs.length > 100) this.valJobs.length = 100;
      this.log(`Kitting ${kit.name} started at ${stationId}`);
      return job;
    };

    proto.scanVal = function ({ stationId, code, by } = {}) {
      const job = this.valJobs.find((j) => j.stationId === stationId && j.status === 'open');
      if (!job) throw new Error(`No open kitting job at ${stationId}`);
      const raw = String(code || '').trim();
      const holder = this.holders && this.holders[raw.toUpperCase()];
      const item = this.findItem(raw) || (holder && holder.contents[0] && this.items[holder.contents[0].itemNo]);
      if (!item) throw new Error(`${code} is not a component or a license plate`);
      const line = job.need.find((n) => job.got.filter((g) => g.itemNo === n.itemNo).length < n.qty);
      if (!line || line.itemNo !== item.itemNo) throw new Error(`${item.itemNo} is not the next scan for this kit`);
      const actor = by || this._actor || 'operator';
      if (holder) {
        const content = (holder.contents || []).find((c) => c.itemNo === item.itemNo && Number(c.qty) > 0);
        if (!content) throw new Error(`${holder.id} has no ${item.itemNo} left`);
        content.qty -= 1;
        this.recordMovement({ holder: holder.id, from: holder.loc, to: stationId, qty: 1, event: 'kitted', by: actor, note: `Kit ${job.kitId}` });
      } else if (job.workOrderId) throw new Error('Scan the component license plate so stock is consumed');
      job.got.push({ itemNo: item.itemNo, holder: holder ? holder.id : null, t: this.now(), role: line.role });
      const done = job.need.every((n) => job.got.filter((g) => g.itemNo === n.itemNo).length >= n.qty);
      if (done && job.workOrderId && typeof this._advanceWorkOrder === 'function') this._advanceWorkOrder(job, actor);
      else if (done) job.status = 'done';
      this.log(`${stationId}: scanned ${item.itemNo}${job.status === 'done' ? ', kit complete' : ''}`);
      return job;
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
      const lines = [
        d.plate ? ['License plate', d.plate] : null,
        d.sscc ? ['SSCC', `(00) ${d.sscc}`] : null,
        ['Item', `${d.itemNo || ''} ${d.itemName || d.title || ''}`],
        d.batch ? ['Batch', d.batch] : null,
        d.expiry ? ['Best before', d.expiry] : null,
        d.qty == null || d.qty === '' ? null : ['Qty', String(d.qty)],
        d.location ? ['Location', d.location] : null,
        d.orderId ? ['Order', d.orderId] : null,
      ].filter(Boolean);
      const html = Labels.labelHtml({ ...d, lines: lines.filter(([, v]) => v), barcodeSvg: d.plate ? barcodeSvg(d.plate, false) : barcodeSvg(`00${d.sscc}`, true) });
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

    proto.replenish = function (itemNo, toCode, opts = {}) {
      const item = this.items[itemNo];
      if (!item) throw new Error(`Unknown item ${itemNo}`);
      const dest = this._loc(this.resolve(toCode));
      const topUp = Boolean(opts.topUp);
      if (dest.structural) throw new Error(`${dest.code} cannot hold stock`);
      if (!topUp && dest.kind !== 'rack' && dest.kind !== 'bin') throw new Error('Replenish into a rack slot or a bin');
      if (topUp && !['rack', 'bin', 'mezzanine'].includes(dest.kind)) throw new Error('Replenish into a rack slot, a bin or a mezzanine');
      if (dest.kind === 'rack' && dest.sscc) throw new Error(`${dest.code} is not empty`);
      if (dest.kind === 'bin' && dest.pallets.length && (!topUp || dest.pallets.some((id) => this.pallets[id] && this.pallets[id].itemNo !== item.itemNo))) throw new Error(`${dest.code} is not empty`);
      if (dest.category && dest.category !== item.category) throw new Error(`${dest.code} is ${this.categories[dest.category] || dest.category}, not ${this.categories[item.category]}`);
      const source = this._fefo(itemNo).find((p) => p.loc !== dest.code);
      if (!source) throw new Error(`No free stock of ${itemNo} to replenish`);
      if (!this._fits(dest, source)) throw new Error(`Pallet …${source.sscc.slice(-6)} does not fit ${dest.code}`);
      const task = this._newTask({ type: 'SHIFT', reason: 'replenish', sscc: source.sscc, from: source.loc, to: dest.code, category: item.category });
      if (dest.kind === 'rack' || dest.kind === 'bin' || dest.kind === 'mezzanine') dest.reservedBy = task.id;
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

    function loadLocations() {
      if (typeof require === 'function') {
        try { return require('./locations'); } catch (e) { /* browser */ }
      }
      return globalThis.SortedLocations;
    }

    function loadPresets() {
      if (typeof require === 'function') {
        try { return require('./presets'); } catch (e) { /* browser */ }
      }
      return globalThis.SortedPresets;
    }

    function loadOperations() {
      if (typeof require === 'function') {
        try { return require('./operations'); } catch (e) { /* browser */ }
      }
      return globalThis.SortedOperations;
    }

    proto.applyPreset = function (id) {
      const { PRESETS } = loadPresets();
      const preset = PRESETS.find((p) => p.id === id);
      if (!preset) throw new Error('Unknown warehouse preset');
      this.features = { ...preset.features };
      for (const [code, name] of Object.entries(preset.categories || {})) if (!this.categories[code]) this.categories[code] = name;
      this.setup = {
        ...(this.setup || {}), preset: preset.id, features: { ...this.features },
        locationPlan: preset.locationPlan, virtualSuggested: preset.virtual || [],
        updatedAt: this.now(), updatedBy: this._actor || 'admin',
      };
      this.log(`Warehouse preset ${preset.name}`);
      return { id: preset.id, name: preset.name, summary: preset.summary, features: this.features, locationPlan: preset.locationPlan, virtual: preset.virtual || [], categories: preset.categories };
    };

    proto.setFeatures = function (patch) {
      const allowed = ['temperatureZones', 'lotExpiry', 'fefo', 'highValueSecurity'];
      this.features = { ...(this.features || {}) };
      for (const key of allowed) if (key in (patch || {})) this.features[key] = Boolean(patch[key]);
      if (this.features.fefo && !this.features.lotExpiry) throw new Error('FEFO needs lot and expiry to be on');
      this.setup = { ...(this.setup || {}), features: { ...this.features }, updatedAt: this.now(), updatedBy: this._actor || 'admin' };
      this.log('Category features updated');
      return this.features;
    };

    proto.generateLocations = function (plan, options = {}) {
      const { expand } = loadLocations();
      const built = expand(plan);
      const kind = options.kind || 'bin';
      const cap = options.capacity || {};
      let created = 0;
      const sample = [];
      for (const code of built.codes) {
        if (this.locations[code]) continue;
        this.createLocation({ code, kind, name: code, preserveCase: true, heightMm: cap.heightMm, widthMm: cap.widthMm, depthMm: cap.depthMm, maxWeightKg: cap.maxWeightKg });
        created++;
        if (sample.length < 8) sample.push(code);
      }
      this.setup = { ...(this.setup || {}), locationPlan: plan, generated: ((this.setup && this.setup.generated) || 0) + created, updatedAt: this.now(), updatedBy: this._actor || 'admin' };
      this.log(`Generated ${created} locations`);
      return { created, skipped: built.total - created, total: built.total, sample, sampleCode: built.sampleCode };
    };

    // The guided wizard: one plan per section, racks as pallet slots and
    // shelves as bins. Answers are kept so the wizard opens where it left off.
    proto.generateGuided = function (answers) {
      const { guided } = loadLocations();
      const built = guided(answers);
      let created = 0;
      const sample = [];
      for (const part of built.plans) {
        for (const code of expandCodes(part.plan)) {
          if (this.locations[code]) continue;
          const cap = part.capacity;
          const loc = this.createLocation({ code, kind: part.kind, name: code, preserveCase: true, heightMm: cap.heightMm, widthMm: cap.widthMm, depthMm: cap.depthMm, maxWeightKg: cap.maxWeightKg });
          loc.storageType = part.type;
          if (part.kind === 'rack') loc.structural = false;
          created++;
          if (sample.length < 8) sample.push(code);
        }
      }
      this._forgetPlaces();
      this.setup = { ...(this.setup || {}), guided: answers, generated: ((this.setup && this.setup.generated) || 0) + created, updatedAt: this.now(), updatedBy: this._actor || 'admin' };
      this.log(`Generated ${created} locations in ${built.plans.length} section${built.plans.length === 1 ? '' : 's'}`);
      return { created, skipped: built.total - created, total: built.total, sample, sampleCode: built.sampleCode, sections: built.plans.map((p) => ({ section: p.section, type: p.type, total: p.total })) };
    };

    function expandCodes(plan) {
      return loadLocations().expand(plan).codes;
    }

    proto.completeSetup = function () {
      this.setup = { ...(this.setup || {}), completed: true, updatedAt: this.now(), updatedBy: this._actor || 'admin' };
      this.log('Setup wizard saved');
      return this.setup;
    };

    const operations = loadOperations();
    if (operations && operations.install) operations.install(Warehouse, deps);

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
