/*
 * Data upgrades for the SQLite store.
 *
 * The database remembers how far it has come: `schemaVersion` in meta for
 * the core, and `moduleVersion:<id>` for each module. On start, and again
 * after a backup import, every pending step runs in one transaction. A step
 * is applied once; running again does nothing. A file database is copied
 * before the first pending step. If a step throws, the transaction rolls
 * back and the copy is left for the operator.
 *
 * Steps must be safe to run twice (create-if-missing, insert-or-ignore).
 * Importing an old backup can rewind the version counter, and the steps
 * then run again.
 */
'use strict';

const fs = require('node:fs');

const CORE_STEPS = [
  {
    version: 1,
    id: 'baseline',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
        CREATE TABLE IF NOT EXISTS journal (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          t INTEGER NOT NULL,
          op TEXT NOT NULL,
          args TEXT NOT NULL,
          by TEXT
        );
        CREATE TABLE IF NOT EXISTS snapshots (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          journal_id INTEGER NOT NULL,
          t INTEGER NOT NULL,
          state TEXT NOT NULL
        );
      `);
    },
  },
  {
    version: 2,
    id: 'extra-sites',
    up(db) {
      // Warehouses besides the first one. An old database has only the main journal.
      db.exec(`
        CREATE TABLE IF NOT EXISTS extra_sites (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          state TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS extra_journal (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          site TEXT NOT NULL,
          t INTEGER NOT NULL,
          op TEXT NOT NULL,
          args TEXT NOT NULL,
          by TEXT
        );
      `);
    },
  },
  {
    version: 3,
    id: 'upgrade-log',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS upgrade_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          t INTEGER NOT NULL,
          scope TEXT NOT NULL,
          version INTEGER NOT NULL,
          step TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS module_settings (
          module TEXT NOT NULL,
          key TEXT NOT NULL,
          value TEXT NOT NULL,
          PRIMARY KEY (module, key)
        );
      `);
    },
  },
];

const SCHEMA_VERSION = CORE_STEPS[CORE_STEPS.length - 1].version;

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function readVersion(db, key) {
  if (!tableExists(db, 'meta')) return 0;
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  if (!row) return 0;
  try {
    const n = JSON.parse(row.value);
    return Number.isFinite(Number(n)) ? Number(n) : 0;
  } catch (e) {
    return 0;
  }
}

function writeVersion(db, key, version) {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(version));
}

function pendingSteps(db, { core = CORE_STEPS, modules = [] } = {}) {
  const corePending = core
    .filter((step) => step.version > readVersion(db, 'schemaVersion'))
    .map((step) => ({ ...step, scope: 'core', key: 'schemaVersion' }));
  const modulePending = [];
  const list = [...modules].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  for (const mod of list) {
    const key = `moduleVersion:${mod.id}`;
    const current = readVersion(db, key);
    const steps = [...(mod.upgrades || [])].sort((a, b) => a.version - b.version);
    for (const step of steps) {
      if (step.version > current) modulePending.push({ ...step, scope: mod.id, key });
    }
  }
  return corePending.sort((a, b) => a.version - b.version).concat(modulePending);
}

/**
 * Apply pending core and module steps. `modules` is `{ id, upgrades }[]`.
 * Returns `{ from, to, applied, backup, lines }`. Throws after a rollback.
 */
function upgradeDatabase(db, {
  core = CORE_STEPS,
  modules = [],
  file = null,
  backupDir = null,
  now = () => Date.now(),
  backupFn = null,
} = {}) {
  const lines = [];
  const say = (line) => lines.push(line);
  const pending = pendingSteps(db, { core, modules });
  const from = readVersion(db, 'schemaVersion');
  if (!pending.length) {
    say(`Data upgrades: schema ${from}, nothing pending`);
    return { from, to: from, applied: [], backup: null, lines };
  }
  const toCore = pending.reduce((n, step) => (step.scope === 'core' ? Math.max(n, step.version) : n), from);
  let made = null;
  if (backupDir) {
    const copy = backupFn || require('./backups').backup;
    fs.mkdirSync(backupDir, { recursive: true });
    made = copy(db, backupDir, { keep: 14, now: now() });
    say(`Data upgrades: backup ${made.file} before ${pending.length} step(s), schema ${from} -> ${toCore}`);
  } else if (file && file !== ':memory:') {
    say(`Data upgrades: ${pending.length} step(s), schema ${from} -> ${toCore}, no backup directory set`);
  } else {
    say(`Data upgrades: ${pending.length} step(s), schema ${from} -> ${toCore}, in-memory database, no file backup`);
  }
  const applied = [];
  db.exec('BEGIN');
  try {
    // The log table has to exist before the first step, so a failure rolls it back with the rest.
    db.exec(`CREATE TABLE IF NOT EXISTS upgrade_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      t INTEGER NOT NULL,
      scope TEXT NOT NULL,
      version INTEGER NOT NULL,
      step TEXT NOT NULL
    )`);
    for (const step of pending) {
      step.up(db, { now: now(), scope: step.scope });
      const version = step.version;
      writeVersion(db, step.key, version);
      db.prepare('INSERT INTO upgrade_log (t, scope, version, step) VALUES (?, ?, ?, ?)').run(now(), step.scope, version, step.id);
      applied.push({ scope: step.scope, version, id: step.id });
      say(`Data upgrades: ${step.scope} ${version} ${step.id}`);
    }
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (ignore) { /* already rolled back */ }
    const failed = pending[applied.length] || pending[0];
    const where = made ? ` Backup kept: ${made.file}.` : '';
    throw new Error(`Data upgrade failed on ${failed.scope} ${failed.id}: ${e.message}. Rolled back to schema ${from}.${where}`);
  }
  say(`Data upgrades: now at schema ${readVersion(db, 'schemaVersion')}`);
  return { from, to: readVersion(db, 'schemaVersion'), applied, backup: made, lines };
}

module.exports = { CORE_STEPS, SCHEMA_VERSION, upgradeDatabase, readVersion, pendingSteps };
