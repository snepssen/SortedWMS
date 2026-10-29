/*
 * Persistence: an append-only journal of commands in SQLite, plus snapshots.
 *
 * Every command is stored with its time and operator before the response
 * goes out. On start-up the latest snapshot is loaded and the journal after
 * it is replayed with the original times, which rebuilds the exact state.
 * The journal doubles as the audit trail: who did what, when.
 */
const { DatabaseSync } = require('node:sqlite');
const { Warehouse } = require('../src/engine');
const { buildWarehouse } = require('./site');
const { COMMANDS } = require('./commands');

const SNAPSHOT_EVERY = 200;

class Store {
  constructor({ file = ':memory:', site, now = () => Date.now() } = {}) {
    this.site = site;
    this.siteId = 'MAIN';
    this._extra = null;
    this.now = now;
    this.replayT = null; // during a command or replay, the engine's clock is pinned to the command's time
    this.clock = () => (this.replayT == null ? this.now() : this.replayT);
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS journal (id INTEGER PRIMARY KEY AUTOINCREMENT, t INTEGER NOT NULL, op TEXT NOT NULL, args TEXT NOT NULL, by TEXT);
      CREATE TABLE IF NOT EXISTS snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, journal_id INTEGER NOT NULL, t INTEGER NOT NULL, state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS extra_sites (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL, state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS extra_journal (id INTEGER PRIMARY KEY AUTOINCREMENT, site TEXT NOT NULL, t INTEGER NOT NULL, op TEXT NOT NULL, args TEXT NOT NULL, by TEXT);
    `);
    this._insert = this.db.prepare('INSERT INTO journal (t, op, args, by) VALUES (?, ?, ?, ?)');
    this.load();
  }

  meta(key, value) {
    if (value === undefined) {
      const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
      return row ? JSON.parse(row.value) : undefined;
    }
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));
    return value;
  }

  /** Rebuild the warehouse: latest snapshot, then replay the journal after it. */
  load() {
    let site = this.meta('site');
    let createdAt = this.meta('createdAt');
    if (!site) {
      site = this.meta('site', this.site);
      createdAt = this.meta('createdAt', this.now());
    }
    this.siteUsed = site;
    const snap = this.db.prepare('SELECT journal_id, state FROM snapshots ORDER BY id DESC LIMIT 1').get();
    let from = 0;
    if (snap) {
      this.wh = Warehouse.restore(JSON.parse(snap.state), { clock: this.clock });
      from = snap.journal_id;
    } else {
      this.replayT = createdAt;
      this.wh = buildWarehouse(site, this.clock);
      this.replayT = null;
    }
    const rows = this.db.prepare('SELECT id, t, op, args, by FROM journal WHERE id > ? ORDER BY id').all(from);
    this.replayErrors = [];
    for (const r of rows) {
      this.replayT = r.t;
      this.wh._actor = r.by;
      try { COMMANDS[r.op](this.wh, JSON.parse(r.args), r.by); } catch (e) { this.replayErrors.push(`#${r.id} ${r.op}: ${e.message}`); }
    }
    this.replayT = null;
    this.lastId = rows.length ? rows[rows.length - 1].id : from;
    this.sinceSnapshot = rows.length;
  }

  /**
   * Run a command now and journal it. If it fails, nothing is journaled and
   * the state is rebuilt, so a half-done command can never linger.
   */
  listSites() {
    const extras = this.db.prepare('SELECT id, name FROM extra_sites ORDER BY id').all();
    return [{ id: 'MAIN', name: (this.siteUsed && this.siteUsed.name) || 'Main warehouse' }, ...extras];
  }

  warehouse(siteId) {
    const id = !siteId || siteId === 'MAIN' ? 'MAIN' : String(siteId).toUpperCase();
    if (id === 'MAIN') return this.wh;
    if (this._extra && this._extra.id === id) return this._extra.wh;
    const row = this.db.prepare('SELECT state FROM extra_sites WHERE id = ?').get(id);
    if (!row) throw new Error(`Unknown warehouse ${id}`);
    const wh = Warehouse.restore(JSON.parse(row.state), { clock: this.clock });
    this._extra = { id, wh };
    return wh;
  }

  createSite({ id, name, preset } = {}) {
    const siteId = String(id || '').trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9_-]{0,15}$/.test(siteId)) throw new Error('A warehouse id starts with a letter and uses letters, digits, hyphen or underscore');
    if (siteId === 'MAIN') throw new Error('MAIN is the first warehouse');
    if (this.db.prepare('SELECT id FROM extra_sites WHERE id = ?').get(siteId)) throw new Error(`Warehouse ${siteId} already exists`);
    const wh = new Warehouse({ aisles: [1], bays: 2, levels: 1, positions: [10], outLanes: 1, clock: this.clock });
    if (preset) wh.applyPreset(preset);
    wh.siteId = siteId;
    const label = String(name || siteId).trim() || siteId;
    this.db.prepare('INSERT INTO extra_sites (id, name, created_at, state) VALUES (?, ?, ?, ?)').run(siteId, label, this.now(), JSON.stringify(wh));
    return { id: siteId, name: label };
  }

  transferBetween({ from = 'MAIN', to, itemNo, qty, by = 'office' } = {}) {
    const source = String(from || 'MAIN').toUpperCase();
    const dest = String(to || '').trim().toUpperCase();
    if (!dest || dest === source) throw new Error('Choose a different warehouse');
    this.warehouse(source);
    const destWh = this.warehouse(dest);
    if (!destWh.items[itemNo]) throw new Error(`Warehouse ${dest} has no item ${itemNo}`);
    const previous = this.siteId;
    let exported = null;
    try {
      this.siteId = source;
      exported = this.exec('exportStock', { itemNo, qty, toSite: dest, fromSite: source }, by);
      this.siteId = dest;
      const imported = this.exec('receiveTransfer', exported, by);
      return { from: source, to: dest, itemNo, qty: Number(qty), holder: imported.holder.id };
    } catch (e) {
      if (exported) {
        this.siteId = source;
        try { this.exec('receiveTransfer', { ...exported, fromSite: dest }, by); } catch (ignore) { /* the original error still stands */ }
      }
      throw e;
    } finally {
      this.siteId = previous || 'MAIN';
      this._extra = null;
    }
  }

  _execExtra(siteId, op, args, by) {
    const wh = this.warehouse(siteId);
    const t = this.now();
    this.replayT = t;
    wh._actor = by;
    let result;
    try {
      result = COMMANDS[op](wh, args, by);
    } catch (e) {
      this.replayT = null;
      this._extra = null;
      throw e;
    }
    this.replayT = null;
    this.db.prepare('INSERT INTO extra_journal (site, t, op, args, by) VALUES (?, ?, ?, ?, ?)').run(siteId, t, op, JSON.stringify(args), by);
    this.db.prepare('UPDATE extra_sites SET state = ? WHERE id = ?').run(JSON.stringify(wh), siteId);
    this._extra = { id: siteId, wh };
    return result;
  }

  exec(op, args = {}, by = 'unknown') {
    if (!COMMANDS[op]) throw new Error(`Unknown command ${op}`);
    if ((this.siteId || 'MAIN') !== 'MAIN') return this._execExtra(this.siteId, op, args, by);
    const t = this.now();
    this.replayT = t;
    this.wh._actor = by;
    let result;
    try {
      result = COMMANDS[op](this.wh, args, by);
    } catch (e) {
      this.replayT = null;
      this.load();
      throw e;
    }
    this.replayT = null;
    this._journal(t, op, args, by);
    return result;
  }

  /** Clock tick: journaled only when it changed something (timers ran out, a truck got a job). */
  tick() {
    const t = this.now();
    const before = this.wh.events[0];
    this.replayT = t;
    try { COMMANDS.tick(this.wh); } finally { this.replayT = null; }
    if (this.wh.events[0] !== before) this._journal(t, 'tick', {}, 'system');
  }

  _journal(t, op, args, by) {
    const r = this._insert.run(t, op, JSON.stringify(args), by);
    this.lastId = Number(r.lastInsertRowid);
    if (++this.sinceSnapshot >= SNAPSHOT_EVERY) this.snapshot();
  }

  snapshot() {
    this.db.prepare('INSERT INTO snapshots (journal_id, t, state) VALUES (?, ?, ?)').run(this.lastId, this.now(), JSON.stringify(this.wh));
    this.db.prepare('DELETE FROM snapshots WHERE id NOT IN (SELECT id FROM snapshots ORDER BY id DESC LIMIT 5)').run();
    this.sinceSnapshot = 0;
  }

  /** The audit trail, newest first. */
  journal({ limit = 100, op = null, by = null, before = null } = {}) {
    const where = [];
    const params = [];
    if (op) { where.push('op = ?'); params.push(op); }
    if (by) { where.push('by = ?'); params.push(by); }
    if (before) { where.push('id < ?'); params.push(Number(before)); }
    where.push("op != 'tick'");
    const sql = `SELECT id, t, op, args, by FROM journal ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`;
    return this.db.prepare(sql).all(...params, Math.min(Number(limit) || 100, 1000)).map((r) => ({ ...r, args: JSON.parse(r.args) }));
  }

  close() {
    this.snapshot();
    this.db.close();
  }
}

module.exports = { Store };
