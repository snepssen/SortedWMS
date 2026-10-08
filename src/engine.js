/*
 * SortedWMS engine.
 *
 * Stock: pallets identified by SSCC, each with item, batch, expiry and
 * quantity. Rack locations carry a product category from the location
 * template; categories never mix.
 *
 * Auto: reach trucks are handed their next job the moment they finish the
 * last one, in the order the coordinator sets, only within the categories the
 * operator works, and never more than `aisleCap` trucks in one aisle.
 *
 * Auto-Shift: rack-to-rack moves where the system picks the slot. Created
 * when the location template changes, to bring the next pallet out down to
 * ground level, to put the same batch side by side, or by a driver.
 *
 * Runs in the browser (window.SortedWMS) and Node (require('./engine')).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./gs1'), require('./labels'));
  else root.SortedWMS = factory(root.GS1, root.Labels);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (GS1, Labels) {
  'use strict';

  const CATEGORIES = { YOG: 'Yoghurt', CHE: 'Cheese', PRO: 'Protein drinks' };

  const TASK_TYPES = {
    PICK: { label: 'Pick for shipping', short: 'Pick' },
    MOVE: { label: 'Process move', short: 'Move' },
    CHECK: { label: 'Check & label', short: 'Check' },
    RECEIVE: { label: 'Receiving', short: 'Receive' },
    PUTAWAY: { label: 'Put-away', short: 'Put-away' },
    SHIFT: { label: 'Auto-Shift', short: 'Shift' },
  };

  const TRUCK_MODES = {
    auto: { label: 'Auto', types: null },
    shift: { label: 'Auto-Shift only', types: ['SHIFT'] },
    pick: { label: 'Pick (manual)', types: ['PICK', 'CHECK'], manual: true }, // one order, chosen by the operator
    putaway: { label: 'Put-away (manual)', types: [], manual: true }, // scan a pallet, get its slot
    transfer: { label: 'Transfer', types: [], manual: true }, // scan pallet, scan location: recorded as it is
    find: { label: 'Stock check', types: [], manual: true }, // scan a pallet, location or item to see what's where
    paused: { label: 'Paused', types: [] },
  };

  const SHIFT_REASONS = {
    template: 'Location template changed',
    ground: 'Ships next: to ground level',
    group: 'Same batch together',
    driver: 'Started by driver',
    digout: 'Uncover older stock',
  };

  // Receiving asks for these in this order. A GS1 label scan can fill several at once.
  const RECEIVE_FIELDS = ['batch', 'expiry', 'item', 'sscc', 'qty'];
  const FIELD_LABELS = { batch: 'Batch', expiry: 'Expiry date', item: 'Item number', sscc: 'Pallet SSCC', qty: 'Quantity' };

  const DEFAULT_CONFIG = {
    priority: ['PICK', 'MOVE', 'CHECK', 'RECEIVE', 'PUTAWAY', 'SHIFT'],
    enabled: { PICK: true, MOVE: true, CHECK: true, RECEIVE: true, PUTAWAY: true, SHIFT: true },
    aisleCap: 2,
    escalateAfterMin: 20, // a job waiting this long jumps the queue; 0 = never
    travelOptimise: true, // same priority: nearest job first
    allowSlotOverride: true, // Auto-Shift/put-away: driver may scan another suitable free slot
    groundNextPerItem: 1, // keep the next N pallets out of every item on ground level; 0 = off
    checkAfterPick: true, // picked pallets get a check & label job
    oneWay: false, // route trucks with the one-way signs in the aisles
    blockLaneCap: 1, // trucks in one block-stack lane at a time
    blockLaneBatches: 2, // batches of one item allowed to share a block lane
    // Older stock buried behind newer in a block lane:
    // 'digout' = move the newer pallets away when trucks are idle,
    // 'pickfirst' = picks take the newer pallets in front first, 'both', or 'off'.
    buriedStock: 'both',
  };

  // What the receiving desk operator calls out to the scanner, and what each fills.
  const DESK_CALLOUTS = [
    { word: 'BATCH', fields: ['batch'] },
    { word: 'PALLET', fields: ['sscc'] },
    { word: 'GS1', fields: ['item', 'expiry', 'qty'] },
  ];

  const AISLE_PITCH = 2; // travel cost of moving over one aisle, in bay depths
  const MINUTE = 60000;
  const DAY = 86400000;
  const LIVE = new Set(['open', 'active', 'held']);

  // ---- Locations ------------------------------------------------------------

  // aisle-bay-level-position, e.g. 38-02-0-10. Odd bays on one side of the
  // aisle, even bays on the other, so bays 01 and 02 face each other.
  // Level 0 is the ground. Positions 10/40/70 run left to right in a bay.
  const RACK_RE = /^(\d{2})-(\d{2})-(\d)-(\d{2})$/;

  function parseRack(code) {
    const m = RACK_RE.exec(code || '');
    return m ? { aisle: m[1], bay: Number(m[2]), level: Number(m[3]), pos: Number(m[4]) } : null;
  }

  const pad = (n, w) => String(n).padStart(w, '0');

  function rackCode(aisle, bay, level, pos) {
    return `${pad(aisle, 2)}-${pad(bay, 2)}-${level}-${pad(pos, 2)}`;
  }

  function aisleOf(code) {
    const r = parseRack(code);
    return r ? r.aisle : null;
  }

  /** How far into the aisle a bay is: bays 01 and 02 are both depth 1. */
  const depthOf = (bay) => Math.ceil(bay / 2);

  // ---- Dates ----------------------------------------------------------------

  const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
  const daysBetween = (fromIso, toIso) => Math.round((Date.parse(toIso) - Date.parse(fromIso)) / DAY);
  // 2026-10-21 → 21-10-2026, as dates are read on the floor.
  const dmy = (iso) => (iso ? `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}` : '');

  function validIso(y, m, d) {
    const iso = `${pad(y, 4)}-${pad(m, 2)}-${pad(d, 2)}`;
    const t = Date.parse(iso);
    return Number.isNaN(t) || isoDay(t) !== iso ? null : iso;
  }

  /** Expiry as a scanner or a person might send it. */
  function parseDate(raw) {
    const s = String(raw).trim();
    let m;
    if ((m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s))) return validIso(m[1], m[2], m[3]);
    if ((m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(s))) return validIso(m[3], m[2], m[1]);
    if ((m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2})$/.exec(s))) return validIso(2000 + Number(m[3]), m[2], m[1]);
    if (/^\d{6}$/.test(s)) return GS1.yymmdd(s);
    return null;
  }

  // ---- Warehouse ------------------------------------------------------------

  class Warehouse {
    /**
     * aisles: a count (01…n) or the real aisle numbers, e.g. [31, 32, …, 38].
     * bays: bays per aisle, both sides together. levels: including the ground.
     * positions: per bay level, left to right.
     */
    /*
     * blocks: floor block-stack lanes, e.g. [{ id: 'BL01', stacks: 8, height: 6, category: 'CHE' }].
     *   Stack 01 is at the front of the lane. A lane is filled from the back and emptied from the front.
     * stations: process stations, e.g. [{ id: 'PRESS', name: 'Pallet change', machine: 'Flip press',
     *   minutes: 5, sop: [...], capacity: 1 }] or a dwell room [{ id: 'WARM', name: 'Warm room', dwell: true, capacity: 40 }].
     */
    constructor({ aisles = 8, bays = 20, levels = 5, positions = [10, 40, 70], outLanes = 4, blocks = [], stations = [], categories = CATEGORIES, clock, config } = {}) {
      this.clock = clock || (() => Date.now());
      this.categories = { ...categories };
      this.config = {
        ...DEFAULT_CONFIG,
        ...config,
        enabled: { ...DEFAULT_CONFIG.enabled, ...(config && config.enabled) },
      };
      const aisleList = (Array.isArray(aisles) ? aisles : Array.from({ length: aisles }, (_, i) => i + 1)).map((a) => pad(a, 2));
      if (typeof positions === 'number') positions = Array.from({ length: positions }, (_, i) => 10 + i * 30);
      this.layout = { aisles: aisleList, bays, levels, positions, depth: depthOf(bays) };
      // One-way aisles: which end a truck drives in from. Alternates by default.
      this.aisleDir = {};
      // Location names. 'current' is what's on the racks today (38-02-0-10).
      // 'row' is the proposed scheme (AA03C2): cell letter + rack letter, bay
      // 01… front to back on every rack, level letter (A = ground), position
      // 1–3 left to right. Racks are lettered in a line across the cell: the
      // two racks facing each other across its first aisle are A and B, then
      // C/D… People say the short form "A3C2"; the cell is the one you're in.
      this.naming = { show: 'current', cellOf: {} };
      aisleList.forEach((a) => { this.naming.cellOf[a] = 'A'; });
      aisleList.forEach((a, i) => { this.aisleDir[a] = i % 2 === 0 ? 'front' : 'back'; });
      this.locations = {};
      this.items = {};
      this.pallets = {};
      this.trucks = {};
      this.tasks = {};
      this.orders = {};
      this.deliveries = {};
      this.printQueue = [];
      this.events = [];
      this.stations = {};
      this.routes = {};
      this.desks = {};
      this.processLog = [];
      this._seq = { task: 0, sscc: 0, label: 0 };
      this.ssccPrefix = '9990000'; // stand-in GS1 company prefix for SSCCs printed here

      this.locations['DOCK-IN'] = { code: 'DOCK-IN', kind: 'lane', role: 'in', aisle: null, pallets: [], blocked: false };
      for (let i = 1; i <= outLanes; i++) {
        const code = `OUT-${pad(i, 2)}`;
        this.locations[code] = { code, kind: 'lane', role: 'out', aisle: null, pallets: [], blocked: false, printer: `LP-${code}` };
      }
      for (const blk of blocks) {
        for (let st = 1; st <= blk.stacks; st++) {
          const code = `${blk.id}-${pad(st, 2)}`;
          this.locations[code] = {
            code, kind: 'block', aisle: blk.id, lane: blk.id, stack: st, stacks: blk.stacks, height: blk.height || 6,
            category: blk.category || null, pallets: [], blocked: false, reservedBy: null,
          };
        }
      }
      this.layout.blocks = blocks.map((b) => b.id);
      for (const st of stations) this.addStation(st);
      for (const a of aisleList) {
        for (let b = 1; b <= bays; b++) {
          for (let l = 0; l < levels; l++) {
            for (const p of positions) {
              const code = rackCode(a, b, l, p);
              this.locations[code] = {
                code, kind: 'rack', aisle: a, bay: b, level: l, pos: p, side: b % 2 ? 'odd' : 'even',
                category: null, sscc: null, blocked: false, reservedBy: null,
              };
            }
          }
        }
      }
    }

    now() { return this.clock(); }
    today() { return isoDay(this.now()); }

    log(text, extra = {}) {
      this.events.unshift({ t: this.now(), text, ...extra });
      if (this.events.length > 300) this.events.length = 300;
    }

    // ---- Routing --------------------------------------------------------------

    setAisleDirection(aisle, enterFrom) {
      const a = pad(aisle, 2);
      if (!(a in this.aisleDir)) throw new Error(`No aisle ${a}`);
      if (enterFrom !== 'front' && enterFrom !== 'back') throw new Error('Enter from "front" or "back"');
      this.aisleDir[a] = enterFrom;
      this.log(`Aisle ${a}: one-way, enter from the ${enterFrom}`);
    }

    // Lanes and docks are at the front, left of the first aisle. Block lanes
    // sit past the last aisle; stations at the front by the docks.
    _point(code) {
      const r = parseRack(code);
      if (r) return { i: this.layout.aisles.indexOf(r.aisle), d: depthOf(r.bay), aisle: r.aisle };
      const loc = this.locations[code];
      if (loc && loc.kind === 'block') return { i: this.layout.aisles.length + this.layout.blocks.indexOf(loc.lane) / 2, d: 0, aisle: null, deep: loc.stack };
      return { i: -1, d: 0, aisle: null };
    }

    /**
     * Driving distance in bay depths. With one-way aisles on, a truck only
     * drives an aisle in its signed direction: to reach a bay behind it, it
     * drives out the far end and comes round.
     */
    travel(fromCode, toCode) {
      const p = this._point(fromCode);
      const q = this._point(toCode);
      const D = this.layout.depth;
      const L = D + 1; // one aisle length, end to end
      const across = (x, y) => Math.abs(x - y) * AISLE_PITCH;
      // Into a block lane: drive in from its open front to the stack.
      if (p.deep || q.deep) {
        const out = (pt) => (pt.deep ? pt.deep : pt.aisle ? pt.d : 0);
        if (p.deep && q.deep && p.i === q.i) return Math.abs(p.deep - q.deep);
        return out(p) + across(p.i, q.i) + out(q);
      }

      if (!this.config.oneWay) {
        if (p.aisle && p.aisle === q.aisle) return Math.abs(p.d - q.d);
        const viaFront = p.d + q.d;
        const viaBack = (p.aisle ? L - p.d : L) + (q.aisle ? L - q.d : L);
        return Math.min(viaFront, viaBack) + across(p.i, q.i);
      }

      const dirP = p.aisle && this.aisleDir[p.aisle];
      const dirQ = q.aisle && this.aisleDir[q.aisle];
      if (p.aisle && p.aisle === q.aisle) {
        const ahead = dirP === 'front' ? q.d >= p.d : q.d <= p.d;
        if (ahead) return Math.abs(q.d - p.d);
      }
      // Out of the current aisle in its direction…
      const exitEnd = !p.aisle ? 'front' : dirP === 'front' ? 'back' : 'front';
      const exitCost = !p.aisle ? 0 : dirP === 'front' ? L - p.d : p.d;
      // …and into the target aisle from its entry end.
      const entryEnd = !q.aisle ? 'front' : dirQ;
      const entryCost = !q.aisle ? 0 : dirQ === 'front' ? q.d : L - q.d;
      let transfer;
      if (exitEnd === entryEnd) {
        transfer = across(p.i, q.i);
      } else {
        // Drive through an aisle signed the right way, or round the outside.
        const n = this.layout.aisles.length;
        const ways = [-1, n];
        this.layout.aisles.forEach((a, i) => {
          if ((exitEnd === 'front' && this.aisleDir[a] === 'front') || (exitEnd === 'back' && this.aisleDir[a] === 'back')) ways.push(i);
        });
        transfer = Math.min(...ways.map((z) => across(p.i, z) + L + across(z, q.i)));
      }
      return exitCost + transfer + entryCost;
    }

    /** Which end to drive into the target's aisle from, if the truck isn't already headed there. */
    entryFor(truck, code) {
      const a = aisleOf(code);
      if (!a || !this.config.oneWay) return null; // racks only; block lanes have one open end
      const p = this._point(truck.position);
      if (p.aisle === a) {
        const q = this._point(code);
        const ahead = this.aisleDir[a] === 'front' ? q.d >= p.d : q.d <= p.d;
        if (ahead) return null;
      }
      return this.aisleDir[a];
    }

    // ---- Location names -------------------------------------------------------

    /** Which name the screens show: 'current' (38-02-0-10) or 'row' (HB-01-01-A). */
    setNaming(show) {
      if (show !== 'current' && show !== 'row') throw new Error('Naming is "current" or "row"');
      this.naming.show = show;
    }

    /** Put an aisle in a warehouse cell (one letter). Its rack rows are lettered within that cell. */
    setAisleCell(aisle, cell) {
      const a = pad(aisle, 2);
      if (!(a in this.naming.cellOf)) throw new Error(`No aisle ${a}`);
      if (!/^[A-Z]$/.test(cell)) throw new Error('A cell is one letter, A–Z');
      this.naming.cellOf[a] = cell;
    }

    /** The two rack-row names of an aisle: [odd side, even side], e.g. ['AA', 'AB']. */
    rowsOf(aisle) {
      const a = pad(aisle, 2);
      const cell = this.naming.cellOf[a];
      const i = this.layout.aisles.filter((x) => this.naming.cellOf[x] === cell).indexOf(a);
      return [cell + String.fromCharCode(65 + i * 2), cell + String.fromCharCode(66 + i * 2)];
    }

    _rowParts(code) {
      const r = parseRack(code);
      if (!r) return null;
      const [odd, even] = this.rowsOf(r.aisle);
      const rack = r.bay % 2 ? odd : even;
      return { cell: rack[0], rack: rack[1], bay: depthOf(r.bay), level: String.fromCharCode(65 + r.level), pos: this.layout.positions.indexOf(r.pos) + 1 };
    }

    /** A rack code in the proposed scheme, e.g. 31-05-2-40 → AA03C2. */
    rowName(code) {
      const p = this._rowParts(code);
      return p ? `${p.cell}${p.rack}${pad(p.bay, 2)}${p.level}${p.pos}` : code;
    }

    /** How people say it on the floor: "A3C2" in cell A. */
    spoken(code) {
      const p = this._rowParts(code);
      return p ? { short: `${p.rack}${p.bay}${p.level}${p.pos}`, cell: p.cell } : null;
    }

    /** Display name in the chosen scheme. Lanes and docks keep their names. */
    label(code) {
      return this.naming.show === 'row' ? this.rowName(code) : code;
    }

    /** Any text from the engine with rack codes shown in the chosen scheme. */
    display(text) {
      if (this.naming.show !== 'row' || !text) return text;
      return String(text).replace(/\b\d{2}-\d{2}-\d-\d{2}\b/g, (c) => (this.locations[c] ? this.rowName(c) : c));
    }

    /**
     * A scanned or typed location in either scheme → the location it means.
     * Both barcodes work, so racks can be relabelled one aisle at a time.
     * The spoken short form ("A3C2") works when the cell is known, e.g. the
     * cell the truck is in.
     */
    resolve(input, { cell = null } = {}) {
      const raw = String(input).trim().toUpperCase();
      if (this.locations[raw]) return raw;
      const s = raw.replace(/[\s-]/g, ''); // "AA-03-C-2" and "AA 03 C 2" read as AA03C2
      let m = /^([A-Z])([A-Z])(\d{2})([A-Z])(\d)$/.exec(s);
      if (!m && cell) {
        const short = /^([A-Z])(\d{1,2})([A-Z])(\d)$/.exec(s);
        if (short) m = [s, cell, short[1], short[2], short[3], short[4]];
      }
      if (!m) return raw;
      const rack = m[1] + m[2];
      const aisle = this.layout.aisles.find((a) => this.rowsOf(a).includes(rack));
      const pos = this.layout.positions[Number(m[5]) - 1];
      const depth = Number(m[3]);
      if (!aisle || pos == null || depth < 1) return raw;
      const bay = this.rowsOf(aisle)[0] === rack ? depth * 2 - 1 : depth * 2;
      const code = rackCode(aisle, bay, m[4].charCodeAt(0) - 65, pos);
      return this.locations[code] ? code : raw;
    }

    /** The cell a location is in (proposed scheme), or null for lanes. */
    cellOfLocation(code) {
      const a = aisleOf(code);
      return a ? this.naming.cellOf[a] : null;
    }

    /** Old → new name for every location, for relabelling the racks. */
    relabelList(aisle = null) {
      return this._racks()
        .filter((l) => !aisle || l.aisle === pad(aisle, 2))
        .map((l) => ({ current: l.code, row: this.rowName(l.code) }))
        .sort((x, y) => (x.row < y.row ? -1 : 1));
    }

    // ---- Master data --------------------------------------------------------

    /** storage: 'rack' (default) or 'block' for crate pallets stacked on the floor. */
    addItem({ itemNo, gtin, name, category, palletQty, minShipDays = 0, storage = 'rack' }) {
      if (!this.categories[category]) throw new Error(`Unknown category ${category}`);
      if (this.items[itemNo]) throw new Error(`Item ${itemNo} already exists`);
      if (gtin && !GS1.isValidGtin(gtin)) throw new Error(`GTIN ${gtin} has a wrong check digit`);
      this.items[itemNo] = { itemNo, gtin: gtin ? GS1.gtin14(gtin) : null, name, category, palletQty, minShipDays, storage };
      return this.items[itemNo];
    }

    /** Manager setting: days of shelf life a pallet must have left to be shipped. */
    setMinShipDays(itemNo, days) {
      const item = this.items[itemNo];
      if (!item) throw new Error(`Unknown item ${itemNo}`);
      if (!Number.isInteger(days) || days < 0) throw new Error('Days must be a whole number, 0 or more');
      if (item.minShipDays === days) return;
      item.minShipDays = days;
      this.log(`${itemNo}: minimum ${days} days left to ship`);
      this._dropShortAllocations(itemNo);
      this.planGround();
      this.dispatch();
    }

    /**
     * Can this pallet ship today? 'ok', 'short' (fewer days left than the
     * manager's minimum), 'expired' or 'blocked' (damaged, held back).
     */
    shipState(pallet) {
      if (pallet.status === 'blocked') return 'blocked';
      const days = daysBetween(this.today(), pallet.expiry);
      if (days < 0) return 'expired';
      if (days < this.items[pallet.itemNo].minShipDays && !pallet.allowShort) return 'short';
      return 'ok';
    }

    daysLeft(pallet) {
      return daysBetween(this.today(), pallet.expiry);
    }

    /** Manager override: let this one short-dated pallet ship (e.g. a customer accepts it). */
    allowShortShip(sscc) {
      const p = this._pallet(sscc);
      p.allowShort = true;
      this.log(`Pallet …${sscc.slice(-6)} released to ship with ${this.daysLeft(p)} days left`);
      this.planGround();
      this.dispatch();
    }

    // Raising the minimum can make allocated pallets too short: swap them for good ones.
    _dropShortAllocations(itemNo) {
      for (const t of Object.values(this.tasks)) {
        if (t.type !== 'PICK' || t.status !== 'open') continue;
        const p = this.pallets[t.sscc];
        if (p.itemNo !== itemNo || this.shipState(p) === 'ok') continue;
        this._replacePick(t);
        t.status = 'cancelled';
      }
    }

    /** Find an item by item number or by any length of GTIN/EAN. */
    findItem(raw) {
      const s = String(raw).trim().toUpperCase();
      if (this.items[s]) return this.items[s];
      if (/^\d{8,14}$/.test(s)) {
        const g = GS1.gtin14(s);
        return Object.values(this.items).find((i) => i.gtin === g) || null;
      }
      return null;
    }

    /**
     * Location template: give a range of rack locations a category.
     * Range by today's bay numbers (bayFrom/bayTo), or by one side of the
     * aisle ('odd'/'even') and bays along that row (rowFrom/rowTo).
     */
    setLocationCategory({ aisle, bayFrom = 1, bayTo = this.layout.bays, side = null, rowFrom = null, rowTo = null, levels = null }, category) {
      if (category !== null && !this.categories[category]) throw new Error(`Unknown category ${category}`);
      const a = pad(aisle, 2);
      let changed = 0;
      for (const loc of this._racks()) {
        if (loc.aisle !== a) continue;
        if (rowFrom != null || side) {
          if (side && loc.side !== side) continue;
          const d = depthOf(loc.bay);
          if (d < (rowFrom || 1) || d > (rowTo || this.layout.depth)) continue;
        } else if (loc.bay < bayFrom || loc.bay > bayTo) continue;
        if (levels && !levels.includes(loc.level)) continue;
        if (loc.category !== category) {
          loc.category = category;
          changed++;
        }
      }
      if (changed) {
        const where = rowFrom != null || side ? `${side ? `${side} side` : 'both sides'}, bays ${rowFrom || 1}–${rowTo || this.layout.depth} along the row` : `bays ${bayFrom}–${bayTo}`;
        this.log(`Template: aisle ${a} ${where} → ${category ? this.categories[category] : 'no category'} (${changed} locations)`);
      }
      const moves = this.planRelocations();
      this.dispatch();
      return { changed, moves };
    }

    // ---- Stock --------------------------------------------------------------

    nextSscc() {
      return GS1.makeSscc(0, this.ssccPrefix, ++this._seq.sscc);
    }

    /** Put existing stock straight into a location (opening balance, imports). */
    stockPallet(code, { sscc, itemNo, batch, expiry, qty, receivedAt, status = 'available', blockReason = null }) {
      const loc = this._loc(code);
      const item = this.items[itemNo];
      if (!item) throw new Error(`Unknown item ${itemNo}`);
      sscc = sscc || this.nextSscc();
      if (!GS1.isValidSscc(sscc)) throw new Error(`SSCC ${sscc} has a wrong check digit`);
      if (this.pallets[sscc]) throw new Error(`SSCC ${sscc} is already in stock`);
      if (loc.kind === 'rack' && loc.sscc) throw new Error(`${code} already holds a pallet`);
      if (loc.kind === 'block' && loc.pallets.length >= loc.height) throw new Error(`${code} is stacked full`);
      const pallet = {
        sscc, itemNo, batch, expiry, qty: qty || item.palletQty,
        receivedAt: receivedAt == null ? this.now() : receivedAt,
        status, blockReason, loc: null, orderId: null, labelCode: null, checked: false,
      };
      this.pallets[sscc] = pallet;
      this._place(pallet, code);
      return pallet;
    }

    setPalletStatus(sscc, status, reason = null) {
      const pallet = this._pallet(sscc);
      if (!['available', 'blocked'].includes(status)) throw new Error(`Unknown status ${status}`);
      pallet.status = status;
      pallet.blockReason = status === 'blocked' ? reason || 'Blocked' : null;
      this.log(`Pallet …${sscc.slice(-6)} ${status === 'blocked' ? `blocked: ${pallet.blockReason}` : 'released for use'}`);
      this.planGround();
      this.dispatch();
    }

    palletAt(code) {
      const loc = this.locations[code];
      return loc && loc.kind === 'rack' && loc.sscc ? this.pallets[loc.sscc] : null;
    }

    /** Stock per item: what can ship, what's blocked, what ships next. */
    stockSummary() {
      const rows = {};
      for (const item of Object.values(this.items)) {
        rows[item.itemNo] = { item, available: 0, short: 0, blocked: 0, qty: 0, next: null, batches: new Set() };
      }
      for (const p of Object.values(this.pallets)) {
        if (!p.loc || p.status === 'shipped' || p.status === 'missing') continue;
        const r = rows[p.itemNo];
        const state = this.shipState(p);
        if (state === 'blocked') { r.blocked++; continue; }
        if (state !== 'ok') { r.short++; continue; }
        if (p.orderId) continue;
        r.available++;
        r.qty += p.qty;
        r.batches.add(p.batch);
      }
      for (const r of Object.values(rows)) {
        const next = this._fefo(r.item.itemNo)[0];
        r.next = next || null;
        r.batches = r.batches.size;
      }
      return Object.values(rows);
    }

    // ---- Trucks -------------------------------------------------------------

    addTruck(id, { mode = 'auto', categories = null, position = 'DOCK-IN' } = {}) {
      if (this.trucks[id]) throw new Error(`Truck ${id} already exists`);
      this.trucks[id] = {
        id, mode, categories, position,
        taskId: null, load: null, waiting: false, waitingSince: null,
        idleSince: this.now(), message: null,
        stats: { jobs: 0, scans: 0, wrongScans: 0, taps: 0, moves: 0, moveInputs: 0, received: 0, receiveInputs: 0 },
      };
      this.dispatch();
      return this.trucks[id];
    }

    setTruckCategories(truckId, categories) {
      const truck = this._truck(truckId);
      truck.categories = categories && categories.length ? [...categories] : null;
      const task = truck.taskId && this.tasks[truck.taskId];
      if (task && task.step === 0 && !this._truckTakes(truck, task) && task.type !== 'RECEIVE') this._unassign(task);
      this.log(`${truck.id} works ${truck.categories ? truck.categories.map((c) => this.categories[c]).join(' + ') : 'every category'}`);
      this.dispatch();
    }

    setTruckMode(truckId, mode, { orderId = null } = {}) {
      if (!TRUCK_MODES[mode]) throw new Error(`Unknown mode ${mode}`);
      const truck = this._truck(truckId);
      if (orderId && !this.orders[orderId]) throw new Error(`No order ${orderId}`);
      truck.transferSscc = null;
      truck.pendingSscc = null;
      if (mode === 'pick') truck.orderId = orderId;
      if (truck.mode === mode) { this.dispatch(); return; }
      const task = truck.taskId && this.tasks[truck.taskId];
      if (task) {
        if (truck.load) throw new Error(`${truck.id} is carrying a pallet — drop it before changing mode`);
        const allowed = TRUCK_MODES[mode].types;
        if ((allowed && !allowed.includes(task.type)) || (mode === 'pick' && task.orderId !== orderId)) {
          if (task.type === 'RECEIVE') this._parkReceive(task);
          else this._unassign(task);
        }
      }
      truck.mode = mode;
      truck.idleSince = this.now();
      this.log(`${truck.id} set to ${TRUCK_MODES[mode].label}`, { truckId });
      this.dispatch();
    }

    // ---- Admin --------------------------------------------------------------

    setConfig(patch) {
      if (patch.priority) {
        const want = Object.keys(TASK_TYPES).sort().join();
        if ([...patch.priority].sort().join() !== want) throw new Error('Priority must list every job type exactly once');
      }
      if (patch.aisleCap !== undefined && !(Number.isInteger(patch.aisleCap) && patch.aisleCap >= 1)) {
        throw new Error('Trucks per aisle must be a whole number of 1 or more');
      }
      this.config = { ...this.config, ...patch, enabled: { ...this.config.enabled, ...(patch.enabled || {}) } };
      if (patch.groundNextPerItem !== undefined) this.planGround();
      if (patch.buriedStock !== undefined) {
        if (!['digout', 'pickfirst', 'both', 'off'].includes(patch.buriedStock)) throw new Error('Buried stock: digout, pickfirst, both or off');
        if (!['digout', 'both'].includes(patch.buriedStock)) {
          for (const t of Object.values(this.tasks)) if (t.reason === 'digout' && t.status === 'open') this._cancelQuiet(t);
        }
        this.planDigOut();
      }
      this.dispatch();
    }

    setUrgent(taskId, urgent) {
      const task = this._task(taskId);
      task.urgent = Boolean(urgent);
      this.log(`Job #${task.id} ${urgent ? 'marked urgent' : 'no longer urgent'}`, { taskId });
      this.dispatch();
    }

    cancelTask(taskId) {
      const task = this._task(taskId);
      if (!LIVE.has(task.status)) return;
      const truck = task.truckId && this.trucks[task.truckId];
      if (truck && truck.load) throw new Error(`Job #${task.id}: pallet is on the forks — let the driver drop it first`);
      if (task.status === 'active') this._unassign(task);
      this._releaseSlot(task);
      if (task.type === 'PICK' && task.status !== 'held') this._unallocate(task.sscc);
      if (task.type === 'RECEIVE') this.deliveries[task.deliveryId].status = 'cancelled';
      task.status = 'cancelled';
      this.log(`Job #${task.id} cancelled`, { taskId });
      this.dispatch();
    }

    /** Put a held job back in the queue, or close it if it was already replaced. */
    releaseTask(taskId) {
      const task = this._task(taskId);
      if (task.status !== 'held') return;
      if (task.blockedLoc) this.locations[task.blockedLoc].blocked = false;
      if (task.replacedBy) {
        task.status = 'cancelled';
        this.log(`Job #${task.id} closed (replaced by #${task.replacedBy})`, { taskId });
      } else {
        task.status = 'open';
        task.heldReason = null;
        this.log(`Job #${task.id} released back to the queue`, { taskId });
      }
      task.blockedLoc = null;
      this.dispatch();
    }

    unblockLocation(code) {
      const loc = this._loc(code);
      if (!loc.blocked) return;
      loc.blocked = false;
      this.log(`${code} unblocked`);
      this.dispatch();
    }

    blockedLocations() {
      return Object.values(this.locations).filter((l) => l.blocked);
    }

    // ---- Orders (FEFO) ------------------------------------------------------

    /**
     * A shipping order. Each line takes whole pallets, first expiry first
     * (FEFO), oldest received first on a tie (FIFO). Blocked and expired
     * stock is never picked.
     */
    addOrder({ id, customer, lane, lines }) {
      if (this.orders[id]) throw new Error(`Order ${id} already exists`);
      const laneLoc = this._loc(lane);
      if (laneLoc.kind !== 'lane' || laneLoc.role !== 'out') throw new Error(`${lane} is not a shipping lane`);
      const order = { id, customer, lane, lines: [], createdAt: this.now(), status: 'open', labels: 0 };
      this.orders[id] = order;
      for (const line of lines) {
        const item = this.items[line.itemNo];
        if (!item) throw new Error(`Unknown item ${line.itemNo}`);
        if (line.process && !this.routes[line.process]) throw new Error(`Unknown process ${line.process}`);
        const l = { itemNo: line.itemNo, pallets: line.pallets, process: line.process || null, allocated: [], short: 0 };
        order.lines.push(l);
        for (let i = 0; i < line.pallets; i++) {
          const pallet = this._allocate(line.itemNo);
          if (!pallet) { l.short++; continue; }
          this._createPick(order, l, pallet);
        }
        if (l.short) this.log(`Order ${id}: ${l.short} pallet(s) of ${item.itemNo} short — not enough usable stock`);
      }
      this.log(`Order ${id} for ${customer}: ${order.lines.reduce((s, l) => s + l.allocated.length, 0)} pallets to ${lane}`);
      this.planGround();
      this.dispatch();
      return order;
    }

    /** Truck loaded: the order's checked pallets leave the building. */
    shipOrder(id) {
      const order = this.orders[id];
      if (!order) throw new Error(`No order ${id}`);
      if (order.status !== 'ready') throw new Error(`Order ${id} is not ready to load`);
      const shipped = [];
      for (const sscc of order.lines.flatMap((l) => l.allocated)) {
        const p = this.pallets[sscc];
        this._remove(p);
        p.status = 'shipped';
        shipped.push({ sscc, itemNo: p.itemNo, batch: p.batch, expiry: p.expiry, qty: p.qty });
      }
      order.status = 'shipped';
      order.shippedAt = this.now();
      (this.shipments = this.shipments || []).push({ orderId: id, customer: order.customer, t: this.now(), pallets: shipped });
      this.log(`Order ${id} loaded and shipped`);
    }

    // ---- Receiving ----------------------------------------------------------

    /**
     * Announce a delivery at the receiving dock; creates one receiving job.
     * `list` is the supplier's pallet list (SSCC, item, batch, expiry, qty),
     * when there is one: then scanning the SSCC alone registers the pallet.
     */
    addDelivery({ id, supplier, category, pallets, list = null, at = 'dock' }) {
      if (this.deliveries[id]) throw new Error(`Delivery ${id} already exists`);
      if (!this.categories[category]) throw new Error(`Unknown category ${category}`);
      const byS = list ? Object.fromEntries(list.map((l) => [l.sscc, l])) : null;
      const delivery = { id, supplier, category, expected: pallets || (list ? list.length : 0), received: [], list: byS, createdAt: this.now(), status: 'open' };
      this.deliveries[id] = delivery;
      const task = this._newTask({ type: 'RECEIVE', category, from: 'DOCK-IN', to: 'DOCK-IN', deliveryId: id });
      task.draft = {};
      task.deskOnly = at === 'desk'; // received at the desk by two operators, not on a truck handheld
      delivery.at = at;
      this.log(`Delivery ${id} from ${supplier}: ${pallets} pallets of ${this.categories[category]}`, { taskId: task.id });
      this.dispatch();
      return delivery;
    }

    /** Quantity confirm on the handheld: the only tap in receiving, skipped when the label carries a count. */
    confirmQty(truckId, qty) {
      const truck = this._truck(truckId);
      const task = truck.taskId && this.tasks[truck.taskId];
      if (!task || task.type !== 'RECEIVE') throw new Error(`${truck.id} is not receiving`);
      truck.stats.taps++;
      const d = task.draft;
      d.inputs = (d.inputs || 0) + 1;
      const missing = RECEIVE_FIELDS.filter((f) => f !== 'qty' && !d[f]);
      if (missing.length) return this._say(truck, false, `Scan the ${FIELD_LABELS[missing[0]].toLowerCase()} first`);
      const n = qty == null ? this.items[d.item].palletQty : Number(qty);
      if (!Number.isInteger(n) || n < 1) return this._say(truck, false, 'Quantity must be a whole number above 0');
      d.qty = n;
      return this._registerReceived(truck, task);
    }

    /** Driver ends a delivery early (fewer pallets than announced). */
    finishReceiving(truckId) {
      const truck = this._truck(truckId);
      const task = truck.taskId && this.tasks[truck.taskId];
      if (!task || task.type !== 'RECEIVE') throw new Error(`${truck.id} is not receiving`);
      truck.stats.taps++;
      this._closeDelivery(truck, task);
      return truck.message;
    }

    // ---- Auto-Shift planners -------------------------------------------------

    /** Pallets standing in a location of another category → move to their own. */
    planRelocations() {
      let n = 0;
      for (const loc of this._racks()) {
        if (!loc.sscc || !loc.category) continue;
        const pallet = this.pallets[loc.sscc];
        if (this.items[pallet.itemNo].category === loc.category) continue;
        if (this._liveTaskFor(pallet.sscc)) continue;
        this._newTask({ type: 'SHIFT', reason: 'template', sscc: pallet.sscc, from: loc.code, to: null, category: this.items[pallet.itemNo].category });
        n++;
      }
      if (n) this.log(`${n} pallet(s) are in the wrong category after the template change — relocation jobs created`);
      return n;
    }

    /**
     * Keep the next pallet(s) to ship of every item on ground level, so a pick
     * never waits on a high reach.
     */
    planGround() {
      const want = this.config.groundNextPerItem;
      if (!want) return 0;
      let n = 0;
      for (const itemNo of Object.keys(this.items)) {
        if (this.items[itemNo].storage === 'block') continue; // block stacks have no levels
        const next = this._fefo(itemNo).slice(0, want);
        for (const pallet of next) {
          const loc = this.locations[pallet.loc];
          if (loc.level === 0 || this._liveTaskFor(pallet.sscc)) continue;
          if (!this._findSlot(pallet, loc.code, { ground: true })) continue;
          this._newTask({ type: 'SHIFT', reason: 'ground', sscc: pallet.sscc, from: loc.code, to: null, ground: true, category: this.items[pallet.itemNo].category });
          n++;
        }
      }
      if (n) this.log(`${n} next-out pallet(s) are up high — bring-down jobs created`);
      return n;
    }

    /**
     * Same item, batch and expiry should stand side by side in one bay.
     * Moves pallets that stand alone next to the rest of their batch.
     */
    planGrouping(limit = 20) {
      const groups = {};
      for (const loc of this._racks()) {
        if (!loc.sscc) continue;
        const p = this.pallets[loc.sscc];
        if (this._liveTaskFor(p.sscc)) continue;
        (groups[this._batchKey(p)] = groups[this._batchKey(p)] || []).push(loc);
      }
      let n = 0;
      const settled = new Set();
      const movedAway = new Set();
      for (const locs of Object.values(groups)) {
        if (locs.length < 2) continue;
        // Bay levels this batch already uses, most pallets first.
        const byBay = {};
        for (const l of locs) (byBay[this._bayLevelKey(l)] = byBay[this._bayLevelKey(l)] || []).push(l);
        const homes = Object.values(byBay).sort((x, y) => y.length - x.length);
        for (const lonely of homes.filter((h) => h.length === 1).map((h) => h[0])) {
          if (n >= limit) break;
          if (settled.has(lonely.code)) continue;
          const pallet = this.pallets[lonely.sscc];
          let target = null;
          let home = null;
          for (const h of homes) {
            if (h[0] === lonely || h.every((l) => movedAway.has(l.code))) continue;
            target = this._bayLevel(h[0]).find((c) => this._slotFree(c, pallet));
            if (target) { home = h; break; }
          }
          if (!target) continue;
          const task = this._newTask({ type: 'SHIFT', reason: 'group', sscc: pallet.sscc, from: lonely.code, to: target.code, category: this.items[pallet.itemNo].category });
          target.reservedBy = task.id;
          movedAway.add(lonely.code);
          home.forEach((l) => settled.add(l.code));
          n++;
        }
      }
      if (n) this.log(`${n} pallet(s) can join the rest of their batch — grouping jobs created`);
      this.dispatch();
      return n;
    }

    // ---- Driver -------------------------------------------------------------

    /**
     * The driver's input. Returns { ok, text }. A wrong scan changes nothing;
     * the next correct scan simply works.
     */
    scan(truckId, raw) {
      const truck = this._truck(truckId);
      const input = String(raw).trim();
      truck.stats.scans++;
      if (!input) return this._fail(truck, 'Nothing scanned');
      if (truck.mode === 'paused') return this._fail(truck, 'Truck is paused — resume to take jobs');

      const task = truck.taskId && this.tasks[truck.taskId];
      if (!task && TRUCK_MODES[truck.mode].manual) return this._manualScan(truck, input);
      if (truck.pendingSscc) {
        const r = this._pendingScan(truck, input, task);
        if (r) return r;
      }
      if (!task) return this._startFromScan(truck, input);
      if (task.type === 'RECEIVE') task.draft.inputs = (task.draft.inputs || 0) + 1;
      else task.inputs++;
      if (task.type === 'RECEIVE') return this._receiveScan(truck, task, input);
      if (task.type === 'CHECK') return this._checkScan(truck, task, input);

      const label = GS1.parse(input);
      const code = (label && label.sscc) || this.resolve(input, { cell: this.cellOfLocation(truck.position) });
      if (task.step === 0) {
        const r = this._matchPickup(truck, task, code);
        if (!r.ok) {
          // A pallet the handheld wasn't asking for: pick it, relocate it, or hold it for a location scan.
          const other = this.pallets[code];
          const sameBatch = other && task.type === 'PICK' && this._batchKey(other) === this._batchKey(this.pallets[task.sscc]);
          if (other && !sameBatch) return this._unexpectedPallet(truck, other, task, 'pallet');
          const info = !this.locations[code] && this.lookup(input);
          if (info) return this._say(truck, true, info.text);
          return this._fail(truck, r.text);
        }
        this._pickUp(truck, task);
        if (truck.waiting) return this._say(truck, true, `${r.text}Aisle ${this._aisle(task.to)} is full — wait at the entry`);
        return this._say(truck, true, `${r.text}Take it to ${task.to}`);
      }

      // Carrying: a pallet or item scan only asks; a location scan is the drop.
      if (this.pallets[code]) {
        if (code === task.sscc) return this._say(truck, true, `You're carrying it: take it to ${task.to}`);
        return this._say(truck, true, `${this.lookup(code).text}\nYou're carrying …${task.sscc.slice(-6)} to ${task.to}`);
      }
      if (!this.locations[code]) {
        const info = this.lookup(input);
        if (info) return this._say(truck, true, info.text);
      }
      if (truck.waiting) {
        const cap = this.config.aisleCap;
        return this._fail(truck, `Aisle ${this._aisle(task.to)} is full (${cap}/${cap}) — wait at the entry`);
      }
      if (code !== task.to) {
        const why = this._overrideProblem(truck, task, code);
        if (why) return this._fail(truck, why);
        this._moveSlot(task, code);
        this.log(`${truck.id} chose ${code} instead of the suggested slot for job #${task.id}`, { truckId, taskId: task.id });
      }
      this._drop(truck, task);
      const next = truck.taskId ? this.tasks[truck.taskId] : null;
      return this._say(truck, true, next ? `Done. Next: ${TASK_TYPES[next.type].short} at ${next.from}` : 'Done. No jobs waiting');
    }

    reportProblem(truckId, reason) {
      const reasons = { blocked: 'Location blocked', missing: 'Pallet missing', damaged: 'Pallet damaged' };
      if (!reasons[reason]) throw new Error(`Unknown problem ${reason}`);
      const truck = this._truck(truckId);
      const task = truck.taskId && this.tasks[truck.taskId];
      if (!task) throw new Error(`${truck.id} has no job`);
      if (task.type === 'RECEIVE') throw new Error('Report receiving problems to the coordinator');

      // Drop location blocked while carrying.
      if (truck.load) {
        if (reason !== 'blocked') throw new Error('The pallet is on the forks — only a blocked drop location can be reported');
        const place = task.to;
        this.locations[place].blocked = true;
        if (task.autoSlot) {
          this._releaseSlot(task);
          if (this._reserveSlot(task)) {
            this.log(`${truck.id}: ${place} blocked, new slot ${task.to} for job #${task.id}`, { truckId, taskId: task.id });
            truck.waiting = this._aisle(task.to) !== this._aisle(place) && this._capacityLeft(this._aisle(task.to), truck.id) <= 0;
            truck.waitingSince = truck.waiting ? this.now() : null;
            this.dispatch();
            return this._say(truck, false, `${place} blocked. New slot: ${task.to}`);
          }
          task.to = place;
        }
        task.alert = `Drop location ${place} blocked`;
        this.log(`${truck.id}: ${place} blocked while carrying job #${task.id} — needs the coordinator`, { truckId, taskId: task.id });
        return this._say(truck, false, `${place} blocked. Coordinator alerted — hold the pallet`);
      }

      const pallet = this.pallets[task.sscc];
      const place = task.from;
      this._unassign(task);
      task.status = 'held';
      task.heldReason = reasons[reason];
      if (reason === 'blocked') {
        this.locations[place].blocked = true;
        task.blockedLoc = place;
      }
      if (reason === 'damaged') {
        pallet.status = 'blocked';
        pallet.blockReason = 'Damaged';
      }
      if (reason === 'missing') {
        this._remove(pallet);
        pallet.status = 'missing';
      }
      this.log(`${truck.id} reported ${reasons[reason].toLowerCase()} at ${place}; job #${task.id} held`, { truckId, taskId: task.id });

      // A pick (or the check of a picked pallet) gets the next pallet by FEFO straight away.
      let extra = '';
      if (task.type === 'PICK' || task.type === 'CHECK') {
        const replacement = this._replacePick(task);
        extra = replacement ? ` Replacement pallet allocated (job #${replacement.id})` : ' No replacement stock — order is short';
      }
      this._say(truck, false, `${reasons[reason]} reported.${extra}`);
      this.dispatch();
      return truck.message;
    }

    // ---- Dispatch -----------------------------------------------------------

    /** Let waiting trucks into aisles with room, then give idle trucks their next job. */
    dispatch() {
      this._checkDwell();
      const waiting = Object.values(this.trucks).filter((t) => t.waiting).sort((a, b) => a.waitingSince - b.waitingSince);
      for (const truck of waiting) {
        const task = this.tasks[truck.taskId];
        if (this._capacityLeft(this._aisle(task.to), truck.id) > 0) {
          truck.waiting = false;
          truck.waitingSince = null;
          this.log(`${truck.id} let into aisle ${this._aisle(task.to)}`, { truckId: truck.id, taskId: task.id });
          this._say(truck, true, `Aisle ${this._aisle(task.to)} clear. Go to ${task.to}`);
        }
      }
      const idle = Object.values(this.trucks)
        .filter((t) => !t.taskId && t.mode !== 'paused')
        .sort((a, b) => a.idleSince - b.idleSince);
      for (const truck of idle) {
        const task = this.nextTaskFor(truck);
        if (task) this._assign(truck, task);
      }
    }

    // Auto-Shift is filler work: it only jumps the queue when flagged urgent.
    isUrgent(task) {
      if (task.urgent) return true;
      if (task.type === 'SHIFT') return false;
      const mins = this.config.escalateAfterMin;
      return mins > 0 && this.now() - task.createdAt >= mins * MINUTE;
    }

    /** The job this truck would get right now, or null. Changes nothing. */
    nextTaskFor(truck) {
      const cfg = this.config;
      const candidates = this.openTasks().filter((t) => {
        if (!cfg.enabled[t.type] || !this._truckTakes(truck, t)) return false;
        if (t.deskOnly) return false;
        if (this.locations[t.from].blocked) return false;
        if (t.to && this.locations[t.to].blocked) return false;
        if (t.sscc && this.locations[t.from].kind === 'block' && !this._reachable(this.pallets[t.sscc])) return false;
        return this._capacityLeft(this._aisle(t.from), truck.id) > 0;
      });
      if (!candidates.length) return null;
      const rank = (t) => (this.isUrgent(t) ? -1 : cfg.priority.indexOf(t.type));
      candidates.sort((x, y) => {
        const r = rank(x) - rank(y);
        if (r) return r;
        if (cfg.travelOptimise && rank(x) >= 0) {
          const d = this.travel(truck.position, x.from) - this.travel(truck.position, y.from);
          if (d) return d;
        }
        return x.createdAt - y.createdAt || x.id - y.id;
      });
      // Idle-only work (uncovering buried stock) goes to a truck with nothing else to do.
      return candidates.find((t) => !t.idleOnly && this._slotAvailable(t))
        || candidates.find((t) => t.idleOnly && this._slotAvailable(t)) || null;
    }

    _slotAvailable(t) {
      if (t.autoSlot) return Boolean(t.to || this._findSlot(this.pallets[t.sscc], t.from, { ground: t.ground, noBury: t.noBury }));
      const to = this.locations[t.to];
      if (to.kind === 'station') return this._stationRoom(to.station, t.id) > 0;
      if (to.kind !== 'rack') return true;
      return !to.sscc && (!to.reservedBy || to.reservedBy === t.id);
    }

    openTasks() {
      return Object.values(this.tasks).filter((t) => t.status === 'open');
    }

    aisleOccupancy() {
      const occ = {};
      for (const truck of Object.values(this.trucks)) {
        const a = this.occupiedAisle(truck);
        if (a) (occ[a] = occ[a] || []).push(truck.id);
      }
      return occ;
    }

    occupiedAisle(truck) {
      if (!truck.taskId || truck.waiting) return null;
      const task = this.tasks[truck.taskId];
      return this._aisle(task.step === 0 ? task.from : task.to);
    }

    /** What the handheld should show. */
    instruction(truckId) {
      const out = this._instruction(truckId);
      const truck = this._truck(truckId);
      const p = truck.pendingSscc && this.pallets[truck.pendingSscc];
      if (p) out.pending = { pallet: p, via: truck.pendingVia, info: this._palletLookup(p) };
      return out;
    }

    _instruction(truckId) {
      const truck = this._truck(truckId);
      if (truck.mode === 'paused') return { kind: 'paused' };
      if (!truck.taskId) {
        if (truck.mode === 'transfer') return { kind: 'transfer', pallet: truck.transferSscc ? this.pallets[truck.transferSscc] : null };
        if (truck.mode === 'pick') return { kind: 'pick-order', order: truck.orderId ? this.orders[truck.orderId] : null };
        if (truck.mode === 'putaway') return { kind: 'putaway-scan' };
        if (truck.mode === 'find') return { kind: 'find', result: truck.lookup || null };
        return { kind: 'idle' };
      }
      const task = this.tasks[truck.taskId];
      if (task.type === 'RECEIVE') {
        const field = RECEIVE_FIELDS.find((f) => !task.draft[f]);
        const delivery = this.deliveries[task.deliveryId];
        return { kind: 'receive', task, delivery, field, draft: task.draft, item: task.draft.item ? this.items[task.draft.item] : null };
      }
      const pallet = this.pallets[task.sscc];
      if (task.type === 'CHECK') {
        return task.step === 0
          ? { kind: 'check-pallet', task, pallet, target: task.sscc }
          : { kind: 'check-label', task, pallet, target: task.labelCode };
      }
      if (truck.waiting) return { kind: 'wait', task, pallet, aisle: this._aisle(task.to), target: task.to };
      return task.step === 0
        ? { kind: 'pickup', task, pallet, target: task.from }
        : { kind: 'drop', task, pallet, target: task.to };
    }

    // ---- Manual modes: pick, put-away, transfer, find -------------------------

    _manualScan(truck, input) {
      const gs1 = GS1.parse(input);
      const code = (gs1 && gs1.sscc) || this.resolve(input, { cell: this.cellOfLocation(truck.position) });
      const pallet = this.pallets[code];
      const loc = this.locations[code];

      if (truck.mode === 'find') {
        truck.lookup = this.lookup(code);
        return this._say(truck, Boolean(truck.lookup), truck.lookup ? truck.lookup.text : `${input} is not a pallet or location`);
      }

      if (truck.mode === 'pick') {
        // Scan the order number (or pick it on screen), then the order's picks come one by one.
        const orderId = String(input).trim().replace(/^O/i, '');
        if (this.orders[orderId]) {
          truck.orderId = orderId;
          this.dispatch();
          const t = truck.taskId && this.tasks[truck.taskId];
          return this._say(truck, true, t ? `Order ${orderId}: ${t.type === 'CHECK' ? 'check' : 'pick'} …${t.sscc.slice(-6)}` : `Order ${orderId} has nothing for you to pick right now`);
        }
        return this._fail(truck, truck.orderId ? `Order ${truck.orderId} has nothing for you right now. Scan another order` : 'Scan an order number');
      }

      if (truck.mode === 'putaway') {
        if (!pallet) return this._fail(truck, 'Scan the pallet label');
        let task = this._liveTaskFor(pallet.sscc);
        if (task && task.status !== 'open') return this._fail(truck, `That pallet has job #${task.id} on ${task.truckId || 'hold'}`);
        if (!task) {
          const at = pallet.loc && this.locations[pallet.loc];
          if (!at || (at.kind !== 'lane' && at.kind !== 'station')) return this._fail(truck, 'That pallet is already in storage. Use Transfer to move it');
          task = this._newTask({ type: 'PUTAWAY', category: this.items[pallet.itemNo].category, sscc: pallet.sscc, from: pallet.loc, to: null });
        }
        if (!this._assign(truck, task)) return this._fail(truck, `No free ${this.categories[task.category]} slot for this pallet`);
        task.inputs = 1;
        this._pickUp(truck, task);
        return this._say(truck, true, `Put it away at ${task.to}`);
      }

      // Transfer: pallet first, then where it now stands.
      if (pallet) {
        truck.transferSscc = pallet.sscc;
        const where = pallet.loc ? `system has it at ${pallet.loc}` : 'system had lost it';
        return this._say(truck, true, `…${pallet.sscc.slice(-6)} ${pallet.itemNo} (${where}). Scan the location it goes to`);
      }
      if (!loc) return this._fail(truck, `${input} is not a pallet or location`);
      if (!truck.transferSscc) return this._fail(truck, 'Scan the pallet first, then the location');
      const r = this.transferPallet(truck.transferSscc, loc.code, { by: truck.id });
      truck.transferSscc = null;
      if (r.ok) { truck.stats.moves++; truck.stats.moveInputs += 2; }
      return this._say(truck, r.ok, r.text);
    }

    /**
     * Record that a pallet now stands at a location: correction transfers.
     * The system follows what the operator scanned. A pallet the system had
     * in that rack spot goes on the unknown-location list to be found later.
     */
    transferPallet(sscc, code, { by = 'office' } = {}) {
      const pallet = this.pallets[sscc];
      if (!pallet) return { ok: false, text: 'That pallet is not in stock. Register it at receiving' };
      if (pallet.status === 'shipped') return { ok: false, text: 'That pallet was shipped. Check the label' };
      const to = this.locations[code];
      if (!to) return { ok: false, text: `${code} is not a location` };
      if (pallet.loc === code) return { ok: true, text: `…${sscc.slice(-6)} is already recorded at ${code}` };
      const live = this._liveTaskFor(sscc);
      if (live && live.status === 'active' && (live.step > 0 || this.trucks[live.truckId]?.load === sscc)) {
        return { ok: false, text: `…${sscc.slice(-6)} is on ${live.truckId}'s forks (job #${live.id})` };
      }
      if (to.kind === 'block' && to.pallets.length >= to.height) return { ok: false, text: `${code} is stacked full` };
      const notes = [];
      if (to.kind === 'rack' && to.sscc) {
        const other = this.pallets[to.sscc];
        this._remove(other);
        other.status = 'missing';
        other.missingFrom = code;
        notes.push(`…${other.sscc.slice(-6)} was recorded here: now on the unknown-location list`);
        const otherTask = this._liveTaskFor(other.sscc);
        if (otherTask && otherTask.status === 'open') { otherTask.status = 'held'; otherTask.heldReason = 'Pallet location unknown'; }
      }
      if (to.reservedBy) {
        const t = this.tasks[to.reservedBy];
        if (t) this._releaseSlot(t);
        to.reservedBy = null;
      }
      const from = pallet.loc || pallet.missingFrom || 'unknown';
      this._remove(pallet);
      this._place(pallet, code);
      if (pallet.status === 'missing') { pallet.status = pallet.blockReason ? 'blocked' : 'available'; notes.push('found again'); }
      pallet.missingFrom = null;
      // Jobs follow the pallet: a planned pick picks it from where it really is; planned shifts are re-planned.
      if (live && live.status !== 'active') {
        if (live.type === 'SHIFT' || live.type === 'PUTAWAY') this._cancelQuiet(live);
        else live.from = code;
      }
      const cat = this.items[pallet.itemNo].category;
      if ((to.kind === 'rack' || to.kind === 'block') && to.category && to.category !== cat) {
        notes.push(`not a ${this.categories[cat]} location: relocation planned`);
        this.planRelocations();
      }
      (this.transfers = this.transfers || []).unshift({ t: this.now(), sscc, from, to: code, by });
      if (this.transfers.length > 1000) this.transfers.length = 1000;
      this.log(`Transfer …${sscc.slice(-6)}: ${from} → ${code} by ${by}${notes.length ? ` (${notes.join('; ')})` : ''}`);
      this.dispatch();
      return { ok: true, text: `Recorded at ${code}${notes.length ? `. ${notes.join('. ')}` : ''}` };
    }

    /** Pallets whose location is unknown (reported missing, or displaced by a transfer). */
    lostPallets() {
      return Object.values(this.pallets).filter((p) => p.status === 'missing');
    }

    /**
     * Stock check: what a scanned code is. A pallet: what it is, where it is and
     * where it belongs (on the forks: where it's going). A location: what's in
     * it. An item (item number, EAN or GS1 label): every pallet of it, next to
     * ship first, with location and SSCC. Returns { kind, title, lines, text }.
     */
    lookup(raw) {
      const gs1 = GS1.parse(String(raw));
      const code = (gs1 && gs1.sscc) || this.resolve(raw);
      if (this.pallets[code]) return this._palletLookup(this.pallets[code]);
      if (this.locations[code]) return this._locationLookup(this.locations[code]);
      const item = (gs1 && gs1.gtin && this.findItem(gs1.gtin)) || this.findItem(raw);
      if (item) return this._itemLookup(item);
      return null;
    }

    _lookupResult(kind, title, lines, extra) {
      return { kind, title, lines, text: [title, ...lines].join('\n'), ...extra };
    }

    _palletFlags(p) {
      const f = [];
      const state = this.shipState(p);
      if (p.status === 'missing') f.push('location unknown');
      else if (state === 'blocked') f.push(`BLOCKED${p.blockReason ? `: ${p.blockReason}` : ''}`);
      else if (state !== 'ok') f.push(`${state === 'expired' ? 'expired' : 'too short-dated to ship'}`);
      if (p.orderId && p.status !== 'shipped') f.push(`order ${p.orderId}`);
      if (p.proc) f.push(`in process: ${this.routes[p.proc.route] ? this.routes[p.proc.route].name : p.proc.route}`);
      return f;
    }

    _palletLookup(p) {
      const item = this.items[p.itemNo];
      const lines = [`Batch ${p.batch} · BB ${dmy(p.expiry)} · ${p.qty} cs`];
      const live = this._liveTaskFor(p.sscc);
      const carrier = Object.values(this.trucks).find((t) => t.load === p.sscc);
      let belongsAt = null;
      if (p.status === 'shipped') {
        const sh = (this.shipments || []).find((x) => x.pallets.some((y) => y.sscc === p.sscc));
        lines.push(`Shipped${sh ? ` on order ${sh.orderId} to ${sh.customer}` : ''}`);
      } else if (carrier) {
        belongsAt = live && live.to;
        lines.push(`On ${carrier.id}'s forks`);
        if (belongsAt) lines.push(`Goes to ${belongsAt} (job #${live.id} ${TASK_TYPES[live.type].short})`);
      } else if (p.status === 'missing') {
        belongsAt = p.missingFrom || null;
        lines.push(`Location unknown${p.missingFrom ? `: last recorded at ${p.missingFrom}` : ''}`);
      } else {
        belongsAt = p.loc;
        lines.push(`At ${p.loc}`);
      }
      if (live && !carrier) {
        lines.push(live.status === 'held'
          ? `Job #${live.id} ${TASK_TYPES[live.type].short} on hold: ${live.heldReason || 'see the coordinator'}`
          : `Job #${live.id} ${TASK_TYPES[live.type].short}${live.truckId ? ` (${live.truckId})` : ''} will take it to ${live.to || 'a free slot'}`);
      }
      const flags = this._palletFlags(p).filter((f) => f !== 'location unknown');
      if (flags.length) lines.push(flags.join(' · '));
      return this._lookupResult('pallet', `…${p.sscc.slice(-6)} ${item.itemNo} ${item.name}`, lines, { pallet: p, belongsAt, task: live || null });
    }

    _locationLookup(loc) {
      const ss = loc.kind === 'rack' ? (loc.sscc ? [loc.sscc] : []) : [...loc.pallets].reverse(); // stacks and lanes: the one in front first
      const cat = loc.category ? this.categories[loc.category] : null;
      const title = `${loc.code}${cat ? ` · ${cat}` : ''}${loc.blocked ? ' · BLOCKED' : ''}`;
      const lines = ss.map((s) => {
        const p = this.pallets[s];
        const flags = this._palletFlags(p);
        return `…${s.slice(-6)} ${p.itemNo} ${this.items[p.itemNo].name} · ${p.batch} · BB ${dmy(p.expiry)}${flags.length ? ` · ${flags.join(' · ')}` : ''}`;
      });
      if (!lines.length) lines.push('Empty');
      if (loc.reservedBy && this.tasks[loc.reservedBy]) {
        const t = this.tasks[loc.reservedBy];
        lines.push(`Reserved: job #${t.id} brings …${t.sscc.slice(-6)}`);
      }
      return this._lookupResult('location', title, lines, { location: loc, pallets: ss.map((s) => this.pallets[s]) });
    }

    _itemLookup(item) {
      const order = { ok: 0, short: 1, expired: 2, blocked: 3 };
      const pallets = Object.values(this.pallets)
        .filter((p) => p.itemNo === item.itemNo && p.status !== 'shipped')
        .sort((a, b) => (a.status === 'missing') - (b.status === 'missing') || order[this.shipState(a)] - order[this.shipState(b)]
          || a.expiry.localeCompare(b.expiry) || a.receivedAt - b.receivedAt);
      const canShip = pallets.filter((p) => p.status !== 'missing' && this.shipState(p) === 'ok' && !p.orderId).length;
      const lines = [pallets.length ? `${pallets.length} pallet(s) · ${canShip} free to ship · next to ship first` : 'No stock'];
      for (const p of pallets.slice(0, 50)) {
        const carrier = Object.values(this.trucks).find((t) => t.load === p.sscc);
        const where = carrier ? `${carrier.id} forks` : p.loc || (p.missingFrom ? `unknown (last ${p.missingFrom})` : 'unknown');
        const flags = this._palletFlags(p).filter((f) => f !== 'location unknown');
        lines.push(`${where} · ${p.sscc} · ${p.batch} · BB ${dmy(p.expiry)}${flags.length ? ` · ${flags.join(' · ')}` : ''}`);
      }
      if (pallets.length > 50) lines.push(`… and ${pallets.length - 50} more`);
      return this._lookupResult('item', `${item.itemNo} ${item.name} · ${this.categories[item.category]}`, lines, { item, pallets });
    }

    // ---- Location template by range ---------------------------------------------

    /**
     * Rack locations between two codes, component by component, in either
     * naming: "AA01A1"–"AZ43F3" (cell, rack, bay, level, position) or
     * "31-01-0-10"–"34-86-4-70". Partial codes work: "AA"–"AZ", "31"–"34".
     */
    selectLocations(from, to) {
      const a = this._rangeParts(from, 'min');
      const b = this._rangeParts(to, 'max');
      if (!a || !b || a.scheme !== b.scheme) throw new Error('Use two codes in the same naming, e.g. AA01A1 to AZ43F3');
      const keys = Object.keys(a.parts);
      return this._racks().filter((l) => {
        const c = a.scheme === 'row' ? this._rowParts(l.code) : { aisle: Number(l.aisle), bay: l.bay, level: l.level, pos: l.pos };
        const v = { ...c, cell: c.cell && c.cell.charCodeAt(0), rack: c.rack && c.rack.charCodeAt(0), level: typeof c.level === 'string' ? c.level.charCodeAt(0) - 65 : c.level };
        return keys.every((k) => v[k] >= a.parts[k] && v[k] <= b.parts[k]);
      }).map((l) => l.code);
    }

    _rangeParts(raw, end) {
      const s = String(raw || '').trim().toUpperCase().replace(/\s/g, '');
      const big = 9999;
      let m = /^([A-Z])([A-Z])?(\d{2})?([A-Z])?(\d)?$/.exec(s);
      if (m) {
        const pick = (v, f, lo, hi) => (v == null ? (end === 'min' ? lo : hi) : f(v));
        return { scheme: 'row', parts: {
          cell: m[1].charCodeAt(0),
          rack: pick(m[2], (v) => v.charCodeAt(0), 65, 90),
          bay: pick(m[3], Number, 0, big),
          level: pick(m[4], (v) => v.charCodeAt(0) - 65, 0, big),
          pos: pick(m[5], Number, 0, big),
        } };
      }
      m = /^(\d{2})(?:-(\d{2}))?(?:-(\d))?(?:-(\d{2}))?$/.exec(s);
      if (m) {
        const pick = (v) => (v == null ? (end === 'min' ? 0 : big) : Number(v));
        return { scheme: 'current', parts: { aisle: Number(m[1]), bay: pick(m[2]), level: pick(m[3]), pos: pick(m[4]) } };
      }
      return null;
    }

    /** What applying a category to these locations would do, before doing it. */
    previewTemplate(codes, category) {
      if (category !== null && !this.categories[category]) throw new Error(`Unknown category ${category}`);
      const out = { locations: codes.length, changed: 0, from: {}, palletsToMove: 0, palletsHere: 0 };
      for (const code of codes) {
        const loc = this.locations[code];
        if (loc.category !== category) {
          out.changed++;
          const k = loc.category || 'none';
          out.from[k] = (out.from[k] || 0) + 1;
        }
        if (loc.sscc) {
          out.palletsHere++;
          if (category && this.items[this.pallets[loc.sscc].itemNo].category !== category) out.palletsToMove++;
        }
      }
      return out;
    }

    /** Apply a category to a selection; pallets now in the wrong category get relocation jobs. */
    applyTemplate(codes, category, { by = 'office' } = {}) {
      const preview = this.previewTemplate(codes, category);
      for (const code of codes) this.locations[code].category = category;
      this.log(`Template by ${by}: ${preview.changed} of ${codes.length} locations → ${category ? this.categories[category] : 'no category'}`);
      const moves = this.planRelocations();
      this.dispatch();
      return { ...preview, moves };
    }

    /** Location attributes from the site's location table: code, category, blocked. */
    importLocations(rows) {
      const out = { updated: 0, unknown: [] };
      for (const r of rows) {
        const code = this.resolve(r.code);
        const loc = this.locations[code];
        if (!loc) { out.unknown.push(r.code); continue; }
        if (r.category !== undefined) loc.category = r.category || null;
        if (r.blocked !== undefined) loc.blocked = Boolean(r.blocked);
        out.updated++;
      }
      this.planRelocations();
      return out;
    }

    // ---- Traceability -----------------------------------------------------------

    /** Everything about a batch: where it came from, what's in stock, who got it. */
    trace(batch) {
      const b = String(batch).trim().toUpperCase();
      const pallets = Object.values(this.pallets).filter((p) => String(p.batch).toUpperCase() === b);
      const deliveries = [...new Set(pallets.map((p) => p.deliveryId).filter(Boolean))].map((id) => this.deliveries[id]);
      const shipped = (this.shipments || []).flatMap((s) => s.pallets.filter((p) => String(p.batch).toUpperCase() === b).map((p) => ({ ...p, orderId: s.orderId, customer: s.customer, t: s.t })));
      return {
        batch: b,
        inStock: pallets.filter((p) => p.status !== 'shipped'),
        received: deliveries.map((d) => ({ id: d.id, supplier: d.supplier, t: d.createdAt })),
        shipped,
        customers: [...new Set(shipped.map((s) => s.customer))],
      };
    }

    // ---- Save and restore ---------------------------------------------------------

    /** The whole state as plain data (for the server's snapshots). */
    toJSON() {
      const out = {};
      for (const [k, v] of Object.entries(this)) {
        if (k === 'clock' || k === '_rackList') continue;
        out[k] = v;
      }
      return out;
    }

    static restore(state, { clock } = {}) {
      const wh = Object.create(Warehouse.prototype);
      Object.assign(wh, JSON.parse(JSON.stringify(state)));
      wh.clock = clock || (() => Date.now());
      return wh;
    }

    // ---- Process stations -------------------------------------------------------

    /**
     * A work station (machine + operators, e.g. the pallet-change press) or a
     * dwell room (e.g. the warm room, timed by the system). Pallets are brought
     * to it by Auto moves and collected the same way.
     */
    addStation({ id, name, machine = null, minutes = 0, sop = [], capacity = 1, queue = 4, dwell = false, operators = 1 }) {
      if (this.stations[id]) throw new Error(`Station ${id} already exists`);
      const code = `ST-${id}`;
      this.locations[code] = { code, kind: 'station', station: id, aisle: null, pallets: [], blocked: false, printer: `LP-${code}` };
      this.stations[id] = { id, name, machine, minutes, sop, capacity, queue, dwell, operators, code, message: null, done: 0 };
      return this.stations[id];
    }

    /** A process route: the stations a pallet goes through, in order. */
    addRoute({ id, name, steps }) {
      for (const step of steps) if (!this.stations[step.station]) throw new Error(`Unknown station ${step.station}`);
      this.routes[id] = { id, name, steps };
      return this.routes[id];
    }

    _newProc(routeId, then = {}) {
      return { route: routeId, step: 0, state: 'moving', then, startedAt: null, dueAt: null, since: this.now() };
    }

    /**
     * Send a pallet from storage through a process route. Afterwards it goes
     * back into storage, or to an order's shipping lane.
     */
    startProcess(sscc, routeId, { orderId = null } = {}) {
      const pallet = this._pallet(sscc);
      const route = this.routes[routeId];
      if (!route) throw new Error(`Unknown process ${routeId}`);
      const loc = pallet.loc && this.locations[pallet.loc];
      if (!loc || (loc.kind !== 'rack' && loc.kind !== 'block')) throw new Error('That pallet is not in storage');
      if (pallet.proc) throw new Error(`Pallet …${sscc.slice(-6)} is already in a process`);
      const live = this._liveTaskFor(sscc);
      if (live) throw new Error(`Pallet …${sscc.slice(-6)} already has job #${live.id}`);
      pallet.proc = this._newProc(routeId, { orderId });
      const first = this.stations[route.steps[0].station];
      const task = this._newTask({ type: 'MOVE', category: this.items[pallet.itemNo].category, sscc, from: pallet.loc, to: first.code });
      task.note = `${route.name}: to ${first.name}`;
      this.log(`Pallet …${sscc.slice(-6)} starts ${route.name}`, { taskId: task.id });
      this.dispatch();
      return task;
    }

    // Space left at a station for pallets on their way in.
    _stationRoom(stationId, exceptTaskId = null) {
      const st = this.stations[stationId];
      const here = this.locations[st.code].pallets.length;
      const coming = Object.values(this.tasks).filter((t) => t.status === 'active' && t.to === st.code && t.id !== exceptTaskId).length;
      return (st.dwell ? st.capacity : st.queue) - here - coming;
    }

    _arrive(pallet, loc) {
      const st = this.stations[loc.station];
      const pr = pallet.proc;
      if (!pr) {
        this.log(`Pallet …${pallet.sscc.slice(-6)} arrived at ${st.name} without a process`);
        return;
      }
      const step = this.routes[pr.route].steps[pr.step];
      if (st.dwell) {
        pr.state = 'dwelling';
        pr.startedAt = this.now();
        pr.dueAt = this.now() + (step.dwellMin || 0) * MINUTE;
        this.log(`Pallet …${pallet.sscc.slice(-6)} in ${st.name} for ${this._duration(step.dwellMin)}`);
      } else {
        pr.state = 'queued';
        pr.queuedAt = this.now();
        this.log(`Pallet …${pallet.sscc.slice(-6)} waiting at ${st.name}`);
      }
    }

    /**
     * The station operator's only input: scan the pallet to start, scan it
     * again when done. The SOP is on the screen; nothing to tick off.
     */
    stationScan(stationId, raw) {
      const st = this.stations[stationId];
      if (!st) throw new Error(`No station ${stationId}`);
      const say = (ok, text) => { st.message = { ok, text }; return st.message; };
      const label = GS1.parse(String(raw).trim());
      const sscc = (label && label.sscc) || String(raw).trim();
      const pallet = this.pallets[sscc];
      if (!pallet || pallet.loc !== st.code) return say(false, 'That pallet is not at this station');
      const pr = pallet.proc;
      if (!pr) return say(false, 'That pallet has no process');
      const step = this.routes[pr.route].steps[pr.step];
      if (st.dwell) {
        const left = Math.max(0, Math.ceil((pr.dueAt - this.now()) / MINUTE));
        return say(pr.state !== 'dwelling', pr.state === 'dwelling' ? `${this._duration(left)} to go. The system calls a truck when time is up` : 'Time is up, a truck is on its way');
      }
      if (pr.state === 'queued') {
        const busy = this.locations[st.code].pallets.filter((s) => this.pallets[s].proc && this.pallets[s].proc.state === 'working').length;
        if (busy >= st.capacity) return say(false, `${st.machine || st.name} is busy. Finish the pallet on it first`);
        pr.state = 'working';
        pr.startedAt = this.now();
        this.log(`${st.name}: started ${step.op} on …${sscc.slice(-6)}`);
        return say(true, `Started: ${step.op}. Scan the pallet again when done`);
      }
      if (pr.state === 'working') {
        const mins = Math.round((this.now() - pr.startedAt) / MINUTE);
        this._record(pallet, st, step, pr.startedAt, this.now());
        st.done++;
        if (step.reprint) this._printPalletLabel(pallet, st);
        this._advance(pallet);
        this.dispatch();
        return say(true, `Done in ${mins} min${step.reprint ? '. New pallet label printed' : ''}. A truck will collect it`);
      }
      return say(false, 'Already done. Waiting for a truck');
    }

    // Warm-room time up: the system creates the move out, flagged urgent. No phone timers.
    _checkDwell() {
      const now = this.now();
      for (const pallet of Object.values(this.pallets)) {
        const pr = pallet.proc;
        if (!pr || pr.state !== 'dwelling' || pr.dueAt > now) continue;
        const st = this.stations[this.locations[pallet.loc].station];
        this._record(pallet, st, this.routes[pr.route].steps[pr.step], pr.startedAt, pr.dueAt);
        this.log(`${st.name}: time up for …${pallet.sscc.slice(-6)}, move out called`);
        this._advance(pallet, { urgent: true, alert: `Time up in ${st.name}` });
      }
    }

    _advance(pallet, { urgent = false, alert = null } = {}) {
      const pr = pallet.proc;
      const route = this.routes[pr.route];
      pr.step++;
      const cat = this.items[pallet.itemNo].category;
      let task;
      if (pr.step < route.steps.length) {
        const next = this.stations[route.steps[pr.step].station];
        pr.state = 'moving';
        task = this._newTask({ type: 'MOVE', category: cat, sscc: pallet.sscc, from: pallet.loc, to: next.code, urgent });
        task.note = `${route.name}: to ${next.name}`;
      } else {
        const orderId = pr.then && pr.then.orderId;
        pallet.lastProc = { route: pr.route, done: this.now() };
        pallet.proc = null;
        task = orderId
          ? this._newTask({ type: 'MOVE', category: cat, sscc: pallet.sscc, from: pallet.loc, to: this.orders[orderId].lane, orderId, urgent })
          : this._newTask({ type: 'MOVE', category: cat, sscc: pallet.sscc, from: pallet.loc, to: null, urgent });
        task.note = `${route.name} done: ${orderId ? `to order ${orderId}` : 'back to storage'}`;
        this.log(`Pallet …${pallet.sscc.slice(-6)} finished ${route.name}`);
      }
      task.alert = alert;
      return task;
    }

    _record(pallet, st, step, start, end) {
      const entry = {
        sscc: pallet.sscc, itemNo: pallet.itemNo, batch: pallet.batch, route: pallet.proc.route,
        station: st.id, op: step.op || st.name, start, end,
        minutes: Math.round((end - start) / MINUTE), standard: st.dwell ? step.dwellMin : st.minutes,
      };
      this.processLog.unshift(entry);
      if (this.processLog.length > 500) this.processLog.length = 500;
      (pallet.trail = pallet.trail || []).push(entry);
    }

    _printPalletLabel(pallet, st) {
      const item = this.items[pallet.itemNo];
      const label = { sscc: pallet.sscc, itemNo: item.itemNo, itemName: item.name, batch: pallet.batch, expiry: pallet.expiry, qty: pallet.qty };
      this.printQueue.unshift({ id: ++this._seq.label, printer: this.locations[st.code].printer, at: this.now(), label: { ...label, labelCode: pallet.sscc, kind: 'pallet' }, zpl: Labels.palletLabel(label) });
    }

    _duration(mins) {
      if (mins == null) return '';
      return mins >= 60 ? `${Math.floor(mins / 60)} h${mins % 60 ? ` ${mins % 60} min` : ''}` : `${mins} min`;
    }

    /** Everything a station screen shows. */
    stationView(stationId) {
      const st = this.stations[stationId];
      const pallets = this.locations[st.code].pallets.map((s) => this.pallets[s]);
      const by = (state) => pallets.filter((p) => p.proc && p.proc.state === state);
      const coming = Object.values(this.tasks).filter((t) => LIVE.has(t.status) && t.to === st.code).length;
      const now = this.now();
      return {
        station: st,
        queue: by('queued').sort((a, b) => a.proc.queuedAt - b.proc.queuedAt),
        working: by('working').map((p) => ({ pallet: p, mins: (now - p.proc.startedAt) / MINUTE, step: this.routes[p.proc.route].steps[p.proc.step] })),
        dwelling: by('dwelling').map((p) => ({ pallet: p, left: (p.proc.dueAt - now) / MINUTE, total: (p.proc.dueAt - p.proc.startedAt) / MINUTE })).sort((a, b) => a.left - b.left),
        waiting: pallets.filter((p) => !p.proc || p.proc.state === 'moving'),
        coming,
      };
    }

    // ---- Receiving desk (two operators) -----------------------------------------

    /**
     * A receiving desk: one operator at the keyboard, one with the scanner.
     * The screen tells the keyboard operator what to call out next.
     */
    addDesk(id, { name = id } = {}) {
      this.desks[id] = {
        id, name, kind: 'desk', mode: 'desk', taskId: null, message: null, position: 'DOCK-IN', load: null, waiting: false,
        categories: null, idleSince: this.now(), stats: { jobs: 0, scans: 0, wrongScans: 0, taps: 0, moves: 0, moveInputs: 0, received: 0, receiveInputs: 0 },
      };
      return this.desks[id];
    }

    /** Take a delivery to the desk (the next one waiting for it if none is named). */
    deskStart(deskId, deliveryId = null) {
      const desk = this.desks[deskId];
      if (!desk) throw new Error(`No desk ${deskId}`);
      if (desk.taskId) throw new Error(`${desk.name} is already receiving`);
      const task = Object.values(this.tasks).find((t) => t.type === 'RECEIVE' && t.status === 'open'
        && (deliveryId ? t.deliveryId === deliveryId : t.deskOnly));
      if (!task) throw new Error(deliveryId ? `Delivery ${deliveryId} is not waiting` : 'No delivery waiting for the desk');
      task.status = 'active';
      task.truckId = desk.id;
      task.dispatchReason = 'Receiving desk';
      desk.taskId = task.id;
      desk.idleSince = null;
      this.log(`${desk.name} ← delivery ${task.deliveryId}`, { taskId: task.id });
      return this._say(desk, true, `Delivery ${task.deliveryId}: call out ${this.deskCallout(deskId).word}`);
    }

    /** What the keyboard operator calls out next: BATCH, PALLET or GS1. */
    deskCallout(deskId) {
      const desk = this.desks[deskId];
      const task = desk && desk.taskId && this.tasks[desk.taskId];
      if (!task) return null;
      const c = DESK_CALLOUTS.find((x) => x.fields.some((f) => !task.draft[f]));
      return c || null;
    }

    /** Keyboard entry at the desk for a value with no usable barcode. */
    deskEnter(deskId, field, raw) {
      const desk = this.desks[deskId];
      const task = desk && desk.taskId && this.tasks[desk.taskId];
      if (!task) throw new Error('The desk has no delivery open');
      if (!RECEIVE_FIELDS.includes(field)) throw new Error(`Unknown field ${field}`);
      desk.stats.taps++;
      task.draft.inputs = (task.draft.inputs || 0) + 1;
      const v = String(raw).trim();
      const fields = {};
      if (field === 'batch') {
        if (!v || v.length > 20) return this._fail(desk, 'A batch is 1–20 characters');
        fields.batch = v.toUpperCase();
      } else if (field === 'expiry') {
        const iso = parseDate(v);
        if (!iso) return this._fail(desk, 'Not a date. Type it as 31-10-2026');
        fields.expiry = iso;
      } else if (field === 'item') {
        const item = this.findItem(v);
        if (!item) return this._fail(desk, `${v} is not a known item number or EAN`);
        fields.item = item.itemNo;
      } else if (field === 'sscc') {
        fields.sscc = v.replace(/^\(00\)/, '');
      } else {
        const n = Number(v);
        if (!Number.isInteger(n) || n < 1) return this._fail(desk, 'Quantity must be a whole number above 0');
        fields.qty = n;
      }
      return this._applyReceive(desk, task, fields);
    }

    // ---- Internals: jobs ----------------------------------------------------

    _newTask(fields) {
      const task = {
        id: ++this._seq.task,
        type: fields.type,
        category: fields.category,
        reason: fields.reason || null,
        sscc: fields.sscc || null,
        from: fields.from,
        to: fields.to || null,
        autoSlot: fields.to == null,
        ground: Boolean(fields.ground),
        idleOnly: Boolean(fields.idleOnly), // only for a truck with nothing else to do
        noBury: Boolean(fields.noBury), // never put this pallet where it buries older stock
        orderId: fields.orderId || null,
        deliveryId: fields.deliveryId || null,
        urgent: Boolean(fields.urgent),
        createdAt: this.now(),
        status: 'open',
        truckId: null,
        step: 0,
        dispatchReason: null,
        heldReason: null,
        blockedLoc: null,
        alert: null,
        replacedBy: null,
        inputs: 0,
      };
      if (fields.type === 'RECEIVE' || fields.type === 'CHECK') task.autoSlot = false;
      this.tasks[task.id] = task;
      return task;
    }

    _truckTakes(truck, task) {
      const types = TRUCK_MODES[truck.mode].types;
      if (types && !types.includes(task.type)) return false;
      if (truck.mode === 'pick' && task.orderId !== truck.orderId) return false;
      return !truck.categories || truck.categories.includes(task.category);
    }

    _assign(truck, task) {
      if (task.autoSlot && !task.to && !this._reserveSlot(task)) return false;
      if (!task.autoSlot && this.locations[task.to].kind === 'rack') {
        if (!this._slotAvailable(task)) return false;
        this.locations[task.to].reservedBy = task.id;
      }
      task.status = 'active';
      task.truckId = truck.id;
      task.dispatchReason = this._reasonFor(task);
      truck.taskId = task.id;
      truck.idleSince = null;
      this.log(`${truck.id} ← job #${task.id} ${TASK_TYPES[task.type].short} (${task.dispatchReason})`, { truckId: truck.id, taskId: task.id });
      return true;
    }

    _reasonFor(task) {
      if (task.urgent) return 'Urgent';
      if (this.isUrgent(task)) return `Waited ${Math.floor((this.now() - task.createdAt) / MINUTE)} min`;
      const p = this.config.priority.indexOf(task.type) + 1;
      return `Priority ${p}${this.config.travelOptimise ? ' · nearest' : ''}`;
    }

    _unassign(task) {
      const truck = this.trucks[task.truckId] || this.desks[task.truckId];
      if (truck && truck.taskId === task.id) {
        truck.taskId = null;
        truck.waiting = false;
        truck.waitingSince = null;
        truck.idleSince = this.now();
      }
      task.status = 'open';
      task.truckId = null;
      if (task.type !== 'RECEIVE') task.step = 0;
      task.dispatchReason = null;
      this._releaseSlot(task);
    }

    _matchPickup(truck, task, code) {
      const pallet = this.pallets[task.sscc];
      const fromLoc = this.locations[task.from];
      if (code === task.sscc) return { ok: true, text: '' };
      if (fromLoc.kind === 'rack' && code === task.from) return { ok: true, text: '' };
      if (fromLoc.kind === 'block' && code === task.from && this._reachable(pallet)) return { ok: true, text: '' };
      const scanned = this.pallets[code];
      // Pick: another pallet of the same item, batch and expiry is just as good.
      if (task.type === 'PICK' && scanned && this._batchKey(scanned) === this._batchKey(pallet)) {
        const why = this._swapProblem(scanned, truck, task);
        if (why) return { ok: false, text: why };
        this._swapPick(task, scanned);
        return { ok: true, text: 'Same batch, swapped. ' };
      }
      if (fromLoc.kind !== 'rack') return { ok: false, text: `Scan the pallet label ending …${task.sscc.slice(-6)} at ${this._placeName(task.from)}` };
      return { ok: false, text: `Wrong pallet. Go to ${task.from}` };
    }

    _swapProblem(p, truck, task) {
      const loc = this.locations[p.loc];
      if (!loc || (loc.kind !== 'rack' && loc.kind !== 'block')) return 'That pallet is not in storage';
      if (loc.kind === 'block' && !this._reachable(p)) return 'That pallet is buried in the stack';
      if (this.shipState(p) !== 'ok') return `That pallet can't ship (${p.blockReason || 'too short-dated'})`;
      if (p.orderId) return `That pallet is for order ${p.orderId}`;
      if (loc.blocked) return `${loc.code} is blocked`;
      if (this._capacityLeft(loc.aisle, truck.id) <= 0 && loc.aisle !== this._aisle(task.from)) return `Aisle ${loc.aisle} is full`;
      const live = this._liveTaskFor(p.sscc);
      if (live && !(live.type === 'SHIFT' && live.status === 'open')) return `That pallet already has job #${live.id}`;
      return null;
    }

    _swapPick(task, scanned) {
      const live = this._liveTaskFor(scanned.sscc);
      if (live) this._cancelQuiet(live);
      const old = this.pallets[task.sscc];
      const order = this.orders[task.orderId];
      for (const line of order.lines) {
        const i = line.allocated.indexOf(old.sscc);
        if (i !== -1) line.allocated[i] = scanned.sscc;
      }
      old.orderId = null;
      scanned.orderId = task.orderId;
      task.sscc = scanned.sscc;
      task.from = scanned.loc;
      this.log(`Job #${task.id}: picked …${scanned.sscc.slice(-6)} instead of …${old.sscc.slice(-6)} (same batch)`, { taskId: task.id });
    }

    _pickUp(truck, task) {
      const pallet = this.pallets[task.sscc];
      this._remove(pallet);
      truck.load = pallet.sscc;
      truck.position = task.from;
      task.step = 1;
      truck.waiting = this._aisle(task.to) !== this._aisle(task.from) && this._capacityLeft(this._aisle(task.to), truck.id) <= 0;
      truck.waitingSince = truck.waiting ? this.now() : null;
      if (truck.waiting) this.log(`${truck.id} waiting: aisle ${this._aisle(task.to)} full`, { truckId: truck.id, taskId: task.id });
      this.dispatch();
    }

    _drop(truck, task) {
      const pallet = this.pallets[truck.load];
      const to = this.locations[task.to];
      if (to.kind === 'rack' || to.kind === 'block') to.reservedBy = null;
      const buries = to.kind === 'block' && this._laneFit(to.lane, pallet).buries;
      this._place(pallet, task.to);
      if (buries) {
        this.log(`⚠ ${to.lane}: batch ${pallet.batch} now stands in front of stock with an earlier best-before`, { taskId: task.id });
        this.planDigOut();
      }
      truck.load = null;
      truck.position = task.to;
      task.alert = null;
      this._finish(truck, task);
      if (to.kind === 'station') this._arrive(pallet, to);
      else if ((task.type === 'PICK' || task.type === 'MOVE') && task.orderId && to.kind === 'lane') this._picked(task, pallet);
      if (task.type === 'PUTAWAY' || task.type === 'SHIFT' || (task.type === 'MOVE' && !task.orderId)) this.planGround();
      this.dispatch();
    }

    _finish(truck, task) {
      truck.taskId = null;
      truck.idleSince = this.now();
      truck.stats.jobs++;
      if (task.type !== 'RECEIVE') {
        truck.stats.moves++;
        truck.stats.moveInputs += task.inputs;
      }
      task.status = 'done';
      task.doneAt = this.now();
      this.log(`${truck.id} finished job #${task.id} ${TASK_TYPES[task.type].short}`, { truckId: truck.id, taskId: task.id });
    }

    _picked(task, pallet) {
      if (this.config.checkAfterPick) {
        this._newTask({ type: 'CHECK', category: task.category, sscc: pallet.sscc, from: task.to, to: task.to, orderId: task.orderId });
      } else {
        pallet.checked = true;
      }
      this._updateOrder(this.orders[task.orderId]);
    }

    // Check & label: scan the pallet, the label prints, scan the label.
    _checkScan(truck, task, input) {
      const code = input.toUpperCase();
      const order = this.orders[task.orderId];
      if (task.step === 0) {
        const scanned = this.pallets[GS1.parse(code)?.sscc || code];
        if (!scanned) return this._fail(truck, `Scan the pallet label ending …${task.sscc.slice(-6)}`);
        if (scanned.sscc !== task.sscc) {
          if (scanned.orderId && scanned.orderId !== task.orderId) return this._fail(truck, `That pallet is for order ${scanned.orderId}`);
          return this._fail(truck, `Not this pallet. Scan the one ending …${task.sscc.slice(-6)}`);
        }
        const problem = this._checkProblem(scanned, order);
        if (problem) {
          task.alert = problem;
          return this._fail(truck, `${problem}. Report it as damaged or call the coordinator`);
        }
        const index = ++order.labels;
        task.labelCode = `SL${order.id}${pad(index, 2)}`;
        const item = this.items[scanned.itemNo];
        const lane = this.locations[task.from];
        const label = {
          labelCode: task.labelCode, sscc: scanned.sscc, orderId: order.id, customer: order.customer,
          index, total: order.lines.reduce((s, l) => s + l.pallets, 0),
          itemNo: item.itemNo, itemName: item.name, batch: scanned.batch, expiry: scanned.expiry, qty: scanned.qty,
          lane: lane.code, printedAt: new Date(this.now()).toISOString().slice(0, 16).replace('T', ' '),
        };
        this.printQueue.unshift({ id: ++this._seq.label, printer: lane.printer, at: this.now(), label, zpl: Labels.shippingLabel(label) });
        if (this.printQueue.length > 50) this.printQueue.length = 50;
        task.step = 1;
        return this._say(truck, true, `Checked. Label printing on ${lane.printer} — stick it on and scan it`);
      }
      if (code !== task.labelCode) return this._fail(truck, `Scan the new shipping label ${task.labelCode}`);
      const pallet = this.pallets[task.sscc];
      pallet.checked = true;
      pallet.labelCode = task.labelCode;
      this._finish(truck, task);
      this._updateOrder(order);
      this.dispatch();
      return this._say(truck, true, 'Labelled. Pallet ready to load');
    }

    _checkProblem(pallet, order) {
      if (pallet.orderId !== order.id) return 'Pallet is not allocated to this order';
      const state = this.shipState(pallet);
      if (state === 'blocked') return `Pallet is blocked (${pallet.blockReason})`;
      if (state === 'expired') return 'Pallet is past its expiry date';
      if (state === 'short') return `Only ${this.daysLeft(pallet)} days left, minimum to ship is ${this.items[pallet.itemNo].minShipDays}`;
      if (!order.lines.some((l) => l.itemNo === pallet.itemNo)) return 'Wrong item for this order';
      return null;
    }

    _updateOrder(order) {
      const all = order.lines.flatMap((l) => l.allocated).map((s) => this.pallets[s]);
      const short = order.lines.some((l) => l.short);
      if (all.length && all.every((p) => p.checked)) {
        if (order.status !== 'ready') this.log(`Order ${order.id} ready to load${short ? ' (short)' : ''}`);
        order.status = 'ready';
      } else if (all.some((p) => p.loc && this.locations[p.loc].kind === 'lane')) {
        order.status = 'picking';
      }
    }

    _createPick(order, line, pallet) {
      const live = this._liveTaskFor(pallet.sscc);
      if (live) this._cancelQuiet(live); // e.g. a bring-down shift that hadn't started
      pallet.orderId = order.id;
      line.allocated.push(pallet.sscc);
      let to = order.lane;
      if (line.process) {
        // e.g. a pallet change: picked straight to the station, then on to the shipping lane.
        const first = this.stations[this.routes[line.process].steps[0].station];
        pallet.proc = this._newProc(line.process, { orderId: order.id });
        to = first.code;
      }
      return this._newTask({ type: 'PICK', category: this.items[pallet.itemNo].category, sscc: pallet.sscc, from: pallet.loc, to, orderId: order.id });
    }

    _replacePick(task) {
      const order = this.orders[task.orderId];
      const old = this.pallets[task.sscc];
      const line = order.lines.find((l) => l.allocated.includes(old.sscc));
      line.allocated.splice(line.allocated.indexOf(old.sscc), 1);
      old.orderId = null;
      old.proc = null;
      if (old.loc && this.locations[old.loc].kind === 'lane' && old.status === 'blocked') {
        // A damaged pallet on the shipping lane goes back for the coordinator to deal with.
        old.checked = false;
      }
      const pallet = this._allocate(line.itemNo);
      if (!pallet) {
        line.short++;
        this.log(`Order ${order.id}: no replacement for ${line.itemNo} — line short`);
        return null;
      }
      const replacement = this._createPick(order, line, pallet);
      task.replacedBy = replacement.id;
      this.log(`Order ${order.id}: …${pallet.sscc.slice(-6)} allocated as replacement (job #${replacement.id})`, { taskId: replacement.id });
      return replacement;
    }

    _allocate(itemNo) {
      return this._fefo(itemNo)[0] || null;
    }

    _unallocate(sscc) {
      const pallet = this.pallets[sscc];
      if (!pallet || !pallet.orderId) return;
      const order = this.orders[pallet.orderId];
      for (const line of order.lines) {
        const i = line.allocated.indexOf(sscc);
        if (i !== -1) { line.allocated.splice(i, 1); line.short++; }
      }
      pallet.orderId = null;
    }

    /** Usable pallets of an item in shipping order: first expiry, then first received, ground first. */
    _fefo(itemNo) {
      const live = this._liveMap();
      const blockers = new Set(['pickfirst', 'both'].includes(this.config.buriedStock) ? this._blockers() : []);
      return Object.values(this.pallets)
        .filter((p) => {
          if (p.itemNo !== itemNo || !p.loc || p.orderId || this.shipState(p) !== 'ok') return false;
          const loc = this.locations[p.loc];
          if (loc.blocked) return false;
          if (loc.kind === 'block') {
            // Only the next pallet out of the lane: everything in front of it is already on an order.
            const ahead = this._blockSeq(loc.lane);
            const i = ahead.indexOf(p.sscc);
            if (ahead.slice(0, i).some((s) => !this.pallets[s].orderId)) return false;
          } else if (loc.kind !== 'rack') return false;
          const t = live.get(p.sscc);
          return !t || (t.type === 'SHIFT' && t.status === 'open');
        })
        .sort((a, b) => (blockers.has(b.sscc) - blockers.has(a.sscc))
          || (a.expiry < b.expiry ? -1 : a.expiry > b.expiry ? 1 : 0)
          || a.receivedAt - b.receivedAt
          || (this.locations[a.loc].level || 0) - (this.locations[b.loc].level || 0)
          || (a.loc < b.loc ? -1 : 1));
    }

    /** Pallets standing in front of an older batch in a block lane, front first. */
    _blockers() {
      const out = [];
      for (const { lane, buried } of this.buriedLanes()) {
        for (const s of this._blockSeq(lane)) {
          const p = this.pallets[s];
          if (this._batchKey(p) === buried.key) break;
          if (!out.includes(s)) out.push(s);
        }
      }
      return out;
    }

    /**
     * Uncover older stock buried behind newer in block lanes: Auto-Shift the
     * newer pallets in front to another lane, for trucks with nothing else to do.
     */
    planDigOut() {
      if (!['digout', 'both'].includes(this.config.buriedStock)) return 0;
      let n = 0;
      for (const sscc of this._blockers()) {
        const p = this.pallets[sscc];
        if (p.orderId || p.proc || this._liveTaskFor(sscc)) continue;
        if (!this._findSlot(p, p.loc, { noBury: true })) continue;
        this._newTask({ type: 'SHIFT', reason: 'digout', sscc, from: p.loc, to: null, category: this.items[p.itemNo].category, idleOnly: true, noBury: true });
        n++;
      }
      if (n) this.log(`${n} pallet(s) stand in front of older stock in the block stacks — moves planned for idle trucks`);
      return n;
    }

    _cancelQuiet(task) {
      if (task.status === 'active') this._unassign(task);
      this._releaseSlot(task);
      task.status = 'cancelled';
    }

    // ---- Internals: receiving -------------------------------------------------

    /**
     * Receiving input. Every barcode on a supplier pallet label is read for
     * whatever it carries (a 3-barcode logistic label fills item + count,
     * best-before + batch and SSCC, in any order). Plain barcodes are taken
     * in the order batch, expiry, item, SSCC, quantity, except that an SSCC
     * or a known EAN is recognised wherever it comes. With a delivery list,
     * the SSCC alone fills the rest.
     */
    _receiveScan(truck, task, input) {
      const d = task.draft;
      const fields = {};
      const gs1 = GS1.parse(input);
      if (gs1) {
        Object.assign(fields, gs1);
        if (gs1.gtin) {
          const item = this.findItem(gs1.gtin);
          if (!item) return this._fail(truck, `GTIN ${gs1.gtin} is not in the item list — call the coordinator`);
          fields.item = item.itemNo;
        }
      } else {
        const plain = input.replace(/^\(00\)/, '');
        const asItem = /^\d{8,14}$/.test(plain) && this.findItem(plain);
        if (!d.sscc && /^\d{18}$/.test(plain) && GS1.isValidSscc(plain)) fields.sscc = plain;
        else if (!d.item && asItem) fields.item = asItem.itemNo;
        else {
          const field = RECEIVE_FIELDS.find((f) => !d[f]);
          if (field === 'batch') {
            if (input.length > 20) return this._fail(truck, 'That is too long for a batch number');
            fields.batch = input.toUpperCase();
          } else if (field === 'expiry') {
            const iso = parseDate(input);
            if (!iso) return this._fail(truck, 'Not a date. Scan the best-before date (e.g. 261031 or 31-10-2026)');
            fields.expiry = iso;
          } else if (field === 'item') {
            return this._fail(truck, `${input} is not a known item number or EAN`);
          } else if (field === 'sscc') {
            return this._fail(truck, this._ssccProblem(plain) || 'Scan the pallet SSCC');
          } else if (field === 'qty') {
            d.inputs--; // confirmQty counts this input
            truck.stats.taps--;
            return this.confirmQty(truck.id, input);
          }
        }
      }

      return this._applyReceive(truck, task, fields);
    }

    // Fill the receiving draft from scanned or typed values; register the pallet when complete.
    _applyReceive(truck, task, fields) {
      const d = task.draft;
      const delivery = this.deliveries[task.deliveryId];
      if (fields.sscc) {
        const why = this._ssccProblem(fields.sscc);
        if (why) return this._fail(truck, why);
        const listed = delivery.list && delivery.list[fields.sscc];
        if (listed) {
          const item = this.findItem(listed.itemNo || listed.gtin);
          const fromList = { item: item && item.itemNo, batch: listed.batch, expiry: listed.expiry, qty: listed.qty };
          for (const [k, v] of Object.entries(fromList)) {
            const mine = fields[k] || d[k];
            if (v && mine && String(mine) !== String(v)) {
              return this._fail(truck, `Label and delivery list disagree on ${FIELD_LABELS[k].toLowerCase()} (${mine} vs ${v}) — call the coordinator`);
            }
            if (v && !mine) fields[k] = v;
          }
        } else if (delivery.list) {
          this.log(`Delivery ${delivery.id}: SSCC …${fields.sscc.slice(-6)} is not on the delivery list`, { taskId: task.id });
        }
      }

      const got = [];
      for (const f of RECEIVE_FIELDS) if (fields[f] != null) { d[f] = fields[f]; got.push(FIELD_LABELS[f].toLowerCase()); }
      if (RECEIVE_FIELDS.every((f) => d[f])) return this._registerReceived(truck, task);
      const next = RECEIVE_FIELDS.find((f) => !d[f]);
      if (truck.kind === 'desk') {
        const c = this.deskCallout(truck.id);
        return this._say(truck, true, `Got ${got.join(', ')}. ${c.word === 'GS1' && d.item && d.expiry ? 'Type the quantity' : `Call out ${c.word}`}`);
      }
      return this._say(truck, true, `Got ${got.join(', ')}. ${next === 'qty' ? 'Confirm the quantity' : `Next: ${FIELD_LABELS[next].toLowerCase()}`}`);
    }

    _ssccProblem(s) {
      if (!/^\d{18}$/.test(s)) return 'An SSCC is 18 digits. Scan the pallet label';
      if (!GS1.isValidSscc(s)) return 'SSCC check digit is wrong. Rescan the pallet label';
      if (this.pallets[s]) return `SSCC …${s.slice(-6)} is already registered`;
      return null;
    }

    _registerReceived(truck, task) {
      const d = task.draft;
      const item = this.items[d.item];
      const daysLeft = daysBetween(this.today(), d.expiry);
      const status = daysLeft < 0 ? 'blocked' : 'available';
      const blockReason = daysLeft < 0 ? 'Expired on arrival' : null;
      const pallet = this.stockPallet('DOCK-IN', {
        sscc: d.sscc, itemNo: item.itemNo, batch: d.batch, expiry: d.expiry, qty: d.qty, status, blockReason,
      });
      const delivery = this.deliveries[task.deliveryId];
      delivery.received.push(pallet.sscc);
      pallet.deliveryId = delivery.id;
      truck.stats.received++;
      truck.stats.receiveInputs += d.inputs || 0;
      task.draft = {};
      this._newTask({ type: 'PUTAWAY', category: item.category, sscc: pallet.sscc, from: 'DOCK-IN', to: null });
      const state = this.shipState(pallet);
      const note = state === 'blocked' ? ` — BLOCKED: ${blockReason}`
        : state === 'short' ? ` — short date: ${daysLeft} days left, minimum to ship is ${item.minShipDays}` : '';
      this.log(`${truck.id} received …${pallet.sscc.slice(-6)} ${item.itemNo} batch ${pallet.batch}${note}`, { truckId: truck.id, taskId: task.id });
      const count = `${delivery.received.length} of ${delivery.expected}`;
      if (delivery.received.length >= delivery.expected) {
        this._closeDelivery(truck, task);
        return this._say(truck, state === 'ok', `Pallet ${count} registered${note}. Delivery complete`);
      }
      return this._say(truck, state === 'ok', `Pallet ${count} registered${note}. Next pallet`);
    }

    _closeDelivery(truck, task) {
      const delivery = this.deliveries[task.deliveryId];
      delivery.status = 'received';
      const short = delivery.expected - delivery.received.length;
      this._finish(truck, task);
      if (short > 0) this.log(`Delivery ${delivery.id} closed ${short} pallet(s) short`);
      this._say(truck, true, `Delivery ${delivery.id} closed${short > 0 ? `, ${short} short` : ''}`);
      this.dispatch();
    }

    // Receiving job handed back mid-delivery: keep what's registered, drop the half-scanned pallet.
    _parkReceive(task) {
      task.draft = {};
      this._unassign(task);
    }

    // ---- Internals: driver-started work -------------------------------------

    // Idle driver scans a pallet or rack location: take its waiting job, or start an Auto-Shift.
    /** Auto, no job on the handheld: a pallet (or a rack location) scan decides what to do with it; anything else is a stock check. */
    _startFromScan(truck, input) {
      const gs1 = GS1.parse(input);
      const code = (gs1 && gs1.sscc) || this.resolve(input, { cell: this.cellOfLocation(truck.position) });
      if (this.pallets[code]) return this._unexpectedPallet(truck, this.pallets[code], null, 'pallet');
      const loc = this.locations[code];
      if (loc && loc.kind === 'rack' && loc.sscc) return this._unexpectedPallet(truck, this.pallets[loc.sscc], null, 'location');
      const info = this.lookup(input);
      if (info) return this._say(truck, true, info.text);
      return this._fail(truck, `${code} is not a location, pallet or item`);
    }

    /**
     * Auto: the driver scanned a pallet the handheld wasn't asking for.
     * - It has a job this truck can do: pick it (the current job goes back to the queue).
     * - It needs moving and has no job (wrong category, or waiting at the dock): relocate it.
     * - Otherwise the truck stays empty and holds it: the next location scan
     *   records where it really stands (a correction transfer); scanning it
     *   again moves it (Auto-Shift).
     */
    _unexpectedPallet(truck, pallet, current, via) {
      const short = `…${pallet.sscc.slice(-6)}`;
      if (pallet.status === 'shipped') return this._fail(truck, `${short} was shipped. Check the label`);
      const info = this._palletLookup(pallet);
      const live = this._liveTaskFor(pallet.sscc);
      const category = this.items[pallet.itemNo].category;
      const mine = !truck.categories || truck.categories.includes(category);
      const loc = pallet.loc && this.locations[pallet.loc];
      const liftable = mine && loc && pallet.status !== 'missing' && (loc.kind !== 'block' || this._reachable(pallet))
        && !(loc.kind === 'rack' && loc.aisle !== this.occupiedAisle(truck) && this._capacityLeft(loc.aisle, truck.id) <= 0);

      if (live && live.status === 'active') return this._say(truck, false, `${info.text}\nThat's job #${live.id} on ${live.truckId}`);
      if (liftable && live && live.status === 'open' && live.type !== 'CHECK' && this.config.enabled[live.type] && this._truckTakes(truck, live)) {
        return this._takeInstead(truck, live, current, 'Pick it');
      }
      if (liftable && !live) {
        let task = null;
        if (loc.kind === 'lane' && loc.role === 'in') {
          task = this._newTask({ type: 'PUTAWAY', category, sscc: pallet.sscc, from: loc.code, to: null });
        } else if ((loc.kind === 'rack' || loc.kind === 'block') && loc.category && loc.category !== category && this.config.enabled.SHIFT) {
          task = this._newTask({ type: 'SHIFT', reason: 'template', sscc: pallet.sscc, from: loc.code, to: null, category });
        }
        if (task) return this._takeInstead(truck, task, current, task.type === 'PUTAWAY' ? 'Put it away' : 'Relocate it', { fresh: true });
      }
      // Stay empty and wait for the location scan.
      truck.pendingSscc = pallet.sscc;
      truck.pendingVia = via;
      const how = via === 'location'
        ? 'Scan it again to move it'
        : pallet.status === 'missing' ? 'Scan the location it stands at to put it back on the map' : 'Scan the location it stands at to correct it, or scan it again to move it';
      return this._say(truck, true, `${info.text}\n${how}${current ? `. Job #${current.id} is still yours` : ''}`);
    }

    /** Give the truck this pallet's job and count it as picked up; the job it had goes back to the queue. */
    _takeInstead(truck, task, current, verb, { fresh = false } = {}) {
      truck.pendingSscc = null;
      if (current) this._unassign(current);
      if (!this._assign(truck, task)) {
        if (fresh) this._cancelQuiet(task);
        if (current) this._assign(truck, current);
        return this._fail(truck, `No free ${this.categories[task.category]} slot for …${task.sscc.slice(-6)}`);
      }
      task.inputs = 1;
      this._pickUp(truck, task);
      const back = current ? `. Job #${current.id} went back to the queue` : '';
      return this._say(truck, true, `${verb}: job #${task.id} ${TASK_TYPES[task.type].short}. Take it to ${task.to}${back}`);
    }

    /** The scan after a held pallet: its location (correction transfer), or the pallet again (move it). */
    _pendingScan(truck, input, task) {
      const pallet = this.pallets[truck.pendingSscc];
      const via = truck.pendingVia;
      truck.pendingSscc = null;
      if (!pallet || pallet.status === 'shipped' || (task && task.step > 0)) return null;
      const gs1 = GS1.parse(input);
      const code = (gs1 && gs1.sscc) || this.resolve(input, { cell: this.cellOfLocation(truck.position) });
      if (code === pallet.sscc || (via === 'location' && code === pallet.loc)) return this._driverMove(truck, pallet, task);
      if (via === 'pallet' && this.locations[code]) {
        const r = this.transferPallet(pallet.sscc, code, { by: truck.id });
        if (r.ok) { truck.stats.moves++; truck.stats.moveInputs += 2; }
        const t = truck.taskId && this.tasks[truck.taskId];
        return this._say(truck, r.ok, `${r.text}${t ? `. Back to job #${t.id}: ${TASK_TYPES[t.type].short} at ${t.from}` : ''}`);
      }
      return null; // something else: the hold is dropped and the scan counts as usual
    }

    /** A coordinator-style button on the handheld for a held pallet: move it, or let it go. */
    pendingAction(truckId, action) {
      const truck = this._truck(truckId);
      const pallet = truck.pendingSscc && this.pallets[truck.pendingSscc];
      if (!pallet) return this._fail(truck, 'No pallet held');
      truck.pendingSscc = null;
      truck.stats.taps++;
      if (action === 'cancel') return this._say(truck, true, 'OK');
      if (action !== 'move') throw new Error(`Unknown action ${action}`);
      const task = truck.taskId && this.tasks[truck.taskId];
      return this._driverMove(truck, pallet, task && task.step === 0 ? task : null);
    }

    /** The driver wants this pallet moved: its own job if it has one, otherwise an Auto-Shift to a slot the system picks. */
    _driverMove(truck, pallet, current) {
      const loc = pallet.loc && this.locations[pallet.loc];
      if (!loc || loc.kind !== 'rack') return this._fail(truck, 'That pallet is not in the racking');
      if (loc.blocked) return this._fail(truck, `${loc.code} is blocked`);
      if (loc.aisle !== this.occupiedAisle(truck) && this._capacityLeft(loc.aisle, truck.id) <= 0) {
        return this._fail(truck, `Aisle ${loc.aisle} is full (${this.config.aisleCap}/${this.config.aisleCap})`);
      }
      const category = this.items[pallet.itemNo].category;
      if (truck.categories && !truck.categories.includes(category)) {
        return this._fail(truck, `That is ${this.categories[category]} — not one of your categories`);
      }
      const existing = this._liveTaskFor(pallet.sscc);
      if (existing) {
        if (existing.status !== 'open') return this._fail(truck, `That pallet has job #${existing.id} (${existing.truckId || 'held'})`);
        if (!this.config.enabled[existing.type]) return this._fail(truck, `${TASK_TYPES[existing.type].label} is switched off by the coordinator`);
        if (!this._truckTakes(truck, existing)) return this._fail(truck, `That pallet has a ${TASK_TYPES[existing.type].label} job`);
        return this._takeInstead(truck, existing, current, 'Took it');
      }
      if (!this.config.enabled.SHIFT) return this._fail(truck, 'Auto-Shift is switched off by the coordinator');
      if (pallet.orderId) return this._fail(truck, `That pallet is for order ${pallet.orderId}`);
      const task = this._newTask({ type: 'SHIFT', reason: 'driver', sscc: pallet.sscc, from: loc.code, to: null, category });
      if (!this._reserveSlot(task)) {
        task.status = 'cancelled';
        return this._fail(truck, `No free ${this.categories[category]} slot for this pallet`);
      }
      this.log(`${truck.id} started Auto-Shift #${task.id} from ${loc.code}`, { truckId: truck.id, taskId: task.id });
      if (current) this._unassign(current);
      this._assign(truck, task);
      task.inputs = 2;
      this._pickUp(truck, task);
      return this._say(truck, true, `Auto-Shift: take it to ${task.to}${current ? `. Job #${current.id} went back to the queue` : ''}`);
    }

    _overrideProblem(truck, task, code) {
      if (!task.autoSlot || !this.config.allowSlotOverride) return `Wrong location. Drop at ${task.to}`;
      const loc = this.locations[code];
      const pallet = this.pallets[task.sscc];
      const blockItem = this.items[pallet.itemNo].storage === 'block';
      if (loc && (loc.kind === 'block') !== blockItem && (loc.kind === 'block' || loc.kind === 'rack')) {
        return `${blockItem ? 'Crate pallets go in the block stacks' : 'This pallet goes in the racking'}. Drop at ${task.to}`;
      }
      if (loc && loc.kind === 'block') {
        if (loc.category !== this.items[pallet.itemNo].category) return `Wrong category lane. Drop at ${task.to}`;
        if (this._blockStacks(loc.lane).some((st) => st.blocked || (st.reservedBy && st.reservedBy !== task.id))) return `${loc.lane} is in use. Drop at ${task.to}`;
        if (this._blockTarget(loc.lane) !== loc || !this._laneFit(loc.lane, pallet).ok) return `Not that stack. Drop at ${task.to}`;
        return null;
      }
      if (!loc || loc.kind !== 'rack') return `Not a rack location. Drop at ${task.to}`;
      if (loc.sscc || (loc.reservedBy && loc.reservedBy !== task.id)) return `${code} is taken. Drop at ${task.to}`;
      if (loc.blocked) return `${code} is blocked. Drop at ${task.to}`;
      const cat = this.items[pallet.itemNo].category;
      if (loc.category !== cat) return `${code} is not a ${this.categories[cat]} location. Drop at ${task.to}`;
      if (task.ground && loc.level !== 0) return `This pallet goes on the ground. Drop at ${task.to}`;
      if (loc.aisle !== this._aisle(task.to) && this._capacityLeft(loc.aisle, truck.id) <= 0) return `Aisle ${loc.aisle} is full. Drop at ${task.to}`;
      return null;
    }

    // ---- Internals: slotting --------------------------------------------------

    _slotFree(loc, pallet) {
      return loc.kind === 'rack' && !loc.sscc && !loc.blocked && !loc.reservedBy
        && loc.category === this.items[pallet.itemNo].category;
    }

    /**
     * Best free slot for a pallet. In order of weight: same item/batch/expiry
     * in the same bay level, then the right height (ground for what ships
     * next, high for blocked stock and later batches), then travel distance.
     */
    _findSlot(pallet, origin, { ground = false, noBury = false } = {}) {
      if (!pallet) return null;
      if (this.items[pallet.itemNo].storage === 'block') return this._findBlockSlot(pallet, origin, { noBury });
      const top = this.layout.levels - 1;
      const nextOut = this.config.groundNextPerItem > 0
        && this._fefo(pallet.itemNo)
          .concat(this.shipState(pallet) === 'ok' && !this._isRacked(pallet) ? [pallet] : [])
          .sort((a, b) => (a.expiry < b.expiry ? -1 : a.expiry > b.expiry ? 1 : 0) || a.receivedAt - b.receivedAt)
          .slice(0, this.config.groundNextPerItem)
          .includes(pallet);
      let best = null;
      let bestScore = Infinity;
      for (const loc of this._racks()) {
        if (!this._slotFree(loc, pallet) || loc.code === origin) continue;
        if (ground && loc.level !== 0) continue;
        let score = this.travel(origin, loc.code) * 10;
        for (const n of this._bayLevel(loc)) {
          if (!n.sscc || n === loc) continue;
          const other = this.pallets[n.sscc];
          if (this._batchKey(other) === this._batchKey(pallet)) score -= 2000;
          else if (other.itemNo === pallet.itemNo) score -= 500;
          else score += 200;
        }
        if (this.shipState(pallet) !== 'ok') score += (top - loc.level) * 300;
        else if (ground || nextOut) score += loc.level * 300;
        else if (loc.level === 0) score += 400; // keep the ground free for what ships next
        if (this._capacityLeft(loc.aisle, null) <= 0 && loc.aisle !== this._aisle(origin)) score += 10000;
        if (score < bestScore) { best = loc; bestScore = score; }
      }
      return best;
    }

    // ---- Internals: block stacking ---------------------------------------------

    _blockStacks(lane) {
      const out = [];
      for (const loc of Object.values(this.locations)) if (loc.kind === 'block' && loc.lane === lane) out.push(loc);
      return out.sort((a, b) => a.stack - b.stack);
    }

    /** Pallets in the order they can come out: front stack top-down, then the next stack. */
    _blockSeq(lane) {
      const seq = [];
      for (const st of this._blockStacks(lane)) for (let i = st.pallets.length - 1; i >= 0; i--) seq.push(st.pallets[i]);
      return seq;
    }

    /** Can a truck lift this pallet right now? Racks and lanes always; a block only from the top of the front stack. */
    _reachable(pallet) {
      const loc = pallet && pallet.loc && this.locations[pallet.loc];
      if (!loc || loc.kind !== 'block') return Boolean(loc);
      return this._blockSeq(loc.lane)[0] === pallet.sscc;
    }

    /** Where the next pallet goes in a lane: on the front-most stack if it has room, else the one in front of it. */
    _blockTarget(lane) {
      const stacks = this._blockStacks(lane);
      const f = stacks.findIndex((s) => s.pallets.length);
      if (f === -1) return stacks[stacks.length - 1]; // empty lane: start at the back
      if (stacks[f].pallets.length < stacks[f].height) return stacks[f];
      return f > 0 ? stacks[f - 1] : null;
    }

    /** The stack the next pallet goes on in a block lane (for loading opening stock). */
    nextBlockSpot(lane) {
      const t = this._blockTarget(lane);
      return t ? t.code : null;
    }

    /** Batches in a lane, front (next out) first: [{ key, itemNo, batch, expiry, count }]. */
    laneBatches(lane) {
      const out = [];
      for (const s of this._blockSeq(lane)) {
        const p = this.pallets[s];
        const key = this._batchKey(p);
        let b = out.find((x) => x.key === key);
        if (!b) out.push((b = { key, itemNo: p.itemNo, batch: p.batch, expiry: p.expiry, count: 0 }));
        b.count++;
      }
      return out;
    }

    /**
     * Can this pallet go on the front of a lane? One item per lane, up to
     * blockLaneBatches batches. Going in front of a batch with an earlier
     * best-before buries it: allowed, but only when nothing better is free.
     */
    _laneFit(lane, pallet) {
      const batches = this.laneBatches(lane);
      if (!batches.length) return { ok: true, score: 0, buries: false };
      if (batches.some((b) => b.itemNo !== pallet.itemNo)) return { ok: false };
      const key = this._batchKey(pallet);
      if (batches[0].key === key) return { ok: true, score: -2000, buries: false };
      if (!batches.some((b) => b.key === key) && batches.length >= this.config.blockLaneBatches) return { ok: false };
      const buries = batches.some((b) => b.expiry < pallet.expiry);
      return { ok: true, score: buries ? 1500 : -1000, buries };
    }

    /** Lanes where a batch with an earlier best-before stands behind a later one. */
    buriedLanes() {
      const out = [];
      for (const lane of this.layout.blocks) {
        const bs = this.laneBatches(lane);
        for (let i = 1; i < bs.length; i++) {
          const blocker = bs.slice(0, i).find((b) => b.expiry > bs[i].expiry);
          if (blocker) out.push({ lane, buried: bs[i], blocker });
        }
      }
      return out;
    }

    /**
     * Same batch first, then a lane where the new batch ships first anyway,
     * then an empty lane; burying older stock only as a last resort.
     */
    _findBlockSlot(pallet, origin, { noBury = false } = {}) {
      const cat = this.items[pallet.itemNo].category;
      const fromLane = this.locations[origin] && this.locations[origin].lane; // never back into its own lane
      let best = null;
      let bestScore = Infinity;
      let sameBatchBusy = false;
      for (const lane of this.layout.blocks) {
        const stacks = this._blockStacks(lane);
        if (stacks[0].category !== cat || lane === fromLane) continue;
        if (stacks.some((s) => s.blocked || s.reservedBy)) {
          // Another put-away of this batch is under way in this lane: wait for it rather than open a new lane.
          const res = stacks.find((s) => s.reservedBy);
          const other = res && this.tasks[res.reservedBy];
          if (other && other.sscc && this._batchKey(this.pallets[other.sscc]) === this._batchKey(pallet)) sameBatchBusy = true;
          continue;
        }
        const fit = this._laneFit(lane, pallet);
        if (!fit.ok || (noBury && fit.buries)) continue;
        const target = this._blockTarget(lane);
        if (!target) continue;
        let score = this.travel(origin, target.code) * 10 + fit.score;
        if (this._capacityLeft(lane, null) <= 0) score += 10000;
        if (score < bestScore) { best = target; bestScore = score; }
      }
      if (sameBatchBusy && best && this._laneFit(best.lane, pallet).score > -2000) return null;
      return best;
    }

    _reserveSlot(task) {
      const slot = this._findSlot(this.pallets[task.sscc], task.from, { ground: task.ground, noBury: task.noBury });
      if (!slot) return false;
      slot.reservedBy = task.id;
      task.to = slot.code;
      return true;
    }

    _moveSlot(task, code) {
      this._releaseSlot(task);
      this.locations[code].reservedBy = task.id;
      task.to = code;
    }

    _releaseSlot(task) {
      if (!task.to) return;
      const loc = this.locations[task.to];
      if (loc && loc.reservedBy === task.id) loc.reservedBy = null;
      if (task.autoSlot) task.to = null;
    }

    _capacityLeft(aisle, exceptTruckId) {
      if (!aisle) return Infinity;
      let used = 0;
      for (const truck of Object.values(this.trucks)) {
        if (truck.id !== exceptTruckId && this.occupiedAisle(truck) === aisle) used++;
      }
      return this.capOf(aisle) - used;
    }

    /** Trucks allowed at once: racking aisles use the aisle limit, block lanes their own. */
    capOf(aisle) {
      return this.layout.blocks.includes(aisle) ? this.config.blockLaneCap : this.config.aisleCap;
    }

    /** The aisle (or block lane) a location is in; null for docks, lanes and stations. */
    _aisle(code) {
      const loc = code && this.locations[code];
      return loc ? loc.aisle || null : null;
    }

    // ---- Internals: helpers ---------------------------------------------------

    _place(pallet, code) {
      const loc = this.locations[code];
      if (loc.kind === 'rack') loc.sscc = pallet.sscc;
      else loc.pallets.push(pallet.sscc);
      pallet.loc = code;
    }

    _remove(pallet) {
      const loc = pallet.loc && this.locations[pallet.loc];
      if (!loc) return;
      if (loc.kind === 'rack') loc.sscc = null;
      else loc.pallets.splice(loc.pallets.indexOf(pallet.sscc), 1);
      pallet.loc = null;
    }

    /** Readable name for a location: rack and block codes as they are, stations by name. */
    _placeName(code) {
      const loc = this.locations[code];
      return loc && loc.kind === 'station' ? this.stations[loc.station].name : code;
    }

    _isRacked(pallet) {
      return Boolean(pallet.loc && this.locations[pallet.loc].kind === 'rack');
    }

    _batchKey(p) { return `${p.itemNo}|${p.batch}|${p.expiry}`; }

    _bayLevelKey(loc) { return `${loc.aisle}-${loc.bay}-${loc.level}`; }

    _bayLevel(loc) {
      const out = [];
      for (const p of this.layout.positions) out.push(this.locations[rackCode(loc.aisle, loc.bay, loc.level, p)]);
      return out;
    }

    _racks() {
      if (!this._rackList) this._rackList = Object.values(this.locations).filter((l) => l.kind === 'rack');
      return this._rackList;
    }

    _isLive(t) {
      return LIVE.has(t.status) && !(t.status === 'held' && t.replacedBy);
    }

    _liveTaskFor(sscc) {
      return Object.values(this.tasks).find((t) => t.sscc === sscc && this._isLive(t)) || null;
    }

    _liveMap() {
      const map = new Map();
      for (const t of Object.values(this.tasks)) if (t.sscc && this._isLive(t)) map.set(t.sscc, t);
      return map;
    }

    _say(truck, ok, text) {
      truck.message = { ok, text };
      return truck.message;
    }

    _fail(truck, text) {
      truck.stats.wrongScans++;
      return this._say(truck, false, text);
    }

    _loc(code) {
      const loc = this.locations[code];
      if (!loc) throw new Error(`${code} is not a location`);
      return loc;
    }

    _pallet(sscc) {
      const p = this.pallets[sscc];
      if (!p) throw new Error(`No pallet ${sscc}`);
      return p;
    }

    _task(id) {
      const task = this.tasks[id];
      if (!task) throw new Error(`No job #${id}`);
      return task;
    }

    _truck(id) {
      const truck = this.trucks[id] || this.desks[id];
      if (!truck) throw new Error(`No truck ${id}`);
      return truck;
    }
  }

  return {
    Warehouse, CATEGORIES, TASK_TYPES, TRUCK_MODES, SHIFT_REASONS, RECEIVE_FIELDS, FIELD_LABELS, DEFAULT_CONFIG, DESK_CALLOUTS,
    parseRack, rackCode, aisleOf, depthOf, parseDate, daysBetween,
  };
});
