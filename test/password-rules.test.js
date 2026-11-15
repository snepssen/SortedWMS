const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Store } = require('../server/store');
const { Printers } = require('../server/print');
const { createServer } = require('../server/index');
const { createAuth } = require('../server/auth');
const { exportJson, importJson } = require('../server/backup-json');

const site = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'site.json'), 'utf8'));
const DAY = 86400000;

function fresh(now) {
  const store = new Store({ site });
  const auth = createAuth(store.db, now ? { now } : {});
  return { store, auth };
}

test('rules start at 8 characters, no history and no expiry; an administrator changes them within limits', () => {
  const { store, auth } = fresh();
  try {
    assert.deepEqual(auth.passwordRules(), { minLength: 8, history: 0, maxAgeDays: 0 });
    assert.deepEqual(auth.setPasswordRules({ minLength: 12 }, 'admin'), { minLength: 12, history: 0, maxAgeDays: 0 }, 'what is left out stays as it was');
    assert.deepEqual(auth.setPasswordRules({ history: 5, maxAgeDays: 90 }, 'admin'), { minLength: 12, history: 5, maxAgeDays: 90 });
    assert.throws(() => auth.setPasswordRules({ minLength: 4 }), /Shortest password is a whole number from 8 to 64/);
    assert.throws(() => auth.setPasswordRules({ history: 25 }), /Earlier passwords refused is a whole number from 0 to 24/);
    assert.throws(() => auth.setPasswordRules({ maxAgeDays: 1.5 }), /whole number from 0 to 730/);
    assert.throws(() => auth.setPasswordRules({ maxAgeDays: 'soon' }), /whole number/);
    assert.deepEqual(auth.passwordRules(), { minLength: 12, history: 5, maxAgeDays: 90 }, 'a refused change changes nothing');
    assert.equal(auth.audit(5).some((row) => row.action === 'password-rules'), true, 'the change is in the sign-in log');
    assert.equal(auth.passwordRuleLimits().minLength.min, 8);
  } finally { store.close(); }
});

test('the shortest length applies to new users, to a password someone else sets, and to a change of one\'s own', () => {
  const { store, auth } = fresh();
  try {
    auth.setPasswordRules({ minLength: 12 });
    assert.throws(() => auth.insertUser({ username: 'kim', password: 'short-one', role: 'picker', displayName: 'Kim' }), /at least 12 characters/);
    const kim = auth.insertUser({ username: 'kim', password: 'long-enough-1', role: 'picker', displayName: 'Kim' });
    assert.throws(() => auth.updateUser(kim.id, { password: 'elevenchars' }), /at least 12 characters/);
    assert.throws(() => auth.changePassword(kim.id, { current: 'long-enough-1', next: 'tooshort' }), /at least 12 characters/);
    auth.changePassword(kim.id, { current: 'long-enough-1', next: 'long-enough-2' });
    assert.ok(auth.login('kim', 'long-enough-2'));
  } finally { store.close(); }
});

test('the accounts a warehouse starts with are made whatever the rules say, and a request cannot claim that exemption', () => {
  const { store, auth } = fresh();
  try {
    auth.setPasswordRules({ minLength: 20 });
    assert.equal(auth.ensureAdmin({ password: 'sorted-admin' }).created, true);
    assert.ok(auth.ensureDemoUsers().includes('picker'));
    assert.throws(() => auth.insertUser({ username: 'sly', password: 'short-one', role: 'picker', displayName: 'Sly', bootstrap: true }), /at least 20 characters/);
  } finally { store.close(); }
});

test('earlier passwords are refused: the last few, the current one, and one from before the rule existed', () => {
  const { store, auth } = fresh();
  try {
    const kim = auth.insertUser({ username: 'kim', password: 'first-password', role: 'picker', displayName: 'Kim' });
    // With no history rule, only the current password is refused.
    assert.throws(() => auth.changePassword(kim.id, { current: 'first-password', next: 'first-password' }), /Choose a different password/);
    auth.changePassword(kim.id, { current: 'first-password', next: 'second-password' });
    auth.changePassword(kim.id, { current: 'second-password', next: 'first-password' });

    auth.setPasswordRules({ history: 2 });
    assert.throws(() => auth.changePassword(kim.id, { current: 'first-password', next: 'second-password' }), /not used for your last 2/);
    auth.changePassword(kim.id, { current: 'first-password', next: 'third-password' });
    assert.throws(() => auth.changePassword(kim.id, { current: 'third-password', next: 'first-password' }), /not used for your last 2/);
    auth.changePassword(kim.id, { current: 'third-password', next: 'fourth-password' });
    // "first-password" is now three back: allowed again with a history of two.
    auth.changePassword(kim.id, { current: 'fourth-password', next: 'first-password' });

    // A password someone else sets is held to the same history.
    assert.throws(() => auth.updateUser(kim.id, { password: 'fourth-password' }), /not used for your last 2/);
    auth.updateUser(kim.id, { password: 'fifth-password' });
    assert.throws(() => auth.changePassword(kim.id, { current: 'fifth-password', next: 'first-password' }), /not used for your last 2/);

    // An account from before this table existed: its current password is remembered at the first change.
    store.db.prepare('DELETE FROM password_history WHERE user_id = ?').run(kim.id);
    auth.changePassword(kim.id, { current: 'fifth-password', next: 'sixth-password' });
    assert.throws(() => auth.changePassword(kim.id, { current: 'sixth-password', next: 'fifth-password' }), /not used for your last 2/);

    auth.setPasswordRules({ history: 1 });
    assert.throws(() => auth.changePassword(kim.id, { current: 'sixth-password', next: 'sixth-password' }), /Choose a different password/);
    assert.equal(JSON.stringify(auth.listUsers()).includes('password_history'), false);
    assert.ok(store.db.prepare('SELECT COUNT(*) AS n FROM password_history WHERE user_id = ?').get(kim.id).n <= 24, 'only the newest few are kept');
  } finally { store.close(); }
});

test('a password older than the limit still signs in, and must then be changed', () => {
  let t = 1_800_000_000_000;
  const { store, auth } = fresh(() => t);
  try {
    const kim = auth.insertUser({ username: 'kim', password: 'first-password', role: 'picker', displayName: 'Kim' });
    t += 200 * DAY;
    assert.equal(auth.login('kim', 'first-password').user.mustChangePassword, false, 'no limit: an old password is fine');

    auth.setPasswordRules({ maxAgeDays: 90 });
    const late = auth.login('kim', 'first-password');
    assert.ok(late.token, 'it signs in');
    assert.equal(late.user.mustChangePassword, true);
    assert.equal(auth.audit(5).some((row) => row.action === 'password-expired'), true);
    assert.equal(auth.login('kim', 'wrong-password'), null, 'a wrong password is still wrong');

    auth.changePassword(kim.id, { current: 'first-password', next: 'second-password' });
    assert.equal(auth.login('kim', 'second-password').user.mustChangePassword, false, 'the age starts again at the change');
    t += 89 * DAY;
    assert.equal(auth.login('kim', 'second-password').user.mustChangePassword, false);
    t += 2 * DAY;
    assert.equal(auth.login('kim', 'second-password').user.mustChangePassword, true);

    // A reset gives a temporary password that must be changed anyway, and its age starts at the reset.
    const { temporaryPassword } = auth.resetPassword(kim.id, 'admin');
    assert.equal(auth.login('kim', temporaryPassword).user.mustChangePassword, true);
  } finally { store.close(); }
});

test('over HTTP: an administrator sets the rules, a picker cannot, and a short password is refused with the number', async () => {
  const { store, auth } = fresh();
  auth.ensureAdmin({ password: 'sorted-admin' });
  auth.ensureDemoUsers();
  const server = createServer({ store, printers: new Printers({}), auth });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body, cookie) => {
    const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json(), headers: res.headers };
  };
  const login = async (username) => ((await call('POST', '/api/login', { username, password: `sorted-${username}` })).headers.getSetCookie()[0] || '').split(';')[0];
  try {
    assert.equal((await call('GET', '/api/password-rules')).status, 401);
    const picker = await login('picker');
    assert.equal((await call('GET', '/api/password-rules', null, picker)).status, 403);

    const admin = await login('admin');
    const read = await call('GET', '/api/password-rules', null, admin);
    assert.deepEqual(read.body.rules, { minLength: 8, history: 0, maxAgeDays: 0 });
    assert.deepEqual(read.body.limits.history, { min: 0, max: 24, name: 'Earlier passwords refused' });
    const saved = await call('POST', '/api/password-rules', { minLength: 14, history: 3, maxAgeDays: 0 }, admin);
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body.rules, { minLength: 14, history: 3, maxAgeDays: 0 });
    const refused = await call('POST', '/api/password-rules', { minLength: 3 }, admin);
    assert.equal(refused.status, 400);
    assert.match(refused.body.error, /from 8 to 64/);

    const short = await call('POST', '/api/users', { username: 'kim', password: 'thirteen-char', role: 'picker', displayName: 'Kim', bootstrap: true }, admin);
    assert.equal(short.status, 400);
    assert.match(short.body.error, /at least 14 characters/);
    assert.equal((await call('POST', '/api/users', { username: 'kim', password: 'fourteen-chars', role: 'picker', displayName: 'Kim' }, admin)).status, 200);
  } finally {
    await new Promise((r) => server.close(r));
    store.close();
  }
});

test('the rules and the remembered passwords travel with a JSON backup', () => {
  const a = fresh();
  const b = fresh();
  try {
    a.auth.setPasswordRules({ minLength: 10, history: 4, maxAgeDays: 30 });
    const kim = a.auth.insertUser({ username: 'kim', password: 'first-password', role: 'picker', displayName: 'Kim' });
    a.auth.changePassword(kim.id, { current: 'first-password', next: 'second-password' });
    importJson(b.store.db, JSON.parse(JSON.stringify(exportJson(a.store.db, Date.now()))), Date.now());
    const restored = createAuth(b.store.db);
    assert.deepEqual(restored.passwordRules(), { minLength: 10, history: 4, maxAgeDays: 30 });
    const again = restored.listUsers().find((u) => u.username === 'kim');
    assert.throws(() => restored.changePassword(again.id, { current: 'second-password', next: 'first-password' }), /not used for your last 4/);
  } finally { a.store.close(); b.store.close(); }
});
