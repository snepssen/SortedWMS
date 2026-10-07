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
    CHECK: { label: 'Check & label', short: 'Check' },
    RECEIVE: { label: 'Receiving', short: 'Receive' },
    PUTAWAY: { label: 'Put-away', short: 'Put-away' },
    SHIFT: { label: 'Auto-Shift', short: 'Shift' },
  };

  const TRUCK_MODES = {
    auto: { label: 'Auto', types: null },
    shift: { label: 'Auto-Shift only', types: ['SHIFT'] },
    paused: { label: 'Paused', types: [] },
  };

  const SHIFT_REASONS = {
    template: 'Location template changed',
    ground: 'Ships next: to ground level',
    group: 'Same batch together',
    driver: 'Started by driver',
  };

  // Receiving asks for these in this order. A GS1 label scan can fill several at once.
  const RECEIVE_FIELDS = ['batch', 'expiry', 'item', 'sscc', 'qty'];
  const FIELD_LABELS = { batch: 'Batch', expiry: 'Expiry date', item: 'Item number', sscc: 'Pallet SSCC', qty: 'Quantity' };

  const DEFAULT_CONFIG = {
    priority: ['PICK', 'CHECK', 'RECEIVE', 'PUTAWAY', 'SHIFT'],
    enabled: { PICK: true, CHECK: true, RECEIVE: true, PUTAWAY: true, SHIFT: true },
    aisleCap: 2,
    escalateAfterMin: 20, // a job waiting this long jumps the queue; 0 = never
    travelOptimise: true, // same priority: nearest job first
    allowSlotOverride: true, // Auto-Shift/put-away: driver may scan another suitable free slot
    groundNextPerItem: 1, // keep the next N pallets out of every item on ground level; 0 = off
    checkAfterPick: true, // picked pallets get a check & label job
    oneWay: false, // route trucks with the one-way signs in the aisles
  };

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
    constructor({ aisles = 8, bays = 20, levels = 5, positions = [10, 40, 70], outLanes = 4, clock, config } = {}) {
      this.clock = clock || (() => Date.now());
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
      this._seq = { task: 0, sscc: 0, label: 0 };
      this.ssccPrefix = '9990000'; // stand-in GS1 company prefix for SSCCs printed here

      this.locations['DOCK-IN'] = { code: 'DOCK-IN', kind: 'lane', role: 'in', aisle: null, pallets: [], blocked: false };
      for (let i = 1; i <= outLanes; i++) {
        const code = `OUT-${pad(i, 2)}`;
        this.locations[code] = { code, kind: 'lane', role: 'out', aisle: null, pallets: [], blocked: false, printer: `LP-${code}` };
      }
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

    // Lanes and docks are at the front, left of the first aisle.
    _point(code) {
      const r = parseRack(code);
      if (!r) return { i: -1, d: 0, aisle: null };
      return { i: this.layout.aisles.indexOf(r.aisle), d: depthOf(r.bay), aisle: r.aisle };
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
      if (!a || !this.config.oneWay) return null;
      const p = this._point(truck.position);
      if (p.aisle === a) {
        const q = this._point(code);
        const ahead = this.aisleDir[a] === 'front' ? q.d >= p.d : q.d <= p.d;
        if (ahead) return null;
      }
      return this.aisleDir[a];
    }

    // ---- Master data --------------------------------------------------------

    addItem({ itemNo, gtin, name, category, palletQty, minShipDays = 0 }) {
      if (!CATEGORIES[category]) throw new Error(`Unknown category ${category}`);
      if (this.items[itemNo]) throw new Error(`Item ${itemNo} already exists`);
      if (gtin && !GS1.isValidGtin(gtin)) throw new Error(`GTIN ${gtin} has a wrong check digit`);
      this.items[itemNo] = { itemNo, gtin: gtin ? GS1.gtin14(gtin) : null, name, category, palletQty, minShipDays };
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
     * Pallets that no longer match get relocation jobs (Auto-Shift).
     */
    setLocationCategory({ aisle, bayFrom = 1, bayTo = this.layout.bays, levels = null }, category) {
      if (category !== null && !CATEGORIES[category]) throw new Error(`Unknown category ${category}`);
      const a = pad(aisle, 2);
      let changed = 0;
      for (const loc of this._racks()) {
        if (loc.aisle !== a || loc.bay < bayFrom || loc.bay > bayTo) continue;
        if (levels && !levels.includes(loc.level)) continue;
        if (loc.category !== category) {
          loc.category = category;
          changed++;
        }
      }
      if (changed) {
        this.log(`Template: aisle ${a} bays ${bayFrom}–${bayTo} → ${category ? CATEGORIES[category] : 'no category'} (${changed} locations)`);
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
      this.log(`${truck.id} works ${truck.categories ? truck.categories.map((c) => CATEGORIES[c]).join(' + ') : 'every category'}`);
      this.dispatch();
    }

    setTruckMode(truckId, mode) {
      if (!TRUCK_MODES[mode]) throw new Error(`Unknown mode ${mode}`);
      const truck = this._truck(truckId);
      if (truck.mode === mode) return;
      const task = truck.taskId && this.tasks[truck.taskId];
      if (task) {
        if (truck.load) throw new Error(`${truck.id} is carrying a pallet — drop it before changing mode`);
        const allowed = TRUCK_MODES[mode].types;
        if (allowed && !allowed.includes(task.type)) {
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
        const l = { itemNo: line.itemNo, pallets: line.pallets, allocated: [], short: 0 };
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
      for (const sscc of order.lines.flatMap((l) => l.allocated)) {
        const p = this.pallets[sscc];
        this._remove(p);
        p.status = 'shipped';
      }
      order.status = 'shipped';
      this.log(`Order ${id} loaded and shipped`);
    }

    // ---- Receiving ----------------------------------------------------------

    /**
     * Announce a delivery at the receiving dock; creates one receiving job.
     * `list` is the supplier's pallet list (SSCC, item, batch, expiry, qty),
     * when there is one: then scanning the SSCC alone registers the pallet.
     */
    addDelivery({ id, supplier, category, pallets, list = null }) {
      if (this.deliveries[id]) throw new Error(`Delivery ${id} already exists`);
      if (!CATEGORIES[category]) throw new Error(`Unknown category ${category}`);
      const byS = list ? Object.fromEntries(list.map((l) => [l.sscc, l])) : null;
      const delivery = { id, supplier, category, expected: pallets || (list ? list.length : 0), received: [], list: byS, createdAt: this.now(), status: 'open' };
      this.deliveries[id] = delivery;
      const task = this._newTask({ type: 'RECEIVE', category, from: 'DOCK-IN', to: 'DOCK-IN', deliveryId: id });
      task.draft = {};
      this.log(`Delivery ${id} from ${supplier}: ${pallets} pallets of ${CATEGORIES[category]}`, { taskId: task.id });
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
      if (!task) return this._startFromScan(truck, input);
      if (task.type === 'RECEIVE') task.draft.inputs = (task.draft.inputs || 0) + 1;
      else task.inputs++;
      if (task.type === 'RECEIVE') return this._receiveScan(truck, task, input);
      if (task.type === 'CHECK') return this._checkScan(truck, task, input);

      const label = GS1.parse(input);
      const code = (label && label.sscc) || input.toUpperCase();
      if (task.step === 0) {
        const r = this._matchPickup(truck, task, code);
        if (!r.ok) return this._fail(truck, r.text);
        this._pickUp(truck, task);
        if (truck.waiting) return this._say(truck, true, `${r.text}Aisle ${aisleOf(task.to)} is full — wait at the entry`);
        return this._say(truck, true, `${r.text}Take it to ${task.to}`);
      }

      if (truck.waiting) {
        const cap = this.config.aisleCap;
        return this._fail(truck, `Aisle ${aisleOf(task.to)} is full (${cap}/${cap}) — wait at the entry`);
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
            truck.waiting = aisleOf(task.to) !== aisleOf(place) && this._capacityLeft(aisleOf(task.to), truck.id) <= 0;
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
      const waiting = Object.values(this.trucks).filter((t) => t.waiting).sort((a, b) => a.waitingSince - b.waitingSince);
      for (const truck of waiting) {
        const task = this.tasks[truck.taskId];
        if (this._capacityLeft(aisleOf(task.to), truck.id) > 0) {
          truck.waiting = false;
          truck.waitingSince = null;
          this._say(truck, true, `Aisle ${aisleOf(task.to)} clear. Go to ${task.to}`);
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
        if (this.locations[t.from].blocked) return false;
        if (t.to && this.locations[t.to].blocked) return false;
        return this._capacityLeft(aisleOf(t.from), truck.id) > 0;
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
      return candidates.find((t) => this._slotAvailable(t)) || null;
    }

    _slotAvailable(t) {
      if (t.autoSlot) return Boolean(t.to || this._findSlot(this.pallets[t.sscc], t.from, { ground: t.ground }));
      const to = this.locations[t.to];
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
      return aisleOf(task.step === 0 ? task.from : task.to);
    }

    /** What the handheld should show. */
    instruction(truckId) {
      const truck = this._truck(truckId);
      if (truck.mode === 'paused') return { kind: 'paused' };
      if (!truck.taskId) return { kind: 'idle' };
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
      if (truck.waiting) return { kind: 'wait', task, pallet, aisle: aisleOf(task.to), target: task.to };
      return task.step === 0
        ? { kind: 'pickup', task, pallet, target: task.from }
        : { kind: 'drop', task, pallet, target: task.to };
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
      const truck = this.trucks[task.truckId];
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
      const scanned = this.pallets[code];
      // Pick: another pallet of the same item, batch and expiry is just as good.
      if (task.type === 'PICK' && scanned && this._batchKey(scanned) === this._batchKey(pallet)) {
        const why = this._swapProblem(scanned, truck, task);
        if (why) return { ok: false, text: why };
        this._swapPick(task, scanned);
        return { ok: true, text: 'Same batch, swapped. ' };
      }
      if (fromLoc.kind === 'lane') return { ok: false, text: `Scan the pallet label ending …${task.sscc.slice(-6)} at ${task.from}` };
      return { ok: false, text: `Wrong pallet. Go to ${task.from}` };
    }

    _swapProblem(p, truck, task) {
      const loc = this.locations[p.loc];
      if (!loc || loc.kind !== 'rack') return 'That pallet is not in a rack location';
      if (this.shipState(p) !== 'ok') return `That pallet can't ship (${p.blockReason || 'too short-dated'})`;
      if (p.orderId) return `That pallet is for order ${p.orderId}`;
      if (loc.blocked) return `${loc.code} is blocked`;
      if (this._capacityLeft(loc.aisle, truck.id) <= 0 && loc.aisle !== aisleOf(task.from)) return `Aisle ${loc.aisle} is full`;
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
      truck.waiting = aisleOf(task.to) !== aisleOf(task.from) && this._capacityLeft(aisleOf(task.to), truck.id) <= 0;
      truck.waitingSince = truck.waiting ? this.now() : null;
      if (truck.waiting) this.log(`${truck.id} waiting: aisle ${aisleOf(task.to)} full`, { truckId: truck.id, taskId: task.id });
      this.dispatch();
    }

    _drop(truck, task) {
      const pallet = this.pallets[truck.load];
      const to = this.locations[task.to];
      if (to.kind === 'rack') to.reservedBy = null;
      this._place(pallet, task.to);
      truck.load = null;
      truck.position = task.to;
      task.alert = null;
      this._finish(truck, task);
      if (task.type === 'PICK') this._picked(task, pallet);
      if (task.type === 'PUTAWAY' || task.type === 'SHIFT') this.planGround();
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
      return this._newTask({ type: 'PICK', category: this.items[pallet.itemNo].category, sscc: pallet.sscc, from: pallet.loc, to: order.lane, orderId: order.id });
    }

    _replacePick(task) {
      const order = this.orders[task.orderId];
      const old = this.pallets[task.sscc];
      const line = order.lines.find((l) => l.allocated.includes(old.sscc));
      line.allocated.splice(line.allocated.indexOf(old.sscc), 1);
      old.orderId = null;
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
      return this._fefo(itemNo).find((p) => this.locations[p.loc].kind === 'rack') || null;
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
      return Object.values(this.pallets)
        .filter((p) => {
          if (p.itemNo !== itemNo || !p.loc || p.orderId || this.shipState(p) !== 'ok') return false;
          const loc = this.locations[p.loc];
          if (loc.kind !== 'rack' || loc.blocked) return false;
          const t = live.get(p.sscc);
          return !t || (t.type === 'SHIFT' && t.status === 'open');
        })
        .sort((a, b) => (a.expiry < b.expiry ? -1 : a.expiry > b.expiry ? 1 : 0)
          || a.receivedAt - b.receivedAt
          || this.locations[a.loc].level - this.locations[b.loc].level
          || (a.loc < b.loc ? -1 : 1));
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
      const delivery = this.deliveries[task.deliveryId];
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
    _startFromScan(truck, input) {
      const code = input.toUpperCase();
      const gs1 = GS1.parse(code);
      let pallet = this.pallets[(gs1 && gs1.sscc) || code];
      if (!pallet) {
        const loc = this.locations[code];
        if (!loc) return this._fail(truck, `${code} is not a location or a pallet in stock`);
        if (loc.kind !== 'rack') return this._fail(truck, 'Scan a pallet in the racking to start an Auto-Shift');
        if (!loc.sscc) return this._fail(truck, `${code} is empty`);
        pallet = this.pallets[loc.sscc];
      }
      const loc = pallet.loc && this.locations[pallet.loc];
      if (!loc || loc.kind !== 'rack') return this._fail(truck, 'That pallet is not in the racking');
      if (loc.blocked) return this._fail(truck, `${loc.code} is blocked`);
      if (this._capacityLeft(loc.aisle, truck.id) <= 0) {
        return this._fail(truck, `Aisle ${loc.aisle} is full (${this.config.aisleCap}/${this.config.aisleCap})`);
      }
      const category = this.items[pallet.itemNo].category;
      if (truck.categories && !truck.categories.includes(category)) {
        return this._fail(truck, `That is ${CATEGORIES[category]} — not one of your categories`);
      }

      const existing = this._liveTaskFor(pallet.sscc);
      if (existing) {
        if (existing.status !== 'open') return this._fail(truck, `That pallet has job #${existing.id} (${existing.truckId || 'held'})`);
        if (!this.config.enabled[existing.type]) return this._fail(truck, `${TASK_TYPES[existing.type].label} is switched off by the coordinator`);
        if (!this._truckTakes(truck, existing)) return this._fail(truck, `That pallet has a ${TASK_TYPES[existing.type].label} job`);
        if (!this._assign(truck, existing)) return this._fail(truck, 'No free slot for this pallet');
        existing.inputs = 1;
        this._pickUp(truck, existing);
        return this._say(truck, true, `Took job #${existing.id}. Take it to ${existing.to}`);
      }

      if (!this.config.enabled.SHIFT) return this._fail(truck, 'Auto-Shift is switched off by the coordinator');
      if (pallet.orderId) return this._fail(truck, `That pallet is for order ${pallet.orderId}`);
      const task = this._newTask({ type: 'SHIFT', reason: 'driver', sscc: pallet.sscc, from: loc.code, to: null, category });
      if (!this._reserveSlot(task)) {
        task.status = 'cancelled';
        return this._fail(truck, `No free ${CATEGORIES[category]} slot for this pallet`);
      }
      this.log(`${truck.id} started Auto-Shift #${task.id} from ${loc.code}`, { truckId: truck.id, taskId: task.id });
      this._assign(truck, task);
      task.inputs = 1;
      this._pickUp(truck, task);
      return this._say(truck, true, `Auto-Shift: take it to ${task.to}`);
    }

    _overrideProblem(truck, task, code) {
      if (!task.autoSlot || !this.config.allowSlotOverride) return `Wrong location. Drop at ${task.to}`;
      const loc = this.locations[code];
      if (!loc || loc.kind !== 'rack') return `Not a rack location. Drop at ${task.to}`;
      const pallet = this.pallets[task.sscc];
      if (loc.sscc || (loc.reservedBy && loc.reservedBy !== task.id)) return `${code} is taken. Drop at ${task.to}`;
      if (loc.blocked) return `${code} is blocked. Drop at ${task.to}`;
      const cat = this.items[pallet.itemNo].category;
      if (loc.category !== cat) return `${code} is not a ${CATEGORIES[cat]} location. Drop at ${task.to}`;
      if (task.ground && loc.level !== 0) return `This pallet goes on the ground. Drop at ${task.to}`;
      if (loc.aisle !== aisleOf(task.to) && this._capacityLeft(loc.aisle, truck.id) <= 0) return `Aisle ${loc.aisle} is full. Drop at ${task.to}`;
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
    _findSlot(pallet, origin, { ground = false } = {}) {
      if (!pallet) return null;
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
        if (this._capacityLeft(loc.aisle, null) <= 0 && loc.aisle !== aisleOf(origin)) score += 10000;
        if (score < bestScore) { best = loc; bestScore = score; }
      }
      return best;
    }

    _reserveSlot(task) {
      const slot = this._findSlot(this.pallets[task.sscc], task.from, { ground: task.ground });
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
      return this.config.aisleCap - used;
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
      const truck = this.trucks[id];
      if (!truck) throw new Error(`No truck ${id}`);
      return truck;
    }
  }

  return {
    Warehouse, CATEGORIES, TASK_TYPES, TRUCK_MODES, SHIFT_REASONS, RECEIVE_FIELDS, FIELD_LABELS, DEFAULT_CONFIG,
    parseRack, rackCode, aisleOf, depthOf, parseDate, daysBetween,
  };
});
