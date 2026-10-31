/*
 * Pick waves for piece lines (orders in units, not whole pallets).
 *
 * Racks and bins are worked by different people. A reach truck never picks
 * from a bin. Each open piece line is filled in this order:
 *
 *   1. Whole pallets: a rack pallet whose quantity fits what is still needed
 *      goes straight to the order's dock lane.
 *   2. Whole boxes (the item's smallest pack, e.g. 5000 screws) from rack
 *      pallets, for the man-up. The pallet stays in its slot.
 *   3. The rest, less than a box: from the bins when they hold all of it;
 *      else from a box already opened on a pallet; only then a new box is
 *      opened. A small pick is never split between a bin and a box.
 *
 * A pallet remembers how much is left in its opened box (pallet.openBox), so
 * the next small pick of that item takes from it instead of opening another.
 *
 * Orders wait in a queue. When the active wave is finished, the next wave is
 * built from the queue, oldest order first. An order joins it when it drops
 * cleanly (no new box has to be opened for it), or when it has waited the
 * maximum time. Box picks and bin picks drop at the post-pick lane; whole
 * pallets go to the dock. Consolidation is per order: one box is never shared
 * between orders, but an opened box serves later orders.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SortedWaves = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DEFAULTS = { auto: true, maxWaitMin: 120, maxOrders: 20, postPick: null };
  const MINUTE = 60000;

  function install(Warehouse) {
    const proto = Warehouse.prototype;

    proto.waveSettings = function () {
      return { ...DEFAULTS, ...(this.waveConfig || {}) };
    };

    proto.setWaveConfig = function (patch = {}) {
      const next = this.waveSettings();
      if ('auto' in patch) next.auto = Boolean(patch.auto);
      if ('maxWaitMin' in patch) {
        const n = Number(patch.maxWaitMin);
        if (!Number.isInteger(n) || n < 0 || n > 10080) throw new Error('Maximum wait is 0 to 10080 minutes');
        next.maxWaitMin = n;
      }
      if ('maxOrders' in patch) {
        const n = Number(patch.maxOrders);
        if (!Number.isInteger(n) || n < 1 || n > 500) throw new Error('Orders per wave is 1 to 500');
        next.maxOrders = n;
      }
      if ('postPick' in patch) {
        if (!patch.postPick) next.postPick = null;
        else {
          const loc = this._loc(this.resolve(patch.postPick));
          if (loc.kind !== 'virtual' && loc.kind !== 'lane') throw new Error('The post-pick lane is a staging location or a lane');
          next.postPick = loc.code;
        }
      }
      this.waveConfig = next;
      this.log(`Pick waves: ${next.auto ? 'automatic' : 'by hand'}, wait at most ${next.maxWaitMin} min, ${next.maxOrders} orders a wave${next.postPick ? `, drop at ${next.postPick}` : ''}`);
      return next;
    };

    proto._openWaveTasks = function () {
      const out = [];
      for (const wave of Object.values(this.waves || {})) for (const t of wave.tasks) if (t.status === 'open') out.push(t);
      return out;
    };

    proto.activeWave = function () {
      return Object.values(this.waves || {}).find((w) => w.tasks.some((t) => t.status === 'open')) || null;
    };

    function stepOf(item) {
      return item && item.packs && item.packs.length ? Math.min(...item.packs.map((p) => p.per)) : 0;
    }

    /**
     * What the racks and bins can still give, after the open tasks. A plan
     * works on a copy of this and only keeps it when the order is taken.
     */
    proto._waveStock = function () {
      const live = typeof this._liveMap === 'function' ? this._liveMap() : new Map();
      const pallets = new Map();
      for (const p of Object.values(this.pallets)) {
        if (!p.loc || p.orderId || this.shipState(p) !== 'ok' || p.qualityHold || p.quarantine || live.get(p.sscc)) continue;
        const loc = this.locations[p.loc];
        if (!loc || loc.kind !== 'rack' || loc.structural || loc.blocked) continue;
        pallets.set(p.sscc, { sscc: p.sscc, itemNo: p.itemNo, loc: p.loc, batch: p.batch, expiry: p.expiry, receivedAt: p.receivedAt, qty: p.qty, free: p.qty, open: p.openBox || 0, whole: true });
      }
      const bins = new Map();
      for (const [code, lines] of Object.entries(this.binStock || {})) {
        const loc = this.locations[code];
        if (!loc || loc.blocked || loc.role === 'quarantine' || loc.role === 'return' || loc.quarantine) continue;
        for (const l of lines) {
          const key = `${l.itemNo}|${code}`;
          const row = bins.get(key) || { itemNo: l.itemNo, loc: code, free: 0, expiry: null, since: Infinity };
          row.free += l.qty;
          if (l.expiry && (!row.expiry || l.expiry < row.expiry)) row.expiry = l.expiry;
          row.since = Math.min(row.since, l.since);
          bins.set(key, row);
        }
      }
      const planned = new Map();
      for (const t of this._openWaveTasks()) {
        planned.set(`${t.orderId}|${t.itemNo}`, (planned.get(`${t.orderId}|${t.itemNo}`) || 0) + t.qty);
        if (t.kind === 'bin') { const b = bins.get(`${t.itemNo}|${t.loc}`); if (b) b.free -= t.qty; continue; }
        const p = pallets.get(t.sscc);
        if (!p) continue;
        p.whole = false;
        p.free -= t.kind === 'pallet' ? p.free : t.qty;
        if (t.box === 'open') p.open -= t.qty;
        if (t.box === 'new') p.open = p.open + t.per - t.qty;
      }
      return { pallets, bins, planned };
    };

    function copyStock(s) {
      const pallets = new Map();
      for (const [k, v] of s.pallets) pallets.set(k, { ...v });
      const bins = new Map();
      for (const [k, v] of s.bins) bins.set(k, { ...v });
      return { pallets, bins, planned: new Map(s.planned) };
    }

    /** Plan one order on a stock copy. Returns its tasks, what is short, and whether a new box is opened. */
    proto._planOrder = function (order, stock) {
      const fefo = this.feature('fefo') && this.feature('lotExpiry');
      const byAge = (a, b) => (fefo ? String(a.expiry || '9999').localeCompare(String(b.expiry || '9999')) : 0) || (a.receivedAt || a.since || 0) - (b.receivedAt || b.since || 0);
      const tasks = [];
      const short = [];
      for (const line of order.lines) {
        if (line.kind !== 'each') continue;
        let left = line.units - (line.picked || 0) - (stock.planned.get(`${order.id}|${line.itemNo}`) || 0);
        if (left <= 0) continue;
        const item = this.items[line.itemNo];
        const per = stepOf(item);
        const racks = () => [...stock.pallets.values()].filter((p) => p.itemNo === line.itemNo && p.free > 0).sort(byAge);
        const add = (t) => { tasks.push({ orderId: order.id, itemNo: line.itemNo, ...t }); left -= t.qty; };
        // 1. Whole pallets that fit, straight to the dock.
        for (const p of racks()) {
          if (!p.whole || p.open || p.qty > left) continue;
          add({ kind: 'pallet', role: 'picker', qty: p.qty, sscc: p.sscc, loc: p.loc, batch: p.batch, expiry: p.expiry });
          p.free = 0;
          p.whole = false;
        }
        // 2. Whole boxes, leaving any opened box alone.
        if (per && left >= per) {
          for (const p of racks()) {
            const boxes = Math.floor(Math.min(left, p.free - p.open) / per) * per;
            if (boxes <= 0) continue;
            add({ kind: 'case', role: 'man-up', qty: boxes, sscc: p.sscc, loc: p.loc, batch: p.batch, expiry: p.expiry, box: 'whole', per });
            p.free -= boxes;
            p.whole = false;
            if (left < per) break;
          }
        }
        if (!left) continue;
        // 3. The rest: bins that hold all of it, else an opened box, else a new box.
        const bins = [...stock.bins.values()].filter((b) => b.itemNo === line.itemNo && b.free > 0).sort(byAge);
        if (bins.reduce((s, b) => s + b.free, 0) >= left) {
          for (const b of bins) {
            if (!left) break;
            const take = Math.min(left, b.free);
            add({ kind: 'bin', role: 'picker', qty: take, loc: b.loc, expiry: b.expiry });
            b.free -= take;
          }
          continue;
        }
        const opened = racks().find((p) => p.open >= left);
        if (opened) {
          const take = left;
          add({ kind: 'case', role: 'man-up', qty: take, sscc: opened.sscc, loc: opened.loc, batch: opened.batch, expiry: opened.expiry, box: 'open', per });
          opened.free -= take;
          opened.open -= take;
          continue;
        }
        for (const p of racks()) {
          if (!left) break;
          const take = Math.min(left, p.free);
          if (take <= 0) continue;
          const box = per ? 'new' : 'loose';
          add({ kind: 'case', role: 'man-up', qty: take, sscc: p.sscc, loc: p.loc, batch: p.batch, expiry: p.expiry, box, per });
          p.free -= take;
          p.whole = false;
          if (box === 'new') p.open = Math.max(0, p.open + per - take);
        }
        if (left > 0) short.push({ orderId: order.id, itemNo: line.itemNo, qty: left });
      }
      return { tasks, short, opensBox: tasks.some((t) => t.box === 'new') };
    };

    /** Orders with piece lines still to plan, oldest first. */
    proto.waveQueue = function () {
      const stock = this._waveStock();
      const s = this.waveSettings();
      const now = this.now();
      return Object.values(this.orders)
        .filter((o) => o.status !== 'shipped' && o.lines.some((l) => l.kind === 'each' && l.units - (l.picked || 0) - (stock.planned.get(`${o.id}|${l.itemNo}`) || 0) > 0))
        .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))
        .map((o) => {
          const plan = this._planOrder(o, copyStock(stock));
          const waited = Math.floor((now - o.createdAt) / MINUTE);
          return { orderId: o.id, customer: o.customer, waitedMin: waited, due: waited >= s.maxWaitMin, clean: !plan.opensBox, tasks: plan.tasks.length, short: plan.short };
        });
    };

    /**
     * Build a wave. `orders` names orders to take now, ignoring the clean
     * rule. Without it, the queue decides: an order joins when it drops
     * cleanly or has waited the maximum time. Returns null when nothing joins.
     */
    proto._buildWave = function ({ id = null, orders = null, by, auto = false } = {}) {
      const s = this.waveSettings();
      const wanted = orders && orders.length ? orders.map((o) => String(o).trim()) : null;
      if (wanted) for (const o of wanted) if (!this.orders[o]) throw new Error(`No order ${o}`);
      const stock = this._waveStock();
      const now = this.now();
      const queue = Object.values(this.orders)
        .filter((o) => o.status !== 'shipped' && (!wanted || wanted.includes(o.id)))
        .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
      // Orders that are due go first, so a box they open can serve the newer ones.
      const due = (o) => wanted || now - o.createdAt >= s.maxWaitMin * MINUTE;
      const ordered = queue.filter(due).concat(queue.filter((o) => !due(o)));
      const tasks = [];
      const short = [];
      const joined = [];
      let working = stock;
      for (const order of ordered) {
        if (!wanted && joined.length >= s.maxOrders) break;
        const trial = copyStock(working);
        const plan = this._planOrder(order, trial);
        if (!plan.tasks.length && !plan.short.length) continue;
        if (!due(order) && plan.opensBox) continue;
        if (!plan.tasks.length) { if (wanted) short.push(...plan.short); continue; }
        working = trial;
        tasks.push(...plan.tasks);
        short.push(...plan.short);
        joined.push(order.id);
      }
      if (!tasks.length) {
        if (auto) return null;
        throw new Error(short.length ? `Nothing in stock to pick (${short.map((x) => `${x.itemNo} × ${x.qty}`).join(', ')})` : 'Nothing to pick: no open piece lines');
      }
      this.waves = this.waves || {};
      this._seq.wave = (this._seq.wave || 0) + 1;
      const waveId = id ? String(id).trim().toUpperCase() : `W${String(this._seq.wave).padStart(4, '0')}`;
      if (this.waves[waveId]) throw new Error(`Wave ${waveId} already exists`);
      let n = 0;
      const wave = {
        id: waveId, createdAt: now, by: by || this._actor || (auto ? 'system' : 'office'), auto: Boolean(auto), orders: joined,
        tasks: tasks.map((t) => {
          const order = this.orders[t.orderId];
          return { id: `${waveId}-${++n}`, status: 'open', ...t, dropTo: t.kind === 'pallet' ? order.lane : s.postPick };
        }),
        short,
      };
      this.waves[waveId] = wave;
      const count = (k) => wave.tasks.filter((t) => t.kind === k).length;
      this.log(`Wave ${waveId}${auto ? ' (from the queue)' : ''}: ${joined.length} order${joined.length === 1 ? '' : 's'}, ${count('pallet')} pallet, ${count('case')} box, ${count('bin')} bin pick${short.length ? `, ${short.length} short` : ''}`);
      return wave;
    };

    proto.planWave = function ({ id = null, orders = null, by } = {}) {
      return this._buildWave({ id, orders, by, auto: false });
    };

    /** The queue drops into a new wave when no wave is active. Called on the clock tick and when a wave finishes. */
    proto.autoWave = function () {
      if (!this.waveSettings().auto || this.activeWave()) return null;
      return this._buildWave({ auto: true, by: 'system' });
    };

    proto._waveTask = function (taskId) {
      const id = String(taskId || '').trim().toUpperCase();
      for (const wave of Object.values(this.waves || {})) {
        const t = wave.tasks.find((x) => x.id === id);
        if (t) return { wave, task: t };
      }
      throw new Error(`No wave task ${taskId}`);
    };

    proto._pieceProgress = function (order) {
      const piece = order.lines.filter((l) => l.kind === 'each');
      const done = piece.every((l) => (l.picked || 0) >= l.units);
      if (!order.lines.some((l) => l.kind !== 'each' && l.pallets)) order.status = done ? 'ready' : 'picking';
      else if (order.status === 'open') order.status = 'picking';
    };

    /** A picker confirms a task. Scanning the pallet, its slot or the bin proves they are there. */
    proto.confirmWaveTask = function ({ task: taskId, scan = null, by } = {}) {
      const { wave, task } = this._waveTask(taskId);
      if (task.status !== 'open') throw new Error(`Task ${task.id} is ${task.status}`);
      const actor = by || this._actor || 'picker';
      if (scan != null && scan !== '') {
        const s = String(scan).trim().toUpperCase();
        const ok = task.sscc ? (s === task.sscc || this.resolve(scan) === task.loc) : this.resolve(scan) === task.loc;
        if (!ok) throw new Error(`Wrong place. Go to ${task.loc}${task.sscc ? ` (pallet …${task.sscc.slice(-6)})` : ''}`);
      }
      const order = this.orders[task.orderId];
      if (!order || order.status === 'shipped') throw new Error(`Order ${task.orderId} is not open`);
      const line = order.lines.find((l) => l.kind === 'each' && l.itemNo === task.itemNo);
      if (!line || (line.picked || 0) + task.qty > line.units) throw new Error(`Order ${order.id} does not need ${task.qty} more ${task.itemNo}`);
      if (task.kind === 'bin') {
        this.binTake({ loc: task.loc, itemNo: task.itemNo, qty: task.qty, orderId: order.id, by: actor, at: task.dropTo || null });
      } else {
        const pallet = this.pallets[task.sscc];
        if (!pallet || pallet.loc !== task.loc) throw new Error(`Pallet …${task.sscc.slice(-6)} is no longer at ${task.loc}`);
        if (task.kind === 'pallet') {
          if (pallet.qty !== task.qty) throw new Error(`Pallet …${task.sscc.slice(-6)} now holds ${pallet.qty}, not ${task.qty}. Plan the wave again`);
          const moved = this.transferPallet(pallet.sscc, task.dropTo, { by: actor });
          if (!moved.ok) throw new Error(moved.text);
          pallet.orderId = order.id;
          line.wholePallets = line.wholePallets || [];
          line.wholePallets.push(pallet.sscc);
          line.picked = (line.picked || 0) + task.qty;
          this.recordMovement({ holder: pallet.holderId || null, sscc: pallet.sscc, from: task.loc, to: task.dropTo, qty: task.qty, event: 'picked', by: actor, note: `${task.itemNo} whole pallet for ${order.id}` });
        } else {
          if (pallet.qty < task.qty) throw new Error(`Pallet …${task.sscc.slice(-6)} has ${pallet.qty}, not ${task.qty}`);
          const open = pallet.openBox || 0;
          if (task.box === 'open' && open < task.qty) throw new Error(`The opened box on …${task.sscc.slice(-6)} has ${open}, not ${task.qty}`);
          pallet.qty -= task.qty;
          if (task.box === 'open') pallet.openBox = open - task.qty;
          if (task.box === 'new') pallet.openBox = Math.max(0, open + task.per - task.qty);
          if (pallet.openBox > pallet.qty) pallet.openBox = pallet.qty;
          line.picked = (line.picked || 0) + task.qty;
          line.picks = line.picks || [];
          line.picks.push({ sscc: pallet.sscc, qty: task.qty, from: task.loc, t: this.now(), by: actor });
          order.staged = order.staged || [];
          order.staged.push({ itemNo: task.itemNo, qty: task.qty, holder: pallet.sscc, batch: pallet.batch || null, expiry: pallet.expiry || null, at: task.dropTo || null });
          const how = task.box === 'whole' ? 'whole boxes' : task.box === 'new' ? 'box opened' : task.box === 'open' ? 'from the opened box' : 'loose';
          this.recordMovement({ holder: pallet.holderId || null, sscc: pallet.sscc, from: task.loc, to: task.dropTo || `ORDER-${order.id}`, qty: task.qty, event: 'picked', by: actor, note: `${task.itemNo} for ${order.id}, ${how}` });
          if (pallet.qty === 0) {
            this._remove(pallet);
            pallet.status = 'shipped';
            pallet.removed = 'emptied';
            pallet.goneAt = this.now();
            pallet.openBox = 0;
            this.log(`Pallet …${pallet.sscc.slice(-6)} is empty after the pick`);
          }
        }
        this._pieceProgress(order);
      }
      task.status = 'done';
      task.doneBy = actor;
      task.doneAt = this.now();
      this.log(`Wave task ${task.id} done: ${task.qty} ${task.itemNo} from ${task.loc}${task.dropTo ? ` to ${task.dropTo}` : ''}`);
      if (!wave.tasks.some((t) => t.status === 'open')) {
        wave.completedAt = this.now();
        this.log(`Wave ${wave.id} complete`);
        this.autoWave();
      }
      return task;
    };

    proto.cancelWave = function ({ id, by } = {}) {
      const wave = this.waves && this.waves[String(id || '').trim().toUpperCase()];
      if (!wave) throw new Error(`No wave ${id}`);
      let n = 0;
      for (const t of wave.tasks) if (t.status === 'open') { t.status = 'cancelled'; n++; }
      this.log(`Wave ${wave.id} cancelled (${n} open task${n === 1 ? '' : 's'}) by ${by || this._actor || 'office'}`);
      return wave;
    };

    /** Open tasks for one kind of pick: pallet, case (man-up) or bin (EPT and cart pickers). */
    proto.waveTasks = function ({ kind = null } = {}) {
      return this._openWaveTasks().filter((t) => !kind || t.kind === kind).map((t) => ({ ...t, name: this.items[t.itemNo] ? this.items[t.itemNo].name : '', unit: this.items[t.itemNo] ? this.items[t.itemNo].uom : null }));
    };

    /** Units of an order line on whole pallets picked for it. */
    proto._wholePalletUnits = function (line) {
      return (line.wholePallets || []).reduce((s, sscc) => s + (this.pallets[sscc] ? this.pallets[sscc].qty : 0), 0);
    };
  }

  return { install, DEFAULTS };
});
