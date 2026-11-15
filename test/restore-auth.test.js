const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../server/store');
const { createAuth } = require('../server/auth');
const { backup, restore } = require('../server/backups');
const { copyDatabase } = require('../server/backup-offsite');
const { TRANSIENT } = require('../server/backup-state');
const site = require('../server/site.blank.json');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sorted-restore-auth-'));
  const store = new Store({ site, file: path.join(dir, 'source.db') });
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const auth = createAuth(store.db);
  auth.ensureAdmin({ username: 'admin', password: 'example-admin-password', displayName: 'Admin' });
  auth.login('admin', 'example-admin-password');
  store.db.prepare('INSERT INTO mfa_challenges VALUES (?, ?, ?)').run('old-mfa', 1, Date.now() + 60000);
  store.db.prepare('INSERT INTO pair_tokens (token_hash, code, user_id, created_by, expires_at, used_at) VALUES (?, ?, ?, ?, ?, ?)').run('old-pair', '123456', 1, 1, Date.now() + 60000, null);
  store.db.prepare('INSERT INTO pair_failures VALUES (?, ?, ?)').run('old-device', 5, Date.now() + 60000);
  return { dir, source: store, file: backup(store.db, path.join(dir, 'backups')).path };
}

function checkAuth(db) {
  for (const name of TRANSIENT) assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${name}`).get().n, 0, name);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1);
  assert.ok(createAuth(db).login('admin', 'example-admin-password').token, 'restored credentials still permit a fresh login');
}

test('plain file restore does not revive sessions or authentication challenges', (t) => {
  const { dir, source, file } = fixture(t);
  const destination = path.join(dir, 'restored.db');
  restore(file, destination);
  const recovered = new Store({ site, file: destination });
  try { checkAuth(recovered.db); } finally { recovered.close(); }
  assert.equal(source.db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 1, 'creating and restoring a copy does not sign out the source');
});

test('off-site table restore invalidates both saved and currently active logins', (t) => {
  const { file } = fixture(t);
  const recovered = new Store({ site });
  try {
    const auth = createAuth(recovered.db);
    auth.ensureAdmin({ username: 'current', password: 'example-current-password', displayName: 'Current' });
    auth.login('current', 'example-current-password');
    copyDatabase(recovered, file);
    recovered.load();
    checkAuth(recovered.db);
  } finally { recovered.close(); }
});
