const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { Store } = require('../server/store');
const { createAuth } = require('../server/auth');
const { createApi } = require('../server/api');
const { permissionFor } = require('../server/permissions');
const { encrypt, decrypt, HEADER_LEN } = require('../server/backup-crypto');
const { signRequest } = require('../server/sigv4');
const { createOffsite, selectRetention, isDue, decryptToFile } = require('../server/backup-offsite');
const registry = require('../modules/registry');

const site = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'site.json'), 'utf8'));
const PASSPHRASE = 'correct-horse-battery';

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sorted-offsite-'));
}

test('encrypt and decrypt round trip, a wrong passphrase fails cleanly, and tampering is detected', () => {
  const plain = Buffer.from('SQLite format 3\0sorted-offsite-round-trip');
  const enc = encrypt(plain, PASSPHRASE);
  assert.ok(enc.length > HEADER_LEN);
  assert.equal(enc.subarray(0, 4).toString(), 'SWBK');
  assert.deepEqual(decrypt(enc, PASSPHRASE), plain);
  assert.throws(() => decrypt(enc, 'wrong-passphrase'), /Wrong passphrase/);
  assert.throws(() => decrypt(enc, ''), /Wrong passphrase/);
  const tampered = Buffer.from(enc);
  tampered[HEADER_LEN + 4] ^= 0xff;
  assert.throws(() => decrypt(tampered, PASSPHRASE), /The backup was altered/);
  assert.equal(enc.includes(Buffer.from(PASSPHRASE)), false);
});

test('retention keeps the newest daily, weekly and monthly copies in the local timezone', () => {
  const at = (day) => Date.parse(`${day}T12:00:00Z`);
  const files = [
    { name: 'jan10', at: at('2026-01-10') },
    { name: 'jan3', at: at('2026-01-03') },
    { name: 'jan2', at: at('2026-01-02') },
    { name: 'jan1', at: at('2026-01-01') },
    { name: 'dec1', at: at('2025-12-01') },
  ];
  const { keep, drop } = selectRetention(files, { daily: 1, weekly: 2, monthly: 2, timeZone: 'UTC' });
  assert.deepEqual(keep.map((f) => f.name).sort(), ['dec1', 'jan10', 'jan3']);
  assert.deepEqual(drop.map((f) => f.name).sort(), ['jan1', 'jan2']);
  // 2026-01-15 07:30 UTC is 02:30 in New York (EST). 02:30 UTC is still the previous evening there.
  const tz = 'America/New_York';
  const prev = Date.parse('2026-01-14T07:30:00Z');
  const slot = Date.parse('2026-01-15T07:30:00Z');
  assert.equal(isDue({ mode: 'daily', dailyTime: '02:30', timeZone: tz, now: slot - 60000, lastSuccess: prev }), false);
  assert.equal(isDue({ mode: 'daily', dailyTime: '02:30', timeZone: tz, now: Date.parse('2026-01-15T02:30:00Z'), lastSuccess: prev }), false);
  assert.equal(isDue({ mode: 'daily', dailyTime: '02:30', timeZone: tz, now: slot, lastSuccess: prev }), true);
  assert.equal(isDue({ mode: 'daily', dailyTime: '02:30', timeZone: tz, now: slot + 60000, lastSuccess: slot }), false);
  assert.equal(isDue({ mode: 'daily', dailyTime: '02:30', timeZone: tz, now: Date.parse('2026-01-16T07:30:00Z'), lastSuccess: slot }), true);
  // July is EDT, so 02:30 local is 06:30 UTC, not 07:30.
  assert.equal(isDue({ mode: 'daily', dailyTime: '02:30', timeZone: tz, now: Date.parse('2026-07-15T06:29:00Z'), lastSuccess: null }), false);
  assert.equal(isDue({ mode: 'daily', dailyTime: '02:30', timeZone: tz, now: Date.parse('2026-07-15T06:30:00Z'), lastSuccess: null }), true);
  const start = Date.parse('2026-03-01T00:00:00Z');
  assert.equal(isDue({ mode: 'interval', intervalHours: 6, timeZone: tz, now: start + 6 * 3600000 - 1, lastSuccess: start }), false);
  assert.equal(isDue({ mode: 'interval', intervalHours: 6, timeZone: tz, now: start + 6 * 3600000, lastSuccess: start }), true);
});

test('SigV4 matches the published AWS GET example', () => {
  // Public documentation example. Not a real key.
  const signed = signRequest({
    method: 'GET',
    url: 'https://examplebucket.s3.amazonaws.com/test.txt',
    headers: {
      host: 'examplebucket.s3.amazonaws.com',
      range: 'bytes=0-9',
      'x-amz-content-sha256': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      'x-amz-date': '20130524T000000Z',
    },
    body: Buffer.alloc(0),
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    region: 'us-east-1',
    amzDate: '20130524T000000Z',
  });
  assert.equal(signed.signature, 'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
  assert.match(signed.authorization, /SignedHeaders=host;range;x-amz-content-sha256;x-amz-date/);
});

test('a folder target uploads, prunes, and restores, and the passphrase stays out of the export', async () => {
  const dir = tmp();
  const folder = path.join(dir, 'nas');
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, 'sorted-2020-01-01-000000.db.enc'), Buffer.from('old'));
  const store = new Store({ site, now: () => Date.parse('2026-01-15T12:00:00Z') });
  const auth = createAuth(store.db);
  auth.ensureAdmin({ username: 'admin', password: 'sorted-admin', displayName: 'Administrator' });
  store.exec('setConfig', { patch: { timeZone: 'UTC' } }, 'admin');
  const logs = [];
  const offsite = createOffsite({
    store,
    secretsFile: path.join(dir, 'offsite-secrets.json'),
    env: {},
    log: (line) => logs.push(line),
    now: () => Date.parse('2026-01-15T12:00:00Z'),
  });
  offsite.save({
    passphrase: PASSPHRASE,
    mode: 'daily',
    dailyTime: '02:30',
    retainDaily: 1,
    retainWeekly: 0,
    retainMonthly: 0,
    testDecrypt: true,
    target: { id: 'nas', kind: 'folder', path: folder },
  });
  const made = await offsite.run('admin');
  assert.equal(made.file, 'sorted-2026-01-15-120000.db.enc');
  assert.equal(fs.existsSync(path.join(folder, 'sorted-2020-01-01-000000.db.enc')), false, 'the old daily copy is pruned');
  const enc = fs.readFileSync(path.join(folder, made.file));
  assert.equal(enc.includes(Buffer.from(PASSPHRASE)), false);
  const plain = decrypt(enc, PASSPHRASE);
  const plainFile = path.join(dir, 'opened.db');
  fs.writeFileSync(plainFile, plain);
  const opened = new DatabaseSync(plainFile, { readOnly: true });
  const user = opened.prepare('SELECT password_hash FROM users WHERE username = ?').get('admin');
  assert.ok(user.password_hash);
  assert.notEqual(user.password_hash, 'sorted-admin');
  const savedCfg = opened.prepare('SELECT json FROM offsite_config').get();
  assert.equal(String(savedCfg.json).includes(PASSPHRASE), false);
  opened.close();
  const exported = JSON.stringify(store.exportBackup());
  assert.match(exported, /password_hash/);
  assert.equal(exported.includes(PASSPHRASE), false);
  assert.equal(JSON.stringify(await offsite.status()).includes(PASSPHRASE), false);
  assert.equal(logs.join('\n').includes(PASSPHRASE), false);
  const secrets = JSON.parse(fs.readFileSync(path.join(dir, 'offsite-secrets.json'), 'utf8'));
  assert.equal(secrets.passphrase, PASSPHRASE);

  const before = store.wh.config.aisleCap;
  store.exec('setConfig', { patch: { aisleCap: 9 } }, 'admin');
  assert.equal(store.wh.config.aisleCap, 9);
  const restored = await offsite.restore({ targetId: 'nas', name: made.file });
  assert.equal(store.wh.config.aisleCap, before);
  assert.ok(restored.lines.some((line) => /Data upgrades/.test(line)));
  assert.equal(JSON.stringify(restored).includes(PASSPHRASE), false);

  const view = await offsite.status();
  assert.equal(view.passphraseSet, true);
  assert.equal(view.passphraseFromEnv, false);
  assert.equal(view.targets[0].credentialsSet, false);
  assert.equal(view.targets[0].path, folder);
  store.close();
});

test('a failed backup is journaled and raised only when alerts is on', async () => {
  const dir = tmp();
  const blocker = path.join(dir, 'not-a-directory');
  fs.writeFileSync(blocker, 'x');
  const store = new Store({ site });
  const seen = [];
  const stop = registry.register({
    id: 'alerts',
    name: 'Alerts',
    description: 'Stub for the off-site failure hook',
    version: 1,
    upgrades: [{ version: 1, id: 'alerts-stub', up() {} }],
    raise(s, event) { seen.push(event); },
  });
  try {
    const offsite = createOffsite({ store, secretsFile: path.join(dir, 'secrets.json'), env: { SORTED_BACKUP_PASSPHRASE: PASSPHRASE }, log() {} });
    offsite.save({ target: { id: 'bad', kind: 'folder', path: path.join(blocker, 'backups') } });
    await assert.rejects(offsite.run('admin'), /not a directory|ENOTDIR|not a dir/i);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].type, 'backup.failed');
    assert.equal(JSON.stringify(seen[0]).includes(PASSPHRASE), false);
    const row = store.db.prepare('SELECT ok, summary FROM offsite_runs ORDER BY id DESC LIMIT 1').get();
    assert.equal(row.ok, 0);
    assert.equal(String(row.summary).includes(PASSPHRASE), false);
    store.wh.setModules({ alerts: false });
    await assert.rejects(offsite.run('admin'));
    assert.equal(seen.length, 1, 'alerts is off, so the failure stays in the journal only');
  } finally {
    stop();
    store.close();
  }
});

test('S3 signing uploads and reads back through a stand-in, and WebDAV refuses HTTP', async () => {
  const objects = new Map();
  const transport = async ({ method, url, headers, body }) => {
    const u = new URL(url);
    assert.match(headers.authorization, /^AWS4-HMAC-SHA256 /);
    assert.equal(headers.authorization.includes('wJalrXUtnFEMI'), false);
    const key = `${u.pathname}${u.search}`;
    if (method === 'PUT') {
      objects.set(u.pathname, Buffer.from(body));
      return { status: 200, headers: {}, body: Buffer.alloc(0) };
    }
    if (method === 'GET' && u.searchParams.get('list-type')) {
      const parts = [...objects.keys()].map((name) => `<Contents><Key>${name.split('/').pop()}</Key><Size>${objects.get(name).length}</Size><LastModified>2026-01-15T12:00:00.000Z</LastModified></Contents>`);
      return { status: 200, headers: {}, body: Buffer.from(`<ListBucketResult>${parts.join('')}</ListBucketResult>`) };
    }
    if (method === 'GET') {
      const found = objects.get(u.pathname);
      if (!found) return { status: 404, headers: {}, body: Buffer.alloc(0) };
      return { status: 200, headers: {}, body: found };
    }
    if (method === 'DELETE') {
      objects.delete(u.pathname);
      return { status: 204, headers: {}, body: Buffer.alloc(0) };
    }
    return { status: 500, headers: {}, body: Buffer.from('no') };
  };
  const dir = tmp();
  const store = new Store({ site, now: () => Date.parse('2026-01-15T12:00:00Z') });
  store.exec('setConfig', { patch: { timeZone: 'UTC' } }, 'admin');
  const offsite = createOffsite({ store, secretsFile: path.join(dir, 'secrets.json'), env: {}, transport, log() {}, now: () => Date.parse('2026-01-15T12:00:00Z') });
  offsite.save({
    passphrase: PASSPHRASE,
    retainDaily: 7,
    retainWeekly: 0,
    retainMonthly: 0,
    target: {
      id: 'bucket', kind: 's3', endpoint: 'https://s3.amazonaws.com', bucket: 'sorted-example', region: 'us-east-1', prefix: 'main',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    },
  });
  const made = await offsite.run('admin');
  assert.ok(objects.has(`/main/${made.file}`));
  const view = await offsite.status();
  assert.equal(view.targets[0].credentialsSet, true);
  assert.equal(JSON.stringify(view).includes('wJalrXUtnFEMI'), false);
  assert.equal(view.targets[0].files[0].name, made.file);
  assert.throws(() => offsite.save({ target: { id: 'dav', kind: 'webdav', url: 'http://cloud.example/dav/', username: 'ada', password: 'secret-token' } }), /HTTPS/);
  store.close();
});

test('the command line restores an encrypted backup and runs data upgrades', () => {
  const dir = tmp();
  const dbFile = path.join(dir, 'sorted.db');
  const store = new Store({ file: dbFile, site, now: () => Date.parse('2026-01-15T12:00:00Z') });
  createAuth(store.db).ensureAdmin({ username: 'admin', password: 'sorted-admin', displayName: 'Administrator' });
  store.exec('setConfig', { patch: { timeZone: 'UTC', aisleCap: 4 } }, 'admin');
  store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  store.close();
  const encFile = path.join(dir, 'sorted-2026-01-15-120000.db.enc');
  fs.writeFileSync(encFile, encrypt(fs.readFileSync(dbFile), PASSPHRASE));
  const opened = decryptToFile(encFile, PASSPHRASE);
  assert.equal(opened.encrypted, true);
  fs.rmSync(opened.dir, { recursive: true, force: true });
  const replaced = path.join(dir, 'replaced.db');
  fs.copyFileSync(dbFile, replaced);
  const tweak = new Store({ file: replaced, site });
  tweak.exec('setConfig', { patch: { aisleCap: 2 } }, 'admin');
  tweak.close();
  const bad = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'cli.js'), 'restore', encFile], {
    env: { ...process.env, SORTED_DB: replaced, SORTED_BACKUP_PASSPHRASE: 'wrong-passphrase-value', PORT: '59991' },
    encoding: 'utf8',
  });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /Wrong passphrase/);
  assert.equal(bad.stdout.includes('wrong-passphrase-value'), false);
  const good = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'cli.js'), 'restore', encFile], {
    env: { ...process.env, SORTED_DB: replaced, SORTED_BACKUP_PASSPHRASE: PASSPHRASE, SORTED_SITE: path.join(__dirname, '..', 'server', 'site.blank.json'), PORT: '59991' },
    encoding: 'utf8',
  });
  assert.equal(good.status, 0, good.stderr);
  assert.match(good.stdout, /Data upgrades/);
  assert.equal(good.stdout.includes(PASSPHRASE), false);
  assert.equal(good.stderr.includes(PASSPHRASE), false);
  const back = new Store({ file: replaced, site });
  assert.equal(back.wh.config.aisleCap, 4);
  back.close();
});

test('off-site routes need the backups permission and hide when the module is off', async () => {
  assert.equal(permissionFor('POST', '/api/offsite/run').permission, 'backups.offsite');
  assert.equal(permissionFor('POST', '/api/offsite/prune-plain').permission, 'backups.offsite');
  assert.equal(permissionFor('GET', '/api/offsite').permission, 'backups.offsite');
  const store = new Store({ site });
  const offsite = createOffsite({ store, secretsFile: null, env: {}, log() {} });
  const api = createApi({ store, printers: { flush() {} }, offsite });
  store.wh.setModules({ 'backup-offsite': false });
  const denied = await api.handle('GET', '/api/offsite', {}, 'admin');
  assert.equal(denied.status, 404);
  store.wh.setModules({ 'backup-offsite': true });
  const open = await api.handle('GET', '/api/offsite', {}, 'admin');
  assert.equal(open.status, 200);
  assert.equal(open.body.passphraseSet, false);
  assert.equal(open.body.localCopy, 'plain');
  assert.equal(open.body.offerPlainOff, false);
  store.close();
});

test('the plain daily copy stays until a verified encrypted backup, then it can be encrypted or turned off', async () => {
  const dir = tmp();
  const local = path.join(dir, 'local');
  const folder = path.join(dir, 'nas');
  fs.mkdirSync(local);
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(local, 'sorted-2020-01-01-000000.db'), Buffer.from('plain-old'));
  const store = new Store({ site, backupDir: local, now: () => Date.parse('2026-06-01T12:00:00Z') });
  store.exec('setConfig', { patch: { timeZone: 'UTC' } }, 'admin');
  const offsite = createOffsite({
    store,
    secretsFile: path.join(dir, 'secrets.json'),
    env: {},
    log() {},
    now: () => Date.parse('2026-06-01T12:00:00Z'),
  });
  const { schedule } = require('../server/backups');
  assert.equal(offsite.localMode(), 'plain');
  assert.throws(() => offsite.save({ localCopy: 'off' }), /plain daily copy/);
  assert.throws(() => offsite.prunePlain({ confirm: false, dir: local }), /Confirm/);
  assert.equal(fs.existsSync(path.join(local, 'sorted-2020-01-01-000000.db')), true);

  offsite.save({ passphrase: PASSPHRASE, testDecrypt: true, target: { id: 'nas', kind: 'folder', path: folder } });
  assert.equal((await offsite.status()).offerPlainOff, false);
  await offsite.run('admin');
  const offered = await offsite.status();
  assert.equal(offered.offerPlainOff, true);
  assert.equal(offered.localCopy, 'plain', 'a verified run does not turn the plain copy off');
  assert.ok(offered.plainCopies >= 1);

  offsite.save({ localCopy: 'encrypted' });
  const plainBefore = fs.readdirSync(local).filter((name) => name.endsWith('.db') && !name.endsWith('.db.enc'));
  const scheduled = schedule(store, local, {
    keep: 5,
    log() {},
    every: 3600000,
    mode: () => offsite.localMode(),
    writeEncrypted: (opts) => offsite.writeLocalEncrypted(opts),
  });
  scheduled.stop();
  const encName = fs.readdirSync(local).find((name) => name.endsWith('.db.enc'));
  assert.ok(encName);
  const opened = decrypt(fs.readFileSync(path.join(local, encName)), PASSPHRASE);
  assert.equal(opened.subarray(0, 15).toString(), 'SQLite format 3');
  assert.equal(opened.includes(Buffer.from(PASSPHRASE)), false);
  assert.deepEqual(fs.readdirSync(local).filter((name) => name.endsWith('.db') && !name.endsWith('.db.enc')), plainBefore);

  offsite.save({ localCopy: 'off' });
  assert.equal(offsite.localMode(), 'off');
  const lines = [];
  const stopped = schedule(store, local, {
    keep: 5,
    log: (line) => lines.push(line),
    every: 3600000,
    mode: () => offsite.localMode(),
    writeEncrypted: (opts) => offsite.writeLocalEncrypted(opts),
  });
  stopped.stop();
  assert.equal(lines.length, 0);
  assert.throws(() => stopped.now(), /plain daily copy is off/);
  assert.equal(fs.existsSync(path.join(local, 'sorted-2020-01-01-000000.db')), true);
  assert.throws(() => offsite.prunePlain({ confirm: false, dir: local }), /Confirm/);
  assert.equal(fs.existsSync(path.join(local, 'sorted-2020-01-01-000000.db')), true);
  const pruned = offsite.prunePlain({ confirm: true, dir: local });
  assert.ok(pruned.removed >= 1);
  assert.equal(fs.existsSync(path.join(local, 'sorted-2020-01-01-000000.db')), false);
  assert.equal(fs.readdirSync(local).some((name) => name.endsWith('.db') && !name.endsWith('.db.enc')), false);
  assert.equal(fs.existsSync(path.join(local, encName)), true);
  store.close();
});
