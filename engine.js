/*
 * SortedWMS dispatch engine.
 *
 * Auto mode: reach trucks are handed their next job the moment they finish
 * the last one, chosen by the priority order the admin sets.
 * Auto-Shift: rack-to-rack moves where the system picks the destination slot.
 * Aisle limit: no more than `aisleCap` trucks inside one aisle at a time.
 *
 * Every job is two scans: scan the pick-up location, scan the drop location.
 * No menus, no Enter presses, no confirmation screens.
 *
 * Runs in the browser (window.SortedWMS) and in Node (require('./engine')).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SortedWMS = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const TASK_TYPES = {
    REPLEN: { label: 'Replenishment', short: 'Replen' },
    PICK: { label: 'Pallet pick', short: 'Pick' },
    PUTAWAY: { label: 'Put-away', short: 'Put-away' },
    SHIFT: { label: 'Auto-Shift', short: 'Shift' },
  };

  // Job types each truck mode may receive.
  const TRUCK_MODES = {
    auto: { label: 'Auto', types: null }, // null = every enabled type
    shift: { label: 'Auto-Shift only', types: ['SHIFT'] },
    paused: { label: 'Paused', types: [] },
  };

  const DEFAULT_CONFIG = {
    priority: ['REPLEN', 'PICK', 'PUTAWAY', 'SHIFT'],
    enabled: { REPLEN: true, PICK: true, PUTAWAY: true, SHIFT: true },
    aisleCap: 2,
    escalateAfterMin: 20, // a job waiting this long jumps to the front; 0 = never
    travelOptimise: true, // within the same priority, send the truck to the nearest job
    allowSlotOverride: true, // driver may drop an Auto-Shift pallet in a different free slot
  };

  // Travel cost of moving across one aisle, measured in bays.
  const AISLE_PITCH = 4;
  const MINUTE = 60000;

  const RACK_RE = /^(\d{2})-(\d{3})-(\d)$/;

  function parseRack(code) {
    const m = RACK_RE.exec(code);
    return m ? { aisle: m[1], bay: Number(m[2]), level: Number(m[3]) } : null;
  }

  function rackCode(aisle, bay, level) {
    return `${String(aisle).padStart(2, '0')}-${String(bay).padStart(3, '0')}-${level}`;
  }

  function aisleOf(code) {
    const r = code && parseRack(code);
    return r ? r.aisle : null;
  }

  // Docks sit at the front of the building, before aisle 01.
  function point(code) {
    const r = parseRack(code);
    return r ? { a: Number(r.aisle), b: r.bay } : { a: 0, b: 0 };
  }

  function distance(fromCode, toCode) {
    const p = point(fromCode);
    const q = point(toCode);
    if (p.a === q.a) return Math.abs(p.b - q.b);
    // Drive out the front of one aisle, along the cross-aisle, into the other.
    return p.b + q.b + Math.abs(p.a - q.a) * AISLE_PITCH;
  }

  class Warehouse {
    constructor({ aisles = 8, bays = 20, levels = 4, clock, config } = {}) {
      this.clock = clock || (() => Date.now());
      this.config = {
        ...DEFAULT_CONFIG,
        ...config,
        enabled: { ...DEFAULT_CONFIG.enabled, ...(config && config.enabled) },
      };
      this.layout = { aisles, bays, levels };
      this.locations = {};
      this.trucks = {};
      this.tasks = {};
      this.events = [];
      this._seq = { task: 0, pallet: 0 };

      for (const code of ['DOCK-IN', 'DOCK-OUT']) {
        this.locations[code] = { code, kind: 'dock', aisle: null, pallet: null, blocked: false, reservedBy: null };
      }
      for (let a = 1; a <= aisles; a++) {
        for (let b = 1; b <= bays; b++) {
          for (let l = 0; l < levels; l++) {
            const code = rackCode(a, b, l);
            this.locations[code] = {
              code,
              kind: l === 0 ? 'pick' : 'reserve', // ground level is the pick face
              aisle: String(a).padStart(2, '0'),
              bay: b,
              level: l,
              pallet: null,
              blocked: false,
              reservedBy: null,
            };
          }
        }
      }
    }

    now() {
      return this.clock();
    }

    log(text, extra = {}) {
      this.events.unshift({ t: this.now(), text, ...extra });
      if (this.events.length > 200) this.events.length = 200;
    }

    // ---- Setup -------------------------------------------------------------

    addPallet(code, { sku, qty }) {
      const loc = this._loc(code);
      if (loc.kind === 'dock') throw new Error(`${code} is a dock, not a rack location`);
      if (loc.pallet) throw new Error(`${code} already holds a pallet`);
      loc.pallet = { id: this._palletId(), sku, qty };
      return loc.pallet;
    }

    addTruck(id, { mode = 'auto', position = 'DOCK-IN' } = {}) {
      if (this.trucks[id]) throw new Error(`Truck ${id} already exists`);
      this.trucks[id] = {
        id,
        mode,
        position,
        taskId: null,
        load: null,
        waiting: false,
        waitingSince: null,
        idleSince: this.now(),
        stats: { jobs: 0, scans: 0, wrongScans: 0 },
        message: null,
      };
      this.dispatch();
      return this.trucks[id];
    }

    // ---- Admin -------------------------------------------------------------

    setConfig(patch) {
      if (patch.priority) {
        const want = Object.keys(TASK_TYPES).sort().join();
        if ([...patch.priority].sort().join() !== want) {
          throw new Error('Priority must list every job type exactly once');
        }
      }
      if (patch.aisleCap !== undefined && !(Number.isInteger(patch.aisleCap) && patch.aisleCap >= 1)) {
        throw new Error('Trucks per aisle must be a whole number of 1 or more');
      }
      this.config = {
        ...this.config,
        ...patch,
        enabled: { ...this.config.enabled, ...(patch.enabled || {}) },
      };
      this.dispatch();
    }

    addTask({ type, from, to = null, sku, qty, urgent = false }) {
      if (!TASK_TYPES[type]) throw new Error(`Unknown job type ${type}`);
      const fromLoc = this._loc(from);
      if (to !== null) this._loc(to);
      if (to === null && !(type === 'PUTAWAY' || type === 'SHIFT')) {
        throw new Error(`${TASK_TYPES[type].label} needs a destination`);
      }
      if (to !== null && to === from) throw new Error('Pick-up and drop location are the same');
      if (to !== null) {
        const toLoc = this.locations[to];
        if (toLoc.kind === 'reserve' && (toLoc.pallet || toLoc.reservedBy)) throw new Error(`${to} is already taken`);
      }

      if (fromLoc.kind === 'dock') {
        if (type !== 'PUTAWAY') throw new Error(`${TASK_TYPES[type].label} must start at a rack location`);
        if (!sku) throw new Error('Put-away from the dock needs a SKU');
      } else {
        if (!fromLoc.pallet) throw new Error(`No pallet at ${from}`);
        const clash = this._liveTasks().find((t) => t.from === from);
        if (clash) throw new Error(`${from} already has job #${clash.id}`);
        sku = fromLoc.pallet.sku;
        qty = fromLoc.pallet.qty;
      }

      const task = {
        id: ++this._seq.task,
        type,
        from,
        to,
        autoSlot: to === null,
        sku,
        qty: qty || 1,
        urgent: Boolean(urgent),
        createdAt: this.now(),
        status: 'open',
        truckId: null,
        step: 0,
        reason: null,
        heldReason: null,
        blockedLoc: null,
      };
      this.tasks[task.id] = task;
      this.log(`Job #${task.id} created: ${TASK_TYPES[type].short} ${from} → ${to || 'auto slot'}`, { taskId: task.id });
      this.dispatch();
      return task;
    }

    setUrgent(taskId, urgent) {
      const task = this._task(taskId);
      task.urgent = Boolean(urgent);
      this.log(`Job #${task.id} ${urgent ? 'marked urgent' : 'no longer urgent'}`, { taskId });
      this.dispatch();
    }

    cancelTask(taskId) {
      const task = this._task(taskId);
      if (task.status === 'done' || task.status === 'cancelled') return;
      if (task.status === 'active') {
        if (task.step === 1) throw new Error(`Job #${task.id} pallet is on a truck — let the driver drop it first`);
        this._unassign(task);
      }
      this._releaseSlot(task);
      task.status = 'cancelled';
      this.log(`Job #${task.id} cancelled`, { taskId });
      this.dispatch();
    }

    // Put a held job back in the queue and unblock the location it reported.
    releaseTask(taskId) {
      const task = this._task(taskId);
      if (task.status !== 'held') return;
      if (task.blockedLoc) this.locations[task.blockedLoc].blocked = false;
      task.status = 'open';
      task.heldReason = null;
      task.blockedLoc = null;
      this.log(`Job #${task.id} released back to the queue`, { taskId });
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

    setTruckMode(truckId, mode) {
      if (!TRUCK_MODES[mode]) throw new Error(`Unknown mode ${mode}`);
      const truck = this._truck(truckId);
      if (truck.mode === mode) return;
      const task = truck.taskId && this.tasks[truck.taskId];
      if (task) {
        if (task.step === 1) throw new Error(`${truck.id} is carrying a pallet — drop it before changing mode`);
        const allowed = TRUCK_MODES[mode].types;
        if (!allowed || allowed.includes(task.type)) {
          // The current job still fits the new mode; keep it.
        } else {
          this._unassign(task);
        }
      }
      truck.mode = mode;
      truck.idleSince = this.now();
      this.log(`${truck.id} set to ${TRUCK_MODES[mode].label}`, { truckId });
      this.dispatch();
    }

    // ---- Driver ------------------------------------------------------------

    /**
     * The only input a driver gives. Returns { ok, message }.
     * A wrong scan changes nothing; the next correct scan simply works.
     */
    scan(truckId, rawCode) {
      const truck = this._truck(truckId);
      const code = String(rawCode).trim().toUpperCase();
      truck.stats.scans++;

      const fail = (message) => {
        truck.stats.wrongScans++;
        truck.message = { ok: false, text: message };
        return truck.message;
      };
      const pass = (message) => {
        truck.message = { ok: true, text: message };
        return truck.message;
      };

      const loc = this.locations[code];
      if (!loc) return fail(`${code} is not a location`);
      if (truck.mode === 'paused') return fail('Truck is paused — resume to take jobs');

      if (!truck.taskId) return this._startFromScan(truck, loc, pass, fail);

      const task = this.tasks[truck.taskId];
      if (task.step === 0) {
        if (code !== task.from) return fail(`Wrong location. Go to ${task.from}`);
        this._pickUp(truck, task);
        if (truck.waiting) return pass(`Picked up. Aisle ${aisleOf(task.to)} is full — wait at the entry`);
        return pass(`Picked up. Take it to ${task.to}`);
      }

      // Step 1: drop.
      if (truck.waiting) {
        return fail(`Aisle ${aisleOf(task.to)} is full (${this.config.aisleCap}/${this.config.aisleCap}) — wait at the entry`);
      }
      if (code !== task.to) {
        const why = this._overrideProblem(truck, task, loc);
        if (why) return fail(why);
        this._moveSlot(task, code);
        this.log(`${truck.id} chose ${code} instead of the suggested slot for job #${task.id}`, { truckId, taskId: task.id });
      }
      this._drop(truck, task);
      const next = truck.taskId ? this.tasks[truck.taskId] : null;
      return pass(next ? `Done. Next: ${next.from}` : 'Done. No jobs waiting');
    }

    reportProblem(truckId, reason) {
      const reasons = { blocked: 'Location blocked', missing: 'Pallet missing', damaged: 'Pallet damaged' };
      if (!reasons[reason]) throw new Error(`Unknown problem ${reason}`);
      const truck = this._truck(truckId);
      const task = truck.taskId && this.tasks[truck.taskId];
      if (!task) throw new Error(`${truck.id} has no job`);

      let place;
      if (task.step === 0) {
        place = task.from;
        this._unassign(task);
      } else {
        if (reason !== 'blocked') throw new Error('The pallet is already on the forks — report the drop location as blocked');
        // Drop location is blocked. If the system chose the slot, choose another.
        place = task.to;
        this.locations[place].blocked = true;
        if (task.autoSlot) {
          this._releaseSlot(task);
          if (this._reserveSlot(task)) {
            this.log(`${truck.id}: ${place} blocked, re-slotted job #${task.id} to ${task.to}`, { truckId, taskId: task.id });
            truck.waiting = aisleOf(task.to) !== aisleOf(place) && this._capacityLeft(aisleOf(task.to), truck.id) <= 0;
            truck.waitingSince = truck.waiting ? this.now() : null;
            truck.message = { ok: false, text: `${place} blocked. New slot: ${task.to}` };
            this.dispatch();
            return truck.message;
          }
          task.to = place; // nowhere else to go; keep the original target
        }
        task.alert = `Drop location ${place} blocked`;
        this.log(`${truck.id} reported ${place} blocked while carrying job #${task.id} — needs the coordinator`, { truckId, taskId: task.id });
        truck.message = { ok: false, text: `${place} blocked. Coordinator alerted — hold the pallet` };
        return truck.message;
      }

      if (reason === 'blocked') this.locations[place].blocked = true;
      task.status = 'held';
      task.heldReason = reasons[reason];
      task.blockedLoc = reason === 'blocked' ? place : null;
      this.log(`${truck.id} reported ${reasons[reason].toLowerCase()} at ${place}; job #${task.id} held`, { truckId, taskId: task.id });
      truck.message = { ok: false, text: `${reasons[reason]} reported. Job held for the coordinator` };
      this.dispatch();
      return truck.message;
    }

    // ---- Dispatch ----------------------------------------------------------

    /** Let waiting trucks into aisles that have room, then hand idle trucks their next job. */
    dispatch() {
      const waiting = Object.values(this.trucks)
        .filter((t) => t.waiting)
        .sort((a, b) => a.waitingSince - b.waitingSince);
      for (const truck of waiting) {
        const task = this.tasks[truck.taskId];
        if (this._capacityLeft(aisleOf(task.to), truck.id) > 0) {
          truck.waiting = false;
          truck.waitingSince = null;
          truck.message = { ok: true, text: `Aisle ${aisleOf(task.to)} clear. Go to ${task.to}` };
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

    isUrgent(task) {
      if (task.urgent) return true;
      const mins = this.config.escalateAfterMin;
      return mins > 0 && this.now() - task.createdAt >= mins * MINUTE;
    }

    /** The job this truck would get right now, or null. Does not change anything. */
    nextTaskFor(truck) {
      const allowed = TRUCK_MODES[truck.mode].types;
      const cfg = this.config;
      const candidates = this.openTasks().filter((t) => {
        if (!cfg.enabled[t.type]) return false;
        if (allowed && !allowed.includes(t.type)) return false;
        if (this.locations[t.from].blocked) return false;
        if (t.to && this.locations[t.to].blocked) return false;
        if (t.autoSlot && !this._findSlot(t)) return false;
        return this._capacityLeft(aisleOf(t.from), truck.id) > 0;
      });
      if (!candidates.length) return null;

      const rank = (t) => (this.isUrgent(t) ? -1 : cfg.priority.indexOf(t.type));
      candidates.sort((x, y) => {
        const r = rank(x) - rank(y);
        if (r) return r;
        if (cfg.travelOptimise && rank(x) >= 0) {
          const d = distance(truck.position, x.from) - distance(truck.position, y.from);
          if (d) return d;
        }
        return x.createdAt - y.createdAt || x.id - y.id;
      });
      return candidates[0];
    }

    openTasks() {
      return Object.values(this.tasks).filter((t) => t.status === 'open');
    }

    /** Trucks counted against each aisle: those sent into it and not yet out. */
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

    /** What the truck should be doing now, for the handheld screen. */
    instruction(truckId) {
      const truck = this._truck(truckId);
      if (truck.mode === 'paused') return { kind: 'paused' };
      if (!truck.taskId) return { kind: 'idle' };
      const task = this.tasks[truck.taskId];
      if (truck.waiting) return { kind: 'wait', task, aisle: aisleOf(task.to), target: task.to };
      return { kind: task.step === 0 ? 'pickup' : 'drop', task, target: task.step === 0 ? task.from : task.to };
    }

    // ---- Internals ---------------------------------------------------------

    _assign(truck, task) {
      if (task.autoSlot && !task.to && !this._reserveSlot(task)) return false;
      task.status = 'active';
      task.truckId = truck.id;
      task.step = 0;
      task.reason = this._reasonFor(truck, task);
      truck.taskId = task.id;
      truck.idleSince = null;
      this.log(`${truck.id} ← job #${task.id} (${task.reason})`, { truckId: truck.id, taskId: task.id });
      return true;
    }

    _reasonFor(truck, task) {
      if (task.urgent) return 'Urgent';
      if (this.isUrgent(task)) {
        return `Waited ${Math.floor((this.now() - task.createdAt) / MINUTE)} min`;
      }
      const p = this.config.priority.indexOf(task.type) + 1;
      return `Priority ${p}${this.config.travelOptimise ? ' · nearest' : ''}`;
    }

    _unassign(task) {
      const truck = this.trucks[task.truckId];
      if (truck) {
        truck.taskId = null;
        truck.waiting = false;
        truck.waitingSince = null;
        truck.idleSince = this.now();
      }
      task.status = 'open';
      task.truckId = null;
      task.step = 0;
      task.reason = null;
      this._releaseSlot(task);
    }

    _pickUp(truck, task) {
      const from = this.locations[task.from];
      if (from.kind === 'dock') {
        truck.load = { id: this._palletId(), sku: task.sku, qty: task.qty };
      } else {
        truck.load = from.pallet;
        from.pallet = null;
      }
      truck.position = task.from;
      task.step = 1;
      truck.waiting = aisleOf(task.to) !== aisleOf(task.from) && this._capacityLeft(aisleOf(task.to), truck.id) <= 0;
      truck.waitingSince = truck.waiting ? this.now() : null;
      if (truck.waiting) {
        this.log(`${truck.id} waiting: aisle ${aisleOf(task.to)} full`, { truckId: truck.id, taskId: task.id });
      }
      this.dispatch();
    }

    _drop(truck, task) {
      const to = this.locations[task.to];
      if (to.kind !== 'dock') {
        if (to.pallet && to.pallet.sku === truck.load.sku) to.pallet.qty += truck.load.qty;
        else to.pallet = truck.load;
      }
      to.reservedBy = null;
      task.alert = null;
      truck.load = null;
      truck.position = task.to;
      truck.taskId = null;
      truck.idleSince = this.now();
      truck.stats.jobs++;
      task.status = 'done';
      task.doneAt = this.now();
      this.log(`${truck.id} finished job #${task.id} at ${task.to}`, { truckId: truck.id, taskId: task.id });
      this.dispatch();
    }

    // Idle truck scans a rack location: take the job already waiting there,
    // or start an Auto-Shift of that pallet.
    _startFromScan(truck, loc, pass, fail) {
      if (loc.kind === 'dock') return fail('Scan a rack location to start an Auto-Shift');
      if (!loc.pallet) return fail(`${loc.code} is empty`);
      if (loc.blocked) return fail(`${loc.code} is blocked`);
      const allowed = TRUCK_MODES[truck.mode].types;
      if (this._capacityLeft(loc.aisle, truck.id) <= 0) {
        return fail(`Aisle ${loc.aisle} is full (${this.config.aisleCap}/${this.config.aisleCap})`);
      }

      const existing = this._liveTasks().find((t) => t.from === loc.code);
      if (existing) {
        if (existing.status !== 'open') return fail(`${loc.code} belongs to job #${existing.id} on ${existing.truckId || 'hold'}`);
        if (!this.config.enabled[existing.type]) return fail(`${TASK_TYPES[existing.type].label} is switched off by the coordinator`);
        if (allowed && !allowed.includes(existing.type)) return fail(`${loc.code} has a ${TASK_TYPES[existing.type].label} job`);
        if (!this._assign(truck, existing)) return fail('No free slot for this pallet');
        this._pickUp(truck, existing);
        return pass(`Picked up job #${existing.id}. Take it to ${existing.to}`);
      }

      if (!this.config.enabled.SHIFT) return fail('Auto-Shift is switched off by the coordinator');
      const task = {
        id: ++this._seq.task,
        type: 'SHIFT',
        from: loc.code,
        to: null,
        autoSlot: true,
        sku: loc.pallet.sku,
        qty: loc.pallet.qty,
        urgent: false,
        createdAt: this.now(),
        status: 'open',
        truckId: null,
        step: 0,
        reason: null,
        heldReason: null,
        blockedLoc: null,
        driverStarted: true,
      };
      if (!this._reserveSlot(task)) return fail('No free slot for this pallet');
      this.tasks[task.id] = task;
      this.log(`${truck.id} started Auto-Shift #${task.id} from ${loc.code}`, { truckId: truck.id, taskId: task.id });
      this._assign(truck, task);
      task.reason = 'Driver Auto-Shift';
      this._pickUp(truck, task);
      return pass(`Auto-Shift: take it to ${task.to}`);
    }

    _overrideProblem(truck, task, loc) {
      if (!task.autoSlot || !this.config.allowSlotOverride) return `Wrong location. Drop at ${task.to}`;
      if (loc.kind !== 'reserve') return `${loc.code} is not a reserve slot. Drop at ${task.to}`;
      if (loc.pallet || loc.reservedBy) return `${loc.code} is taken. Drop at ${task.to}`;
      if (loc.blocked) return `${loc.code} is blocked. Drop at ${task.to}`;
      if (loc.aisle !== aisleOf(task.to) && this._capacityLeft(loc.aisle, truck.id) <= 0) {
        return `Aisle ${loc.aisle} is full. Drop at ${task.to}`;
      }
      return null;
    }

    // Best free reserve slot: nearest to where the pallet comes from,
    // in an aisle with room, lower levels first.
    _findSlot(task) {
      const origin = task.from;
      let best = null;
      let bestScore = Infinity;
      for (const loc of Object.values(this.locations)) {
        if (loc.kind !== 'reserve' || loc.pallet || loc.blocked || loc.reservedBy) continue;
        if (loc.code === task.from) continue;
        let score = distance(origin, loc.code) * 10 + loc.level;
        if (this._capacityLeft(loc.aisle, null) <= 0 && loc.aisle !== aisleOf(task.from)) score += 10000;
        if (score < bestScore) {
          best = loc;
          bestScore = score;
        }
      }
      return best;
    }

    _reserveSlot(task) {
      const slot = this._findSlot(task);
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
      if (!task.autoSlot || !task.to) return;
      const loc = this.locations[task.to];
      if (loc.reservedBy === task.id) loc.reservedBy = null;
      task.to = null;
    }

    _capacityLeft(aisle, exceptTruckId) {
      if (!aisle) return Infinity;
      let used = 0;
      for (const truck of Object.values(this.trucks)) {
        if (truck.id !== exceptTruckId && this.occupiedAisle(truck) === aisle) used++;
      }
      return this.config.aisleCap - used;
    }

    _liveTasks() {
      return Object.values(this.tasks).filter((t) => t.status === 'open' || t.status === 'active' || t.status === 'held');
    }

    _palletId() {
      return `P${String(++this._seq.pallet).padStart(5, '0')}`;
    }

    _loc(code) {
      const loc = this.locations[code];
      if (!loc) throw new Error(`${code} is not a location`);
      return loc;
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

  return { Warehouse, TASK_TYPES, TRUCK_MODES, DEFAULT_CONFIG, parseRack, rackCode, aisleOf, distance };
});
