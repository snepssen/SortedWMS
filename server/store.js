/*
 * Persistence: an append-only journal of commands in SQLite, plus snapshots.
 *
 * Every command is stored with its time and operator before the response
 * goes out. On start-up the latest snapshot is loaded and the journal after
 * it is replayed with the original times, which rebuilds the exact state.
 * The journal doubles as the audit trail: who did what, when.
 */
const path = require('node:path');
const { AsyncLocalStorage } = require('node:async_hooks');
const { DatabaseSync } = require('node:sqlite');
const { Warehouse } = require('../src/engine');
const { buildWarehouse } = require('./site');
const { COMMANDS } = require('./commands');
const { upgradeDatabase } = require('./upgrades');

const SNAPSHOT_EVERY = 200;
const SNAPSHOTS_KEPT = 2;

class Store {
  constructor({ file = ':memory:', site, now = () => Date.now(), backupDir = null, moduleUpgrades = null } = {}) {
    this._siteContext = new AsyncLocalStorage();
    this.site = site;
    this.siteId = 'MAIN';
    this._extra = null;
    this.file = file;
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
    this.backupDir = backupDir || (file && file !== ':memory:' ? path.join(path.dirname(file), 'backups') : null);
    this.moduleUpgrades = moduleUpgrades;
    this.upgradeLines = [];
    this.upgradeReport = null;
    this._upgrade();
    this.load();
  }

  /** Core steps, then each module's steps. Quiet unless the caller prints `upgradeLines`. */
  _upgrade() {
    let modules = this.moduleUpgrades;
    if (!modules) {
      try {
        modules = require('../modules/registry').upgradeModules();
      } catch (e) {
        if (e && e.code === 'MODULE_NOT_FOUND') modules = [];
        else throw e;
      }
    }
    const report = upgradeDatabase(this.db, {
      modules,
      file: this.file,
      backupDir: this.backupDir,
      now: this.now,
    });
    this.upgradeReport = report;
    this.upgradeLines.push(...report.lines);
    return report;
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
    this._extra = null;
    let site = this.meta('site');
    let createdAt = this.meta('createdAt');
    if (!site) {
      site = this.meta('site', this.site);
      this.meta('replenishmentVersionAtCreation', 1);
      createdAt = this.meta('createdAt', this.now());
    }
    this.siteUsed = site;
    // The newest snapshot that can be read. One that cannot (a write cut short) is
    // passed over for the one before it; the journal after that one fills the gap.
    let snap = null;
    let saved = null;
    this.snapshotSkipped = [];
    for (const row of this.db.prepare('SELECT id, journal_id, state FROM snapshots ORDER BY id DESC').iterate()) {
      try { saved = JSON.parse(row.state); } catch (e) { saved = null; }
      if (saved && typeof saved === 'object' && saved.locations) { snap = row; break; }
      this.snapshotSkipped.push(row.id);
      saved = null;
    }
    let from = 0;
    if (snap) {
      // Parsed here and referenced nowhere else: the engine may keep it as it is.
      this.wh = Warehouse.restore(saved, { clock: this.clock, owned: true });
      from = snap.journal_id;
    } else {
      this.replayT = createdAt;
      this.wh = buildWarehouse(site, this.clock);
      this.wh.replenishmentVersion = this.meta('replenishmentVersionAtCreation') || 0;
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
    const wh = Warehouse.restore(JSON.parse(row.state), { clock: this.clock, owned: true });
    this._extra = { id, wh };
    return wh;
  }

  createSite({ id, name, preset, country, timeZone } = {}) {
    const siteId = String(id || '').trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9_-]{0,15}$/.test(siteId)) throw new Error('A warehouse id starts with a letter and uses letters, digits, hyphen or underscore');
    if (siteId === 'MAIN') throw new Error('MAIN is the first warehouse');
    if (this.db.prepare('SELECT id FROM extra_sites WHERE id = ?').get(siteId)) throw new Error(`Warehouse ${siteId} already exists`);
    const wh = new Warehouse({ aisles: [1], bays: 2, levels: 1, positions: [10], outLanes: 1, clock: this.clock });
    if (preset) wh.applyPreset(preset);
    const place = {};
    if (country) place.country = country;
    if (timeZone) place.timeZone = timeZone;
    if (Object.keys(place).length) wh.setConfig(place);
    wh.siteId = siteId;
    const label = String(name || siteId).trim() || siteId;
    this.db.prepare('INSERT INTO extra_sites (id, name, created_at, state) VALUES (?, ?, ?, ?)').run(siteId, label, this.now(), JSON.stringify(wh));
    return { id: siteId, name: label };
  }

  get siteId() {
    return this._siteContext.getStore()?.id || this._defaultSite || 'MAIN';
  }

  set siteId(id) {
    const context = this._siteContext.getStore();
    if (context) context.id = id;
    else this._defaultSite = id;
  }

  _withSite(siteId, fn) {
    return this._siteContext.run({ id: siteId || 'MAIN' }, fn);
  }

  startTransfer({ from = 'MAIN', to, itemNo, qty, id, by = 'office' } = {}) {
    const source = String(from || 'MAIN').toUpperCase();
    const dest = String(to || '').trim().toUpperCase();
    if (!dest || dest === source) throw new Error('Choose a different warehouse');
    const destWh = this.warehouse(dest);
    if (!destWh.items[itemNo]) throw new Error(`Warehouse ${dest} has no item ${itemNo}`);
    const transferId = String(id || `TR${this.now().toString(36)}`).toUpperCase();
    return this._withSite(source, () => this.exec('shipTransfer', { id: transferId, itemNo, qty, toSite: dest, fromSite: source }, by));
  }

  receiveTransfer({ id, from = 'MAIN', to, by = 'office' } = {}) {
    const source = String(from || 'MAIN').toUpperCase();
    const dest = String(to || '').trim().toUpperCase();
    const record = this.warehouse(source).siteTransfers && this.warehouse(source).siteTransfers[String(id).toUpperCase()];
    if (!record || record.status !== 'in-transit') throw new Error(`Transfer ${id} is not in transit`);
    if (record.toSite !== dest) throw new Error(`Transfer ${id} is for ${record.toSite}`);
    const imported = this._withSite(dest, () => this.exec('receiveSiteTransfer', record, by));
    this._withSite(source, () => this.exec('completeSiteTransfer', { id: record.id }, by));
    return { ...record, status: 'received', holder: imported.holder.id };
  }

  cancelTransfer({ id, from = 'MAIN', by = 'office' } = {}) {
    const source = String(from || 'MAIN').toUpperCase();
    return this._withSite(source, () => this.exec('cancelSiteTransfer', { id }, by));
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
    this._after(op);
    return result;
  }

  exec(op, args = {}, by = 'unknown') {
    if (!COMMANDS[op]) throw new Error(`Unknown command ${op}`);
    if (op !== 'enableDemandReplenishment' && this.warehouse(this.siteId).replenishmentVersion !== 1) {
      this.exec('enableDemandReplenishment', {}, 'system');
    }
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
    this._after(op);
    return result;
  }

  /** After a command is stored. Alerts and connectors must not undo it. */
  _after(op) {
    if (op === 'noteTracking' || op === 'recordAlert' || op === 'enableDemandReplenishment') return;
    if (typeof this.afterCommand !== 'function') return;
    try { this.afterCommand(op); } catch (e) { /* the stock change stands */ }
  }

  /** Clock tick: journaled only when it changed something (timers ran out, a truck got a job). */
  tick() {
    if (this.wh.replenishmentVersion !== 1) this.exec('enableDemandReplenishment', {}, 'system');
    const t = this.now();
    const before = this.wh.events[0];
    this.replayT = t;
    try { COMMANDS.tick(this.wh); } finally { this.replayT = null; }
    if (this.wh.events[0] !== before) this._journal(t, 'tick', {}, 'system');
    this._after('tick');
  }

  _journal(t, op, args, by) {
    const r = this._insert.run(t, op, JSON.stringify(args), by);
    this.lastId = Number(r.lastInsertRowid);
    if (++this.sinceSnapshot >= SNAPSHOT_EVERY) this.snapshot();
  }

  snapshot() {
    this.db.prepare('INSERT INTO snapshots (journal_id, t, state) VALUES (?, ?, ?)').run(this.lastId, this.now(), JSON.stringify(this.wh));
    // Only the newest is read; one more is kept in case that one cannot be.
    this.db.prepare('DELETE FROM snapshots WHERE id NOT IN (SELECT id FROM snapshots ORDER BY id DESC LIMIT ?)').run(SNAPSHOTS_KEPT);
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

  exportBackup() {
    return require('./backup-json').exportJson(this.db, this.now());
  }

  importBackup(data) {
    require('./backup-json').importJson(this.db, data, this.now());
    this._upgrade();
    this.load();
    return { journal: data.journal.length, users: (data.users || []).length, schema: this.upgradeReport && this.upgradeReport.to };
  }
}

module.exports = { Store };
