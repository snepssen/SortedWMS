const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Warehouse } = require('../src/engine');
const { Store } = require('../server/store');
const { createAuth } = require('../server/auth');
const { createServer } = require('../server/index');
const { Printers } = require('../server/print');
const { permissionFor, DEFAULTS } = require('../server/permissions');

const site = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'site.json'), 'utf8'));

function cookieOf(headers) {
  const raw = (headers.getSetCookie && headers.getSetCookie()[0]) || headers.get('set-cookie') || '';
  return raw.split(';')[0];
}

test('a client only sees and edits their own items, and approval is off unless the warehouse asks for it', async () => {
  assert.equal(permissionFor('POST', '/api/items/SKU/approve').permission, 'items.approve');
  assert.equal(DEFAULTS.client.includes('items.write'), true);
  assert.equal(DEFAULTS.client.includes('items.approve'), false);
  assert.equal(DEFAULTS.office.includes('items.approve'), true);
  assert.equal(DEFAULTS.picker.includes('items.approve'), false);

  const store = new Store({ site });
  const auth = createAuth(store.db);
  auth.ensureDemoUsers();
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
  const sign = async (username, password) => cookieOf((await call('POST', '/api/login', { username, password })).headers);
  try {
    const admin = await sign('admin', 'sorted-admin');
    const made = await call('POST', '/api/users', { username: 'paints', password: 'sorted-paints', role: 'client', displayName: 'Paint desk', clientId: 'CL-PAINT' }, { cookie: admin });
    assert.equal(made.status, 200, made.body && made.body.error);
    assert.equal(made.body.user.clientId, 'CL-PAINT');
    assert.equal((await call('POST', '/api/users', { username: 'loose', password: 'sorted-loose', role: 'client', displayName: 'Loose' }, { cookie: admin })).status, 400);

    const paints = await sign('paints', 'sorted-paints');
    const items = await call('GET', '/api/items', null, { cookie: paints });
    assert.equal(items.status, 200);
    assert.ok(items.body.length > 0);
    assert.ok(items.body.every((i) => i.clientId === 'CL-PAINT'));
    const other = await call('GET', '/api/clients/CL-GARDEN', null, { cookie: paints });
    assert.equal(other.status, 403);

    const added = await call('POST', '/api/items', {
      itemNo: 'DY-1', name: 'Filler tub', category: 'GEN', uom: 'pot', codes: 'DY-BAR-1',
      lengthMm: 80, widthMm: 80, heightMm: 90, weightKg: 0.2, food: true, clientId: 'CL-GARDEN',
    }, { cookie: paints });
    assert.equal(added.status, 200, added.body && added.body.error);
    assert.equal(added.body.clientId, 'CL-PAINT');
    assert.equal(added.body.status, 'active');
    assert.equal(added.body.flags.food, true);
    assert.equal(added.body.codes.includes('DY-BAR-1'), true);
    assert.ok(store.journal({ op: 'addItem' }).some((r) => r.by === 'paints'));
    assert.match(store.wh.events[0].text, /added by paints/);

    const orders = await call('GET', '/api/orders', null, { cookie: paints });
    assert.ok(orders.body.every((o) => !o.clientId || o.clientId === 'CL-PAINT'));
    const stock = await call('GET', '/api/stock', null, { cookie: paints });
    assert.equal(stock.status, 200);
    assert.ok(stock.body.every((r) => r.item.clientId === 'CL-PAINT'));

    await call('POST', '/api/config', { itemApproval: true }, { cookie: admin });
    const waiting = await call('POST', '/api/items', { itemNo: 'DY-2', name: 'Waiting filler', category: 'GEN', uom: 'pot' }, { cookie: paints });
    assert.equal(waiting.body.status, 'pending');
    assert.equal((await call('POST', '/api/items/DY-2/approve', {}, { cookie: paints })).status, 403);
    const office = await sign('office', 'sorted-office');
    const approved = await call('POST', '/api/items/DY-2/approve', {}, { cookie: office });
    assert.equal(approved.status, 200, approved.body && approved.body.error);
    assert.equal(approved.body.status, 'active');
    assert.match(store.wh.events[0].text, /approved by office/);
    const off = await call('POST', '/api/items/DY-1/archive', {}, { cookie: paints });
    assert.equal(off.status, 200);
    assert.equal(store.wh.items['DY-1'].status, 'archived');
    assert.match(store.wh.events[0].text, /archived by paints/);
  } finally {
    await new Promise((r) => server.close(r));
    store.close();
  }
});
