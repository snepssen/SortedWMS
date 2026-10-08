/*
 * The WMS without a server, for the GitHub Pages demo: the same engine, commands
 * and API as server/, with the journal kept in this browser's localStorage.
 * Pages open in other tabs or frames share it: each replays what the others
 * added, which gives the same state because the engine only takes time from
 * the journal. Load after src/*.js, server/commands.js, site.js, seed.js, api.js.
 */
(function (root) {
  'use strict';
  const { COMMANDS } = root.SortedCommands;
  const { buildWarehouse } = root.SortedSite;
  const KEY = 'sortedwms.journal.v1';
  const base = (document.currentScript && document.currentScript.src.replace(/server\/local\.js.*$/, '')) || './';

  function read() {
    try { return JSON.parse(localStorage.getItem(KEY)); } catch (e) { return null; }
  }

  class LocalStore {
    constructor(site) {
      this.site = site;
      this.now = () => Date.now();
      this.replayT = null;
      this.clock = () => (this.replayT == null ? this.now() : this.replayT);
      this.load();
    }

    load() {
      const saved = read();
      this.data = saved && saved.rows ? saved : { createdAt: this.now(), rows: [] };
      this.replayT = this.data.createdAt;
      this.wh = buildWarehouse(this.site, this.clock);
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
      const t = this.now();
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
      this.load();
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

  const ready = fetch(`${base}server/site.example.json`).then((r) => r.json()).then((site) => {
    const store = new LocalStore(site);
    if (!store.data.rows.length) root.SortedSeed.seedDemo(store);
    const api = root.SortedApi.createApi({ store, printers });
    addEventListener('storage', (e) => { if (e.key === KEY || e.key === null) store.sync(); });
    setInterval(() => store.tick(), 10000);
    return { store, api };
  });

  root.SortedLocal = {
    ready,
    async fetch(method, path, body, { operator } = {}) {
      const { store, api } = await ready;
      store.sync();
      const out = api.handle(method, path, body || {}, String(operator || 'office').slice(0, 40));
      return JSON.parse(JSON.stringify(out)); // a copy, like over the network
    },
    async reset() { const { store } = await ready; store.reset(); root.SortedSeed.seedDemo(store); },
    async store() { return (await ready).store; },
  };
})(typeof self !== 'undefined' ? self : this);
