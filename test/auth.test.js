const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Store } = require('../server/store');
const { Printers } = require('../server/print');
const { createServer } = require('../server/index');
const { createAuth, verifyPassword } = require('../server/auth');
const { permissionFor } = require('../server/permissions');
const { seedDemo } = require('../server/seed');

const site = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'server', 'site.example.json'), 'utf8'));

function cookieOf(headers) {
  const raw = (headers.getSetCookie && headers.getSetCookie()[0]) || headers.get('set-cookie') || '';
  return raw.split(';')[0];
}

async function boot() {
  const store = new Store({ site });
  const auth = createAuth(store.db);
  auth.ensureDemoUsers();
  const server = createServer({ store, printers: new Printers({}), auth, token: 'secret' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body, headers = {}) => {
    const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch (e) { parsed = text; }
    return { status: res.status, body: parsed, headers: res.headers };
  };
  const sign = async (username, password) => {
    const res = await call('POST', '/api/login', { username, password });
    assert.equal(res.status, 200, res.body.error);
    return cookieOf(res.headers);
  };
  return { store, auth, server, call, sign, close: () => new Promise((r) => server.close(r)) };
}

test('route permissions stay specific where a role must not inherit wms.write', () => {
  assert.equal(permissionFor('GET', '/api/health').public, true);
  assert.equal(permissionFor('POST', '/api/users').permission, 'users.write');
  assert.equal(permissionFor('POST', '/api/config').permission, 'settings.write');
  assert.equal(permissionFor('POST', '/api/devices/HH01/scan').permission, 'scans.execute');
  assert.equal(permissionFor('POST', '/api/labels/master').permission, 'labels.print');
  assert.equal(permissionFor('GET', '/api/reports/stock.csv').permission, 'reports.read');
  assert.equal(permissionFor('POST', '/api/import/stock').permission, 'wms.write');
});

test('login, sessions, roles and the shared token', async () => {
  const app = await boot();
  try {
    const hash = app.store.db.prepare('SELECT password_hash FROM users WHERE username = ?').get('admin').password_hash;
    assert.match(hash, /^scrypt\$/);
    assert.equal(hash.includes('sorted-admin'), false);
    assert.equal(verifyPassword('sorted-admin', hash), true);
    assert.equal(verifyPassword('nope', hash), false);

    assert.equal((await app.call('GET', '/api/summary')).status, 401);
    assert.equal((await app.call('POST', '/api/login', { username: 'operator', password: 'wrong-password' })).status, 401);
    const operator = await app.sign('operator', 'sorted-operator');
    const me = await app.call('GET', '/api/session', null, { cookie: operator });
    assert.equal(me.body.user.role, 'operator');
    assert.equal(me.body.user.roleLabel, 'Operator');
    assert.equal((await app.call('GET', '/api/users', null, { cookie: operator })).status, 403);
    assert.match((await app.call('POST', '/api/users', { username: 'extra', password: 'sorted-extra', role: 'office', displayName: 'Extra' }, { cookie: operator, 'x-operator': 'admin' })).body.error, /Missing permission: users.write/);

    const admin = await app.sign('admin', 'sorted-admin');
    const created = await app.call('POST', '/api/users', { username: 'extra', password: 'sorted-extra', role: 'operator', displayName: 'Extra One' }, { cookie: admin });
    assert.equal(created.status, 200);
    const moved = await app.call('POST', `/api/users/${created.body.user.id}`, { role: 'office' }, { cookie: admin });
    assert.equal(moved.body.user.role, 'office');
    const roles = await app.call('GET', '/api/roles', null, { cookie: admin });
    assert.ok(roles.body.roles.find((r) => r.id === 'machine').permissions.includes('scans.execute'));
    const officePerms = roles.body.roles.find((r) => r.id === 'office').permissions.filter((p) => p !== 'clients.write');
    assert.equal((await app.call('POST', '/api/roles/office', { permissions: officePerms }, { cookie: admin })).status, 200);
    const office = await app.sign('office', 'sorted-office');
    assert.equal((await app.call('POST', '/api/clients', { id: 'CL-NEW', name: 'New client' }, { cookie: office })).status, 403);
    assert.equal((await app.call('POST', '/api/roles/administrator', { permissions: ['wms.read'] }, { cookie: admin })).status, 400);

    assert.equal((await app.call('GET', '/api/summary', null, { 'x-token': 'secret', 'x-operator': 'boss' })).status, 200);
    assert.equal((await app.call('POST', '/api/logout', {}, { cookie: admin })).status, 200);
    assert.equal((await app.call('GET', '/api/session', null, { cookie: admin })).status, 401);

    const admins = app.auth.listUsers().filter((u) => u.role === 'administrator' && u.active);
    assert.throws(() => app.auth.updateUser(admins[0].id, { role: 'office' }), /last administrator/);
  } finally {
    await app.close();
    app.store.close();
  }
});

test('each demo role can sign in and is refused a screen it does not own', async () => {
  const app = await boot();
  try {
    const expect = [
      ['admin', 'sorted-admin', 'administrator', '/api/users', 200],
      ['manager', 'sorted-manager', 'manager', '/api/users', 200],
      ['office', 'sorted-office', 'office', '/api/clients', 200],
      ['tech', 'sorted-tech', 'technician', '/api/equipment', 200],
      ['operator', 'sorted-operator', 'operator', '/api/tasks', 200],
      ['machine', 'sorted-machine', 'machine', '/api/stations', 200],
    ];
    for (const [username, password, role, path, status] of expect) {
      const cookie = await app.sign(username, password);
      const session = await app.call('GET', '/api/session', null, { cookie });
      assert.equal(session.body.user.role, role);
      assert.equal((await app.call('GET', path, null, { cookie })).status, status);
    }
    const operator = await app.sign('operator', 'sorted-operator');
    assert.equal((await app.call('POST', '/api/config', { aisleCap: 2 }, { cookie: operator })).status, 403);
    const machine = await app.sign('machine', 'sorted-machine');
    assert.equal((await app.call('POST', '/api/orders', { id: 'NO', customer: 'X', lane: 'OUT-01', lines: [] }, { cookie: machine })).status, 403);
    const office = await app.sign('office', 'sorted-office');
    const clients = await app.call('GET', '/api/clients', null, { cookie: office });
    assert.ok(clients.body.some((c) => c.id === 'CL-DAIRY' && c.pallets >= 0));
  } finally {
    await app.close();
    app.store.close();
  }
});

test('office can create a client, an item, a location and a label; capacity is enforced over HTTP', async () => {
  const app = await boot();
  try {
    seedDemo(app.store);
    const office = await app.sign('office', 'sorted-office');
    const manager = await app.sign('manager', 'sorted-manager');
    assert.equal((await app.call('POST', '/api/clients', { id: 'CL-NEW', name: 'New Owner', email: 'new@example.test' }, { cookie: office })).status, 200);
    const GS1 = require('../src/gs1');
    const item = await app.call('POST', '/api/items', {
      itemNo: 'N1', name: 'New yoghurt', category: 'YOG', palletQty: 10, clientId: 'CL-NEW', gtin: GS1.makeGtin13('20000', 9),
      uom: 'case', lengthMm: 1200, widthMm: 800, heightMm: 1400, weightKg: 400,
    }, { cookie: office });
    assert.equal(item.status, 200);
    assert.equal((await app.call('POST', '/api/clients/CL-NEW/archive', {}, { cookie: office })).status, 200);
    assert.match((await app.call('POST', '/api/items', { itemNo: 'N2', name: 'Nope', category: 'YOG', palletQty: 1, clientId: 'CL-NEW' }, { cookie: office })).body.error, /archived/);
    await app.call('POST', '/api/clients/CL-NEW/restore', {}, { cookie: office });

    const bin = await app.call('POST', '/api/locations', { code: 'BIN-TEST', kind: 'bin', category: 'YOG', heightMm: 500, widthMm: 700, depthMm: 900, maxWeightKg: 100 }, { cookie: manager });
    assert.equal(bin.status, 200);
    const sscc = app.store.wh.nextSscc();
    const tooBig = await app.call('POST', '/api/import/stock', { rows: [{ code: 'BIN-TEST', sscc, itemNo: 'N1', batch: 'B', expiry: '2027-01-01', qty: 10 }] }, { cookie: manager });
    assert.ok(tooBig.body.errors.length >= 1);
    assert.match(tooBig.body.errors[0], /does not fit/);
    const holder = await app.call('POST', '/api/holders', { id: 'H-NEW', type: 'tote', loc: 'DOCK-IN', clientId: 'CL-NEW' }, { cookie: manager });
    assert.equal(holder.status, 200);
    const label = await app.call('POST', '/api/labels/pallet', { itemNo: 'N1', batch: 'B1', expiry: '2027-04-01', qty: 10 }, { cookie: office });
    assert.equal(label.status, 200);
    assert.match(label.body.zpl, /\^XA/);
    const html = await app.call('GET', `/api/labels/${label.body.id}/html`, null, { cookie: office });
    assert.match(html.body, /PALLET LABEL/);
    assert.match(html.body, /\(00\)/);
    const master = await app.call('POST', '/api/labels/master', { children: [app.store.wh.pallets[Object.keys(app.store.wh.pallets)[0]].sscc], title: 'Shift master' }, { cookie: office });
    assert.match(master.body.zpl, /MASTER/);

    const scan = await app.call('POST', '/api/hardware/scan', { code: 'BIN-TEST', source: 'simulated' }, { cookie: await app.sign('operator', 'sorted-operator') });
    assert.equal(scan.body.scan.source, 'simulated');
    const tech = await app.sign('tech', 'sorted-tech');
    assert.equal((await app.call('POST', '/api/hardware/mode', { printer: 'browser' }, { cookie: tech })).body.printer, 'browser');
    const printed = await app.call('POST', '/api/hardware/print', { printer: 'SIM', zpl: label.body.zpl, html: '<p>label</p>', kind: 'pallet' }, { cookie: tech });
    assert.equal(printed.body.mode, 'browser');
    assert.equal((await app.call('POST', '/api/locations/BIN-TEST/delete', {}, { cookie: manager })).status, 200);
  } finally {
    await app.close();
    app.store.close();
  }
});
