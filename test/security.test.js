const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Store } = require('../server/store');
const { Printers } = require('../server/print');
const { createServer } = require('../server/index');
const { createAuth, totpCode } = require('../server/auth');

const site = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'server', 'site.example.json'), 'utf8'));

function cookieOf(headers) {
  const raw = (headers.getSetCookie && headers.getSetCookie()[0]) || headers.get('set-cookie') || '';
  return raw.split(';')[0];
}

async function boot() {
  const store = new Store({ site });
  const auth = createAuth(store.db);
  auth.ensureDemoUsers();
  const server = createServer({ store, printers: new Printers({}), auth });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body, headers = {}) => {
    const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let parsed; try { parsed = JSON.parse(text); } catch (e) { parsed = text; }
    return { status: res.status, body: parsed, headers: res.headers };
  };
  return { store, auth, call, close: () => new Promise((r) => server.close(r)) };
}

test('an administrator reset forces a new password, and five failures lock the account', async () => {
  const app = await boot();
  try {
    const admin = cookieOf((await app.call('POST', '/api/login', { username: 'admin', password: 'sorted-admin' })).headers);
    const users = await app.call('GET', '/api/users', null, { cookie: admin });
    const operator = users.body.users.find((u) => u.username === 'operator');
    const reset = await app.call('POST', `/api/users/${operator.id}/reset-password`, {}, { cookie: admin });
    assert.equal(reset.status, 200);
    assert.ok(reset.body.temporaryPassword.length >= 8);
    const signed = await app.call('POST', '/api/login', { username: 'operator', password: reset.body.temporaryPassword });
    assert.equal(signed.body.user.mustChangePassword, true);
    const cookie = cookieOf(signed.headers);
    assert.equal((await app.call('GET', '/api/orders', null, { cookie })).status, 403);
    const changed = await app.call('POST', '/api/password', { current: reset.body.temporaryPassword, next: 'sorted-new-1' }, { cookie });
    assert.equal(changed.status, 200);
    assert.equal(changed.body.user.mustChangePassword, false);
    assert.equal((await app.call('GET', '/api/orders', null, { cookie })).status, 200);
    for (let i = 0; i < 5; i++) assert.equal((await app.call('POST', '/api/login', { username: 'office', password: 'wrong-password' })).status, 401);
    const locked = await app.call('POST', '/api/login', { username: 'office', password: 'sorted-office' });
    assert.equal(locked.status, 429);
  } finally { await app.close(); }
});

test('optional TOTP blocks the session until the code matches, and idle timeout drops it', async () => {
  const app = await boot();
  try {
    const first = await app.call('POST', '/api/login', { username: 'manager', password: 'sorted-manager' });
    const cookie = cookieOf(first.headers);
    const setup = await app.call('POST', '/api/totp/setup', {}, { cookie });
    assert.match(setup.body.otpauth, /otpauth:\/\/totp/);
    const code = totpCode(setup.body.secret);
    assert.equal((await app.call('POST', '/api/totp/enable', { code }, { cookie })).status, 200);
    await app.call('POST', '/api/logout', {}, { cookie });
    const challenge = await app.call('POST', '/api/login', { username: 'manager', password: 'sorted-manager' });
    assert.equal(challenge.body.mfaRequired, true);
    assert.equal(challenge.headers.get('set-cookie'), null);
    assert.equal((await app.call('POST', '/api/login/totp', { mfaToken: challenge.body.mfaToken, code: '000000' })).status, 401);
    const done = await app.call('POST', '/api/login/totp', { mfaToken: challenge.body.mfaToken, code: totpCode(setup.body.secret) });
    assert.equal(done.status, 200);
    assert.equal(done.body.user.totpEnabled, true);
    const session = cookieOf(done.headers);
    app.store.db.prepare('UPDATE sessions SET last_seen = ?').run(Date.now() - 31 * 60 * 1000);
    assert.equal((await app.call('GET', '/api/session', null, { cookie: session })).status, 401);
  } finally { await app.close(); }
});

test('each warehouse keeps its own plate counter, and site access follows the user', async () => {
  const app = await boot();
  try {
    const admin = cookieOf((await app.call('POST', '/api/login', { username: 'admin', password: 'sorted-admin' })).headers);
    const created = await app.call('POST', '/api/sites', { id: 'north', name: 'North room', preset: 'home-garage' }, { cookie: admin });
    assert.equal(created.status, 200, created.body && created.body.error);
    assert.equal(created.body.id, 'NORTH');
    const user = await app.call('POST', '/api/users', { username: 'siteop', password: 'sorted-site', role: 'operator', displayName: 'Site Op' }, { cookie: admin });
    assert.equal((await app.call('POST', `/api/users/${user.body.user.id}`, { sites: ['NORTH'] }, { cookie: admin })).status, 200);
    const op = cookieOf((await app.call('POST', '/api/login', { username: 'siteop', password: 'sorted-site' })).headers);
    assert.equal((await app.call('GET', '/api/summary', null, { cookie: op })).status, 403);
    const switched = await app.call('POST', '/api/sites/switch', { id: 'NORTH' }, { cookie: op });
    assert.equal(switched.status, 200);
    assert.match(switched.headers.get('set-cookie'), /sorted_site=NORTH/);
    assert.equal((await app.call('GET', '/api/summary', null, { cookie: `${op}; sorted_site=NORTH` })).status, 200);

    app.store.siteId = 'MAIN';
    app.store.wh.addItem({ itemNo: 'MOVE1', name: 'Transfer box', category: 'YOG', palletQty: 4 });
    app.store.wh.stockPallet('DOCK-IN', { itemNo: 'MOVE1', batch: 'T', expiry: '2027-06-01', qty: 4 });
    const before = app.store.wh.holderSeries.ST.next;
    const pallet = Object.values(app.store.wh.pallets).find((p) => p.itemNo === 'MOVE1');
    app.store.siteId = 'NORTH';
    app.store.exec('addItem', { itemNo: 'MOVE1', name: 'Transfer box', category: 'HOME', palletQty: 4 });
    const sent = app.store.startTransfer({ from: 'MAIN', to: 'NORTH', itemNo: 'MOVE1', qty: 4, id: 'TR1', by: 'admin' });
    assert.equal(sent.status, 'in-transit');
    assert.equal(app.store.wh.pallets[pallet.sscc].loc, 'IN-TRANSIT');
    assert.equal(app.store.wh.holderSeries.ST.next, before);
    const refused = app.store.cancelTransfer({ id: 'TR1', from: 'MAIN', by: 'admin' });
    assert.equal(refused.status, 'cancelled');
    assert.equal(app.store.wh.pallets[pallet.sscc].loc, 'DOCK-IN');
    assert.equal(app.store.wh.pallets[pallet.sscc].status, 'available');
    assert.equal(app.store.wh.holderSeries.ST.next, before);
    app.store.startTransfer({ from: 'MAIN', to: 'NORTH', itemNo: 'MOVE1', qty: 4, id: 'TR2', by: 'admin' });
    const moved = app.store.receiveTransfer({ id: 'TR2', from: 'MAIN', to: 'NORTH', by: 'admin' });
    assert.equal(moved.holder, 'ST0000001');
    assert.equal(app.store.warehouse('NORTH').holderSeries.ST.next, 2);
    assert.equal(app.store.wh.holderSeries.ST.next, before);
    assert.equal(app.store.wh.pallets[pallet.sscc].status, 'shipped');
  } finally { await app.close(); }
});
