/*
 * The WMS without a server, for the GitHub Pages demo: the same engine, commands
 * and API as server/, with the journal kept in this browser's localStorage.
 * Pages open in other tabs or frames share it: each replays what the others
 * added, which gives the same state because the engine only takes time from
 * the journal. Load after src/*.js, server/commands.js, site.js, api.js.
 */
(function (root) {
  'use strict';
  const { COMMANDS } = root.SortedCommands;
  const { buildWarehouse } = root.SortedSite;
  // window.SORTED_LOCAL = { key, demo: true } before this script: the demo keeps its own journal and clock.
  const CONF = root.SORTED_LOCAL || {};
  const Demo = CONF.demo ? root.SortedDemo : null;
  const KEY = CONF.key || 'sortedwms.journal.v1';
  const base = (document.currentScript && document.currentScript.src.replace(/server\/local\.js.*$/, '')) || './';

  /*
   * The demo clock: warehouse time runs at a chosen speed (paused, 1×, 10×,
   * 60×), shared by every page through browser storage. The demo page moves
   * the clock on every second; when no demo page is open, time stops a few
   * seconds after the last one, so the warehouse waits for the visitor.
   */
  const CLOCK = `${KEY}.clock`;
  const HOLD = 5000;
  const clock = Demo && {
    last: 0,
    state() {
      let s = null;
      try { s = JSON.parse(localStorage.getItem(CLOCK)); } catch (e) { s = null; }
      return s && Number.isFinite(s.sim) ? s : { sim: Demo.morning(Date.now()), wall: Date.now(), speed: 10 };
    },
    now() {
      const s = this.state();
      this.last = Math.max(this.last, Math.round(s.sim + Math.min(Math.max(0, Date.now() - s.wall), HOLD) * s.speed));
      return this.last;
    },
    get speed() { return this.state().speed; },
    /** Carry the clock on from where it is, at a new speed if given. */
    beat(speed) {
      const s = this.state();
      const t = this.now();
      try { localStorage.setItem(CLOCK, JSON.stringify({ sim: t, wall: Date.now(), speed: speed == null ? s.speed : speed })); } catch (e) { /* storage off: time stays put */ }
      return t;
    },
    reset() { try { localStorage.removeItem(CLOCK); } catch (e) { /* ignore */ } this.last = 0; },
  };

  function read() {
    try { return JSON.parse(localStorage.getItem(KEY)); } catch (e) { return null; }
  }

  class LocalStore {
    constructor(site, now) {
      this.site = site;
      this.now = now || (() => Date.now());
      this.replayT = null;
      this.clock = () => (this.replayT == null ? this.now() : this.replayT);
      this.load();
    }

    load() {
      const saved = read();
      this.data = saved && saved.rows ? saved : { createdAt: this.now(), rows: [], replenishmentVersion: 1 };
      this.replayT = this.data.createdAt;
      this.wh = buildWarehouse(this.site, this.clock);
      this.wh.replenishmentVersion = this.data.replenishmentVersion || 0;
      this.applied = 0;
      this._apply();
    }

    _apply() {
      for (; this.applied < this.data.rows.length; this.applied++) {
        const r = this.data.rows[this.applied];
        this.replayT = r.t;
        try { COMMANDS[r.op](this.wh, r.args, r.by); } catch (e) { /* the same error happened live; nothing changed */ }
      }
      this.replayT = null;
    }

    /** Take in what other tabs added since. */
    sync() {
      const saved = read();
      if (!saved || saved.createdAt !== this.data.createdAt || saved.rows.length < this.applied) return this.load();
      this.data = saved;
      this._apply();
    }

    _save() {
      try { localStorage.setItem(KEY, JSON.stringify(this.data)); } catch (e) { console.warn('Browser storage is full or off: changes last until reload', e); }
    }

    exec(op, args = {}, by = 'unknown') {
      if (!COMMANDS[op]) throw new Error(`Unknown command ${op}`);
      this.sync();
      if (op !== 'enableDemandReplenishment' && this.wh.replenishmentVersion !== 1) this.exec('enableDemandReplenishment', {}, 'system');
      const rows = this.data.rows;
      const t = Math.max(this.now(), rows.length ? rows[rows.length - 1].t : 0);
      this.replayT = t;
      let result;
      try {
        result = COMMANDS[op](this.wh, args, by);
      } catch (e) {
        this.replayT = null;
        this.load();
        throw e;
      }
      this.replayT = null;
      this.data.rows.push({ id: this.data.rows.length + 1, t, op, args: JSON.parse(JSON.stringify(args)), by });
      this.applied = this.data.rows.length;
      this._save();
      return result;
    }

    tick() {
      this.sync();
      if (this.wh.replenishmentVersion !== 1) this.exec('enableDemandReplenishment', {}, 'system');
      const before = this.wh.events[0];
      const t = this.now();
      this.replayT = t;
      try { COMMANDS.tick(this.wh); } finally { this.replayT = null; }
      if (this.wh.events[0] !== before) {
        this.data.rows.push({ id: this.data.rows.length + 1, t, op: 'tick', args: {}, by: 'system' });
        this.applied = this.data.rows.length;
        this._save();
      }
    }

    journal({ limit = 100, op = null, by = null, before = null } = {}) {
      return this.data.rows.filter((r) => r.op !== 'tick' && (!op || r.op === op) && (!by || r.by === by) && (!before || r.id < Number(before)))
        .slice(-Math.min(Number(limit) || 100, 1000)).reverse();
    }

    reset() {
      try { localStorage.removeItem(KEY); } catch (e) { /* ignore */ }
      if (clock) clock.reset();
      this.load();
      this.fill();
    }

    /** The demo starts from its own warehouse, filled through ordinary commands. */
    fill() {
      if (!Demo || this.data.rows.length) return;
      this._save();
      Demo.seed((op, args) => this.exec(op, args, 'demo'), this.now(), () => this.wh);
    }

    /** Bytes the journal takes in browser storage. */
    size() {
      try { return (localStorage.getItem(KEY) || '').length; } catch (e) { return 0; }
    }
  }

  // No label printers in a browser: jobs are listed in the office as not sent.
  const printers = {
    results: [], sentUpTo: 0,
    flush(queue) {
      for (const j of queue.filter((x) => x.id > this.sentUpTo).sort((a, b) => a.id - b.id)) {
        this.sentUpTo = j.id;
        this.results.unshift({ id: j.id, printer: j.printer, ok: false, error: 'Browser demo: no printer connected', t: Date.now() });
      }
    },
  };

  const site = Demo ? Promise.resolve(Demo.SITE) : fetch(`${base}server/site.blank.json`).then((r) => r.json());
  const ready = site.then((plan) => {
    const store = new LocalStore(plan, clock ? () => clock.now() : null);
    store.fill();
    const api = root.SortedApi.createApi({ store, printers });
    addEventListener('storage', (e) => { if (e.key === KEY || e.key === null) store.sync(); });
    setInterval(() => store.tick(), Demo ? 3000 : 10000);
    return { store, api };
  });

  root.SortedLocal = {
    ready,
    async fetch(method, path, body, { operator, requestId } = {}) {
      const { store, api } = await ready;
      store.sync();
      const out = await api.handle(method, path, body || {}, String(operator || 'office').slice(0, 40), requestId || null);
      return JSON.parse(JSON.stringify(out)); // a copy, like over the network
    },
    async reset() { const { store } = await ready; store.reset(); },
    async store() { return (await ready).store; },
    demo: Boolean(Demo),
    clock: clock || null,
    key: KEY,
  };
})(typeof self !== 'undefined' ? self : this);
