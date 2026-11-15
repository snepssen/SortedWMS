// Version-1 exports keep their original fields. Optional moduleTables adds
// persistent module state; schemas always come from the installed application.
'use strict';

const CORE = ['meta', 'journal', 'snapshots', 'extra_sites', 'extra_journal', 'users', 'role_permissions', 'upgrade_log', 'module_settings'];
const { TRANSIENT } = require('./backup-state');
// Photo bytes follow the same rules as external photo files: JSON preserves
// metadata, while .db/.db.enc backups carry the actual images.
const EXTERNAL = ['backup_item_photos'];
const quote = (name) => '"' + name.replace(/"/g, '""') + '"';
const tables = (db) => db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((row) => row.name);
const persistent = (name) => !CORE.includes(name) && !TRANSIENT.includes(name) && !EXTERNAL.includes(name);
const encode = (value) => value instanceof Uint8Array ? { $sqliteBlob: Buffer.from(value).toString('base64') } : value;

function decode(value) {
  if (value === null || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) return value;
  if (value && typeof value === 'object' && Object.keys(value).length === 1 && typeof value.$sqliteBlob === 'string') {
    const bytes = Buffer.from(value.$sqliteBlob, 'base64');
    if (bytes.toString('base64') === value.$sqliteBlob) return bytes;
  }
  throw new Error('Backup values must be SQLite values or valid encoded binary data');
}

function exportJson(db, now) {
  db.exec('SAVEPOINT json_backup');
  try {
    const names = tables(db);
    const rows = (name) => names.includes(name)
      ? db.prepare(`SELECT * FROM ${quote(name)}`).all().map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, encode(value)])))
      : [];
    const result = {
      version: 1, exportedAt: now,
      ...Object.fromEntries(CORE.map((name) => [name, rows(name)])),
      moduleTables: Object.fromEntries(names.filter(persistent).map((name) => [name, rows(name)])),
    };
    db.exec('RELEASE json_backup');
    return result;
  } catch (e) {
    db.exec('ROLLBACK TO json_backup');
    db.exec('RELEASE json_backup');
    throw e;
  }
}

function importJson(db, data, now) {
  if (!data || data.version !== 1 || !Array.isArray(data.journal)) throw new Error('Backup must be a version 1 export');
  if (data.journal.length > 200000) throw new Error('Backup is too large');
  for (const row of data.journal) {
    if (!row || typeof row.op !== 'string' || typeof row.args !== 'string' || !Number.isFinite(Number(row.t))) throw new Error('A journal row needs t, op and args');
  }
  const modules = data.moduleTables === undefined ? {} : data.moduleTables;
  if (!modules || typeof modules !== 'object' || Array.isArray(modules)) throw new Error('Backup moduleTables must contain table rows');
  for (const name of Object.keys(modules)) {
    if (!persistent(name)) throw new Error(`Backup table ${name} cannot be supplied in moduleTables`);
  }
  const names = tables(db);
  const incoming = [...CORE.map((name) => [name, data[name] === undefined ? [] : data[name]]), ...Object.entries(modules)];
  // Validate table names, columns and encodings before changing any live rows.
  const validated = incoming.map(([name, rows]) => {
    if (!Array.isArray(rows)) throw new Error(`Backup table ${name} must contain rows`);
    if (!names.includes(name)) {
      if (!rows.length && CORE.includes(name)) return [name, []];
      throw new Error(`Backup table ${name} is unavailable; install its module before importing`);
    }
    const columns = new Set(db.prepare(`PRAGMA table_info(${quote(name)})`).all().map((column) => column.name));
    return [name, rows.map((row) => {
      if (!row || typeof row !== 'object' || Array.isArray(row) || !Object.keys(row).length) throw new Error(`Backup table ${name} has an invalid row`);
      return Object.fromEntries(Object.entries(row).map(([column, value]) => {
        if (!columns.has(column)) throw new Error(`Backup table ${name} has an unknown column ${column}`);
        return [column, decode(value)];
      }));
    })];
  });
  db.exec('BEGIN');
  try {
    for (const name of names.filter((name) => !EXTERNAL.includes(name))) db.exec(`DELETE FROM ${quote(name)}`);
    for (const [name, rows] of validated) {
      const statements = new Map();
      for (const row of rows) {
        const columns = Object.keys(row).sort();
        const sql = `INSERT INTO ${quote(name)} (${columns.map(quote).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`;
        if (!statements.has(sql)) statements.set(sql, db.prepare(sql));
        statements.get(sql).run(...columns.map((column) => row[column]));
      }
    }
    if (names.includes('auth_audit')) db.prepare('INSERT INTO auth_audit (t, action, by, detail) VALUES (?, ?, ?, ?)').run(now, 'backup-import', 'backup', JSON.stringify({ journal: data.journal.length }));
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

module.exports = { exportJson, importJson };
