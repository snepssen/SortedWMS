const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHmac } = require('node:crypto');
const { Store } = require('../server/store');
const { Printers } = require('../server/print');
const { createServer } = require('../server/index');
const { createAuth } = require('../server/auth');
const { createApi } = require('../server/api');
const { permissionFor, RULES } = require('../server/permissions');
const { requestIsSecure, addressMatches } = require('../server/trust-proxy');
const { signTimestamped, verifyTimestamped, timestampSeconds } = require('../server/signature');
const { verifyWebhook } = require('../server/etsy');

const site = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'site.json'), 'utf8'));

function cookieHeader(headers) {
  const list = headers.getSetCookie ? headers.getSetCookie() : [headers.get('set-cookie') || ''];
  return list.join('\n');
}

async function boot() {
  const store = new Store({ site });
  const auth = createAuth(store.db);
  auth.ensureAdmin({ username: 'admin', password: 'sorted-admin', displayName: 'Administrator' });
  const server = createServer({ store, printers: new Printers({}), auth });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body, headers = {}) => {
    const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch (e) { parsed = text; }
    return { status: res.status, body: parsed, headers: res.headers };
  };
  return { store, call, close: () => new Promise((r) => server.close(r)) };
}

test('a trusted proxy may mark the session and device cookies Secure, and a client may not', async () => {
  assert.equal(addressMatches('10.1.2.3', '10.0.0.0/8'), true);
  assert.equal(addressMatches('11.0.0.1', '10.0.0.0/8'), false);
  assert.equal(addressMatches('192.168.1.9', '192.168.1.9'), true);
  const direct = { socket: { encrypted: true, remoteAddress: '203.0.113.4' }, headers: {} };
  assert.equal(requestIsSecure(direct, {}), true);
  const spoofed = { socket: { encrypted: false, remoteAddress: '203.0.113.4' }, headers: { 'x-forwarded-proto': 'https' } };
  assert.equal(requestIsSecure(spoofed, { SORTED_TRUST_PROXY: '127.0.0.1' }), false);
  const trusted = { socket: { encrypted: false, remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-proto': 'https' } };
  assert.equal(requestIsSecure(trusted, {}), false);
  assert.equal(requestIsSecure(trusted, { SORTED_TRUST_PROXY: '10.0.0.0/8,127.0.0.1' }), true);
  assert.equal(requestIsSecure({ socket: { encrypted: false, remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-proto': 'http' } }, { SORTED_TRUST_PROXY: '127.0.0.1' }), false);

  const previous = process.env.SORTED_TRUST_PROXY;
  const { store, call, close } = await boot();
  try {
    delete process.env.SORTED_TRUST_PROXY;
    const plain = await call('POST', '/api/login', { username: 'admin', password: 'sorted-admin' });
    assert.equal(plain.status, 200);
    assert.equal(/;\s*Secure/i.test(cookieHeader(plain.headers)), false);

    const lied = await call('POST', '/api/login', { username: 'admin', password: 'sorted-admin' }, { 'x-forwarded-proto': 'https' });
    assert.equal(/;\s*Secure/i.test(cookieHeader(lied.headers)), false);

    process.env.SORTED_TRUST_PROXY = '127.0.0.1';
    const via = await call('POST', '/api/login', { username: 'admin', password: 'sorted-admin' }, { 'x-forwarded-proto': 'https' });
    assert.match(cookieHeader(via.headers), /sorted_session=[^;]+; HttpOnly; SameSite=Lax; Path=\/; Max-Age=\d+; Secure/);

    const cookie = cookieHeader(via.headers).split(';')[0];
    const card = await call('POST', '/api/pairing', {}, { cookie, 'x-forwarded-proto': 'https' });
    assert.equal(card.status, 200, card.body && card.body.error);
    const token = String(card.body.url || '').split('/pair/')[1];
    const claimed = await call('POST', '/api/pairing/claim', { token, code: card.body.code }, { 'x-forwarded-proto': 'https' });
    assert.equal(claimed.status, 200, claimed.body && claimed.body.error);
    const paired = cookieHeader(claimed.headers);
    assert.match(paired, /sorted_session=[^;\n]+; HttpOnly; SameSite=Lax; Path=\/; Max-Age=\d+; Secure/);
    assert.match(paired, /sorted_device=[^;\n]+; Path=\/; SameSite=Lax; Max-Age=\d+; Secure/);

    const out = await call('POST', '/api/logout', {}, { cookie, 'x-forwarded-proto': 'https' });
    assert.match(cookieHeader(out.headers), /sorted_session=; HttpOnly; SameSite=Lax; Path=\/; Max-Age=0; Secure/);
  } finally {
    if (previous === undefined) delete process.env.SORTED_TRUST_PROXY;
    else process.env.SORTED_TRUST_PROXY = previous;
    await close();
    store.close();
  }
});

test('a route with no permission row is refused, and every registered route has one', () => {
  const blank = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'server', 'site.blank.json'), 'utf8'));
  const store = new Store({ site: blank });
  let listed;
  try { listed = createApi({ store, printers: new Printers({}) }).routes(); } finally { store.close(); }
  const index = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
  const fromIndex = [...index.matchAll(/req\.method === '(GET|POST)' && url\.pathname === '(\/api\/[^']+)'/g)].map((m) => ({ method: m[1], pattern: m[2] }));
  const seen = new Map();
  for (const r of [...listed, ...fromIndex]) seen.set(`${r.method} ${r.pattern}`, r);
  for (const r of seen.values()) {
    const sample = r.pattern.replace(/:(\w+)/g, 'x');
    const access = permissionFor(r.method, sample);
    assert.equal(access.mapped, true, `${r.method} ${r.pattern} has no permission row`);
    assert.ok(access.public || access.permission, `${r.method} ${r.pattern}`);
  }
  assert.equal(RULES.some(([, pattern]) => pattern === '/api/not-a-route'), false);
  assert.deepEqual(permissionFor('GET', '/api/not-a-route'), { public: false, permission: null, mapped: false, status: 404 });
  assert.equal(permissionFor('POST', '/api/not-a-route').status, 403);
  assert.equal(permissionFor('POST', '/api/import/stock').permission, 'wms.write');
  assert.equal(permissionFor('GET', '/api/health').public, true);
});

test('an unmapped address is refused on the server', async () => {
  const { store, call, close } = await boot();
  try {
    const read = await call('GET', '/api/not-a-route');
    assert.equal(read.status, 404);
    const change = await call('POST', '/api/not-a-route', {});
    assert.equal(change.status, 403);
    const signed = await call('POST', '/api/login', { username: 'admin', password: 'sorted-admin' });
    const cookie = cookieHeader(signed.headers).split(';')[0];
    const asAdmin = await call('POST', '/api/not-a-route', {}, { cookie });
    assert.equal(asAdmin.status, 403);
  } finally { await close(); store.close(); }
});

test('a webhook signature covers the timestamp, and a stale one is refused', () => {
  const secret = 'whs_test';
  const body = '{"webhook":1}';
  const now = Date.UTC(2026, 10, 20, 12, 0, 0);
  const ts = timestampSeconds(now);
  const header = signTimestamped(secret, ts, body);
  assert.equal(verifyTimestamped(secret, ts, body, header, now), true);
  assert.equal(verifyTimestamped(secret, ts, body, header, now + 6 * 60 * 1000), false);
  assert.equal(verifyTimestamped(secret, ts, body + ' ', header, now), false);
  assert.equal(verifyTimestamped(secret, 'not-a-time', body, header, now), false);

  const raw = '{"receipt_id":1}';
  const legacy = createHmac('sha256', secret).update(raw).digest('hex');
  assert.equal(verifyWebhook(raw, legacy, secret), true);
  const stamped = createHmac('sha256', secret).update(`${ts}.${raw}`).digest('hex');
  assert.equal(verifyWebhook(raw, stamped, secret, ts, now), true);
  assert.equal(verifyWebhook(raw, stamped, secret, ts, now - 6 * 60 * 1000), false);
  assert.equal(verifyWebhook(raw, legacy, secret, ts, now), false);
});
