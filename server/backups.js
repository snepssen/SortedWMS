/*
 * Backups of the database file. SQLite's VACUUM INTO writes a consistent copy
 * while the server keeps running, so a backup never stops the floor. The
 * server makes one a day into data/backups and keeps the newest 14; the
 * command line and the Settings screen make one on demand.
 *
 * A restore replaces the database file, so it only runs with the server
 * stopped, and it keeps the file it replaces next to it first.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DAY = 86400000;
const NAME = /^sorted-(\d{4})-(\d{2})-(\d{2})-(\d{6})\.db$/;

function stamp(ms) {
  const d = new Date(ms);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

function listBackups(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => NAME.test(f))
    .map((f) => { const st = fs.statSync(path.join(dir, f)); return { file: f, path: path.join(dir, f), bytes: st.size, at: st.mtimeMs }; })
    .sort((a, b) => b.file.localeCompare(a.file));
}

/** Copy the database into `dir` and keep the newest `keep` copies. `db` is an open DatabaseSync or a file path. */
function backup(db, dir, { keep = 14, now = Date.now() } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  let target = path.join(dir, `sorted-${stamp(now)}.db`);
  for (let n = 1; fs.existsSync(target); n++) target = path.join(dir, `sorted-${stamp(now + n * 1000)}.db`);
  const own = typeof db === 'string';
  const handle = own ? new DatabaseSync(db, { readOnly: true }) : db;
  try {
    handle.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  } finally {
    if (own) handle.close();
  }
  const all = listBackups(dir);
  for (const old of all.slice(Math.max(1, keep))) fs.rmSync(old.path, { force: true });
  return { file: path.basename(target), path: target, bytes: fs.statSync(target).size };
}

/** Check that a file is a SortedWMS database before it replaces the live one. */
function inspect(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const has = (t) => Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(t));
    if (!has('journal')) throw new Error(`${path.basename(file)} is not a SortedWMS database (no journal)`);
    const changes = db.prepare('SELECT COUNT(*) AS n FROM journal').get().n;
    const users = has('users') ? db.prepare('SELECT COUNT(*) AS n FROM users').get().n : 0;
    return { changes, users };
  } finally {
    db.close();
  }
}

/** Put a backup in place of the live database. The server must be stopped. */
function restore(file, dbFile, { now = Date.now() } = {}) {
  if (!fs.existsSync(file)) throw new Error(`No backup at ${file}`);
  const found = inspect(file);
  let kept = null;
  if (fs.existsSync(dbFile)) {
    kept = `${dbFile}.before-restore-${stamp(now)}`;
    fs.copyFileSync(dbFile, kept);
  }
  for (const side of ['-wal', '-shm']) fs.rmSync(dbFile + side, { force: true });
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  fs.copyFileSync(file, dbFile);
  return { restored: file, into: dbFile, kept, ...found };
}

/** The daily backup the server runs: one now if the newest is a day old, then a check every hour. */
function schedule(store, dir, { keep = 14, log = console.log, every = 3600000 } = {}) {
  const due = () => {
    const newest = listBackups(dir)[0];
    if (newest && Date.now() - newest.at < DAY) return;
    try {
      const made = backup(store.db, dir, { keep });
      log(`Backup ${made.file} (${Math.round(made.bytes / 1024)} KB) in ${dir}`);
    } catch (e) {
      log(`Backup failed: ${e.message}`);
    }
  };
  due();
  const timer = setInterval(due, every);
  if (timer.unref) timer.unref();
  return { stop: () => clearInterval(timer), now: () => backup(store.db, dir, { keep }), list: () => listBackups(dir), dir };
}

module.exports = { backup, restore, inspect, listBackups, schedule, stamp };
