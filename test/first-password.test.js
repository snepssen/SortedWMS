const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Store } = require('../server/store');
const { Printers } = require('../server/print');
const { createServer } = require('../server/index');
const { createAuth } = require('../server/auth');

function blank() {
  const site = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'server', 'site.blank.json'), 'utf8'));
  return new Store({ site });
}

test('a new warehouse\'s admin must choose its own password before doing anything else', async () => {
  const store = blank();
  const auth = createAuth(store.db);
  assert.deepEqual(auth.ensureAdmin({ password: 'sorted-admin', mustChange: true }), { created: true, username: 'admin', mustChange: true });
  const server = createServer({ store, printers: new Printers({}), auth });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body, cookie) => {
    const res = await fetch(base + p, { method, redirect: 'manual', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* a page */ }
    return { status: res.status, body: json, headers: res.headers };
  };
  try {
    assert.deepEqual((await call('GET', '/api/login/info')).body, { demoUsers: false }, 'no demo sign-ins on a real warehouse');
    const signed = await call('POST', '/api/login', { username: 'admin', password: 'sorted-admin' });
    assert.equal(signed.body.user.mustChangePassword, true);
    const cookie = signed.headers.get('set-cookie').split(';')[0];
    const blocked = await call('GET', '/api/items', null, cookie);
    assert.deepEqual([blocked.status, blocked.body.mustChangePassword], [403, true]);
    const page = await call('GET', '/setup?step=2', null, cookie);
    assert.deepEqual([page.status, page.headers.get('location')], [302, '/app?next=%2Fsetup%3Fstep%3D2'], 'pages send them to the password screen first');
    assert.equal((await call('GET', '/app', null, cookie)).status, 200);
    const weak = await call('POST', '/api/password', { current: 'sorted-admin', next: 'sorted-office' }, cookie);
    assert.equal(weak.status, 400);
    assert.match(weak.body.error, /printed on the sign-in page/);
    const ok = await call('POST', '/api/password', { current: 'sorted-admin', next: 'Rack-and-roll-42' }, cookie);
    assert.equal(ok.status, 200, ok.body && ok.body.error);
    assert.equal((await call('GET', '/api/items', null, cookie)).status, 200);
    assert.equal((await call('GET', '/setup', null, cookie)).status, 200);
    auth.ensureDemoUsers();
    assert.deepEqual((await call('GET', '/api/login/info')).body, { demoUsers: true });
  } finally {
    await new Promise((r) => server.close(r));
    store.close();
  }
});

test('an admin still on the starting password is asked to change it at the next start; one that changed it is not', () => {
  const store = blank();
  try {
    const auth = createAuth(store.db);
    auth.ensureAdmin({ password: 'sorted-admin' });
    assert.equal(auth.login('admin', 'sorted-admin').user.mustChangePassword, false, 'the demo keeps the printed password');
    assert.equal(auth.ensureAdmin({ password: 'sorted-admin', mustChange: true }).mustChange, true);
    const user = auth.login('admin', 'sorted-admin').user;
    assert.equal(user.mustChangePassword, true);
    auth.changePassword(user.id, { current: 'sorted-admin', next: 'Pallets-all-the-way' });
    assert.equal(auth.ensureAdmin({ password: 'sorted-admin', mustChange: true }).mustChange, false);
    assert.equal(auth.login('admin', 'Pallets-all-the-way').user.mustChangePassword, false);
    assert.equal(auth.ensureAdmin({ password: 'chosen-at-install', mustChange: false }).created, false);
  } finally {
    store.close();
  }
});
