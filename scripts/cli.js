#!/usr/bin/env node
/*
 * The SortedWMS command line, behind ./start.sh:
 *
 *   ./start.sh                 start the server (data/sorted.db)
 *   ./start.sh demo            start with the demo warehouse when it is empty
 *   ./start.sh sample <kind>   start with sample data: home, maker or 3pl
 *   ./start.sh backup          copy the database into data/backups now
 *   ./start.sh backups         list the backups
 *   ./start.sh restore <file>  put a backup in place (server stopped)
 *   ./start.sh setup           check what SortedWMS needs, offer to install it
 *
 * PORT, SORTED_DB, SORTED_SITE and SORTED_BACKUP_DIR work as for the server.
 * The demo and each sample keep their own database file (data/demo.db,
 * data/sample-home.db, ...), so trying them never touches your own data.
 * A new database starts from an empty building (server/site.blank.json);
 * the setup wizard does the rest.
 */
'use strict';

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const readline = require('node:readline');

const ROOT = path.join(__dirname, '..');
const [CMD = 'start', ...REST] = process.argv.slice(2);
const own = CMD === 'demo' ? 'demo.db' : CMD === 'sample' && REST[0] ? `sample-${REST[0]}.db` : 'sorted.db';
const dbFile = process.env.SORTED_DB || path.join(ROOT, 'data', own);
const backupDir = process.env.SORTED_BACKUP_DIR || path.join(path.dirname(dbFile), 'backups');
const port = Number(process.env.PORT || 8080);

function ask(question) {
  if (!process.stdin.isTTY) return Promise.resolve('');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a.trim()); }));
}

function portBusy(p) {
  return new Promise((resolve) => {
    const s = net.connect({ port: p, host: '127.0.0.1' }, () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    s.setTimeout(800, () => { s.destroy(); resolve(false); });
  });
}

function size(bytes) {
  return bytes > 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

async function main() {
  const cmd = CMD;
  const rest = REST;
  const backups = require('../server/backups');
  if (cmd === 'backup') {
    if (!fs.existsSync(dbFile)) throw new Error(`No database at ${dbFile} yet. Start SortedWMS once first`);
    const made = backups.backup(dbFile, backupDir, { keep: Number(process.env.SORTED_BACKUP_KEEP) || 14 });
    console.log(`Backed up to ${made.path} (${size(made.bytes)})`);
    return;
  }
  if (cmd === 'backups') {
    const all = backups.listBackups(backupDir);
    if (!all.length) console.log(`No backups in ${backupDir} yet.`);
    for (const b of all) console.log(`${b.file}  ${size(b.bytes)}`);
    return;
  }
  if (cmd === 'restore') {
    let file = rest[0];
    if (!file) throw new Error('Name the backup to restore: ./start.sh restore <file> (./start.sh backups lists them)');
    if (!fs.existsSync(file) && fs.existsSync(path.join(backupDir, file))) file = path.join(backupDir, file);
    if (await portBusy(port)) throw new Error(`SortedWMS is running on port ${port}. Stop it first, then restore`);
    const found = backups.inspect(file);
    const answer = await ask(`Replace ${dbFile} with ${path.basename(file)} (${found.changes} changes, ${found.users} users)? The current file is kept beside it. [Y/n] `);
    if (/^n/i.test(answer)) { console.log('Nothing changed.'); return; }
    const done = backups.restore(file, dbFile);
    console.log(`Restored. ${done.kept ? `The previous database is kept as ${done.kept}.` : ''} Start SortedWMS again to use it.`);
    return;
  }
  if (cmd === 'setup') {
    console.log(`Node ${process.versions.node}: fine. SortedWMS needs nothing else; it keeps its data in ${dbFile}.`);
    return;
  }
  const args = [];
  if (cmd === 'demo') args.push('--seed-demo');
  else if (cmd === 'sample') {
    const kind = rest[0];
    const { SAMPLES } = require('../server/samples');
    if (!SAMPLES[kind]) throw new Error(`Sample is one of ${Object.keys(SAMPLES).join(', ')}`);
    args.push(`--sample=${kind}`);
  } else if (cmd !== 'start') throw new Error(`Unknown command ${cmd}. Use start, demo, sample, backup, backups, restore or setup`);
  process.env.SORTED_DB = dbFile;
  // A real warehouse gets no demo logins with known passwords; the demo and the samples do.
  if (cmd === 'start' && process.env.SORTED_DEMO_USERS === undefined) process.env.SORTED_DEMO_USERS = '0';
  if (!process.env.SORTED_SITE) process.env.SORTED_SITE = path.join(ROOT, 'server', cmd === 'demo' ? 'site.example.json' : 'site.blank.json');
  if (cmd === 'start' && !fs.existsSync(dbFile)) console.log(`A new warehouse in ${dbFile}. Sign in as admin and open /setup to shape it.`);
  process.argv.push(...args);
  require('../server/index').main();
}

main().catch((e) => { console.error(e.message); process.exit(1); });
