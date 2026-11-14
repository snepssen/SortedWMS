const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Store } = require('../server/store');
const { createApi } = require('../server/api');
const { createAuth } = require('../server/auth');
const { permissionFor, DEFAULTS } = require('../server/permissions');

const site = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'server', 'site.blank.json'), 'utf8'));

function world() {
  const store = new Store({ site, now: () => Date.parse('2026-07-01T22:30:00Z') });
  store.exec('setModules', { 'user-audit': true }, 'admin');
  store.exec('setConfig', { patch: { timeZone: 'Europe/Brussels' } }, 'admin');
  store.exec('addItem', { itemNo: 'SKU', name: 'Mug', category: 'GEN', palletQty: 1 }, 'ada');
  store.exec('createLocation', { code: 'BIN-1', kind: 'bin', name: 'Bin' }, 'ada');
  store.exec('binPut', { loc: 'BIN-1', itemNo: 'SKU', qty: 2 }, 'ada');
  createAuth(store.db);
  store.db.prepare('INSERT INTO auth_audit (t, action, by, detail) VALUES (?, ?, ?, ?)').run(Date.parse('2026-07-01T22:30:00Z'), 'login', 'ada', null);
  store.db.prepare('INSERT INTO journal (t, op, args, by) VALUES (?, ?, ?, ?)').run(
    Date.parse('2026-07-01T22:30:00Z'), 'note', JSON.stringify({ password: 'secret-value', note: 'hello' }), 'ada',
  );
  return store;
}

function csv(store, query, actor) {
  const app = createApi({ store, printers: { flush() {} } });
  return app.handle('GET', '/api/user-audit.csv' + query, {}, (actor && actor.role) || 'manager', null, actor || null);
}

test('the export uses the warehouse local day and leaves secrets out', () => {
  const store = world();
  const day = csv(store, '?from=2026-07-02&to=2026-07-02', { role: 'manager', permissions: ['user-audit.read'] });
  assert.equal(day.status, 200);
  assert.match(day.contentType, /text\/csv/);
  assert.match(day.body, /"when","user","kind","what","detail"/);
  assert.match(day.body, /2026-07-02 00:30:00","ada","action","binPut"/);
  assert.match(day.body, /2026-07-02 00:30:00","ada","move","received"/);
  assert.match(day.body, /2026-07-02 00:30:00","ada","sign-in","login"/);
  assert.match(day.body, /note=hello/);
  assert.equal(day.body.includes('secret-value'), false);
  const previous = csv(store, '?from=2026-07-01&to=2026-07-01', { role: 'administrator' });
  assert.equal(previous.body.includes('binPut'), false);
  assert.equal(previous.body.includes('login'), false);
  const bad = csv(store, '?from=July&to=2026-07-02', { role: 'manager' });
  assert.equal(bad.status, 400);
  store.exec('setModules', { 'user-audit': false }, 'admin');
  assert.equal(csv(store, '?from=2026-07-02&to=2026-07-02', { role: 'administrator' }).status, 404);
  const kept = store.db.prepare("SELECT COUNT(*) AS n FROM journal WHERE op = 'binPut'").get().n;
  assert.equal(kept, 1);
  store.close();
});

test('a client cannot export it, and only a manager or an administrator can', () => {
  const store = world();
  const client = csv(store, '?from=2026-07-02&to=2026-07-02', { role: 'client', clientId: 'CL-A', permissions: ['user-audit.read'] });
  assert.equal(client.status, 403);
  const office = csv(store, '?from=2026-07-02&to=2026-07-02', { role: 'office', permissions: ['user-audit.read'] });
  assert.equal(office.status, 403);
  const manager = csv(store, '?from=2026-07-02&to=2026-07-02', { role: 'manager' });
  assert.equal(manager.status, 200);
  assert.equal(permissionFor('GET', '/api/user-audit.csv').permission, 'user-audit.read');
  assert.equal(DEFAULTS.client.includes('user-audit.read'), false);
  assert.equal(DEFAULTS.office.includes('user-audit.read'), false);
  assert.equal(DEFAULTS.manager.includes('user-audit.read'), true);
  assert.equal(DEFAULTS.administrator.includes('user-audit.read'), true);
  const html = fs.readFileSync(path.join(__dirname, '..', 'server', 'public', 'app.html'), 'utf8');
  assert.equal(html.includes("['audit', 'Audit'], ['user-audit', 'User audit']"), true);
  assert.equal(html.includes("['modules', 'Modules'], ['user-audit', 'User audit']"), true);
  const clientNav = html.slice(html.indexOf("client: [['items'"), html.indexOf('const TITLES'));
  assert.equal(clientNav.includes('user-audit'), false);
  store.close();
});
