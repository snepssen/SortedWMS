const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { upgradeDatabase, readVersion, SCHEMA_VERSION } = require('../server/upgrades');
const { Store } = require('../server/store');

function oldFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sorted-old-'));
  const file = path.join(dir, 'old.db');
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE journal (id INTEGER PRIMARY KEY AUTOINCREMENT, t INTEGER NOT NULL, op TEXT NOT NULL, args TEXT NOT NULL, by TEXT);
    CREATE TABLE snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, journal_id INTEGER NOT NULL, t INTEGER NOT NULL, state TEXT NOT NULL);
    INSERT INTO meta (key, value) VALUES ('site', '{"name":"Old shed"}');
    INSERT INTO journal (t, op, args, by) VALUES (100, 'tick', '{}', 'keeper');
  `);
  db.close();
  return { dir, file, backups: path.join(dir, 'backups') };
}

test('an old database gains the later tables, keeps its journal, and a second run does nothing', () => {
  const { dir, file, backups } = oldFile();
  const db = new DatabaseSync(file);
  try {
    assert.equal(readVersion(db, 'schemaVersion'), 0);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'extra_sites'").get(), undefined);
    const first = upgradeDatabase(db, { backupDir: backups, now: () => 1_700_000_000_000 });
    assert.equal(first.to, SCHEMA_VERSION);
    assert.equal(first.applied.map((step) => step.id).join(','), 'baseline,extra-sites,upgrade-log');
    assert.ok(first.backup && first.backup.file.startsWith('sorted-'));
    assert.equal(fs.existsSync(first.backup.path), true);
    assert.match(first.lines[0], /backup sorted-/);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM journal').get().n, 1);
    assert.equal(JSON.parse(db.prepare("SELECT value FROM meta WHERE key = 'site'").get().value).name, 'Old shed');
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = 'extra_sites'").get());
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = 'upgrade_log'").get());
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM upgrade_log').get().n, first.applied.length);
    const again = upgradeDatabase(db, { backupDir: backups, now: () => 1_700_000_100_000 });
    assert.deepEqual(again.applied, []);
    assert.equal(again.backup, null);
    assert.match(again.lines[0], /nothing pending/);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM upgrade_log').get().n, first.applied.length);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM journal').get().n, 1);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a module step runs once', () => {
  const { dir, file, backups } = oldFile();
  const db = new DatabaseSync(file);
  const modules = [{
    id: 'billing',
    upgrades: [{
      version: 1,
      id: 'billing-marker',
      up(database) {
        database.prepare("INSERT INTO module_settings (module, key, value) VALUES ('billing', 'storage', 'kept')").run();
      },
    }],
  }];
  try {
    const first = upgradeDatabase(db, { modules, backupDir: backups, now: () => 50 });
    assert.ok(first.applied.some((step) => step.scope === 'billing' && step.id === 'billing-marker'));
    assert.equal(db.prepare("SELECT value FROM module_settings WHERE module = 'billing'").get().value, 'kept');
    const again = upgradeDatabase(db, { modules, backupDir: backups, now: () => 60 });
    assert.deepEqual(again.applied, []);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM module_settings').get().n, 1);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a failing step rolls the upgrade back and leaves the backup', () => {
  const { dir, file, backups } = oldFile();
  const db = new DatabaseSync(file);
  try {
    upgradeDatabase(db, { backupDir: backups, now: () => 10 });
    const siteBefore = db.prepare("SELECT value FROM meta WHERE key = 'site'").get().value;
    const versionBefore = readVersion(db, 'schemaVersion');
    const logBefore = db.prepare('SELECT COUNT(*) AS n FROM upgrade_log').get().n;
    const copiesBefore = fs.readdirSync(backups).length;
    assert.throws(() => upgradeDatabase(db, {
      core: [{
        version: versionBefore + 1,
        id: 'boom',
        up(database) {
          database.exec('CREATE TABLE ghost (id INTEGER)');
          database.prepare("UPDATE meta SET value = '\"changed\"' WHERE key = 'site'").run();
          throw new Error('disk full');
        },
      }],
      backupDir: backups,
      now: () => 20,
    }), /disk full[\s\S]*Rolled back to schema/);
    assert.equal(readVersion(db, 'schemaVersion'), versionBefore);
    assert.equal(db.prepare("SELECT value FROM meta WHERE key = 'site'").get().value, siteBefore);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'ghost'").get(), undefined);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM upgrade_log').get().n, logBefore);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM journal').get().n, 1);
    assert.ok(fs.readdirSync(backups).length > copiesBefore);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the store upgrades on start and again when an old backup is imported', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sorted-store-'));
  const file = path.join(dir, 'live.db');
  const site = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'server', 'site.blank.json'), 'utf8'));
  const store = new Store({ file, site, moduleUpgrades: [] });
  try {
    assert.equal(store.upgradeReport.to, SCHEMA_VERSION);
    assert.match(store.upgradeLines.join('\n'), /backup sorted-/);
    store.exec('addCategory', { code: 'TOOLS', name: 'Tools' }, 'admin');
    const dump = store.exportBackup();
    dump.meta = dump.meta.filter((row) => row.key !== 'schemaVersion');
    const fresh = new Store({ file: ':memory:', site, moduleUpgrades: [] });
    const imported = fresh.importBackup(dump);
    assert.equal(imported.schema, SCHEMA_VERSION);
    assert.equal(fresh.wh.categories.TOOLS, 'Tools');
    assert.match(fresh.upgradeLines.join('\n'), /baseline/);
    fresh.close();
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
