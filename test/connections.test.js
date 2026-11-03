const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Site = require('../server/site');
const { COMMANDS } = require('../server/commands');
const Demo = require('../src/demo');
const { Store } = require('../server/store');
const { Printers } = require('../server/print');
const { createServer } = require('../server/index');
const { createAuth } = require('../server/auth');

// A few hours of the demo warehouse: deliveries received, orders shipped as pallets and cartons, returns, counts.
function shift(hours) {
  let t = Demo.morning(Date.UTC(2026, 10, 2, 9));
  const wh = Site.buildWarehouse(Demo.SITE, () => t);
  const rows = [];
  const exec = (op, args, by) => { rows.push({ t, op, args: JSON.parse(JSON.stringify(args)), by }); return COMMANDS[op](wh, args, by); };
  Demo.seed((op, args) => exec(op, args, 'demo'), t, () => wh);
  let a = 5;
  const runner = new Demo.Runner({ rand: () => { a = (a * 16807) % 2147483647; return a / 2147483647; } });
  for (let s = 0; s < hours * 720; s++) {
    t += 5000;
    if (s % 12 === 0) exec('tick', {}, 'system');
    runner.step(wh, t, exec);
  }
  return { wh, rows };
}

test('messages out: receipts, shipments with pallets, cartons, batches and serials, returns and adjustments, numbered in order', () => {
  const { wh, rows } = shift(5);
  const { messages, last } = wh.messageLog({ limit: 1000 });
  assert.equal(messages.length, last);
  assert.deepEqual(messages.map((m) => m.seq), messages.map((_, i) => i + 1), 'numbered 1, 2, 3 …');
  const types = new Set(messages.map((m) => m.type));
  for (const t of ['delivery.received', 'order.shipped', 'return.received', 'return.graded', 'stock.adjusted']) assert.ok(types.has(t), t);

  const got = messages.find((m) => m.type === 'delivery.received' && m.data.pallets.length);
  assert.ok(got.data.pallets.every((p) => /^\d{18}$/.test(p.sscc) && p.itemNo && p.qty > 0));
  const shipped = messages.filter((m) => m.type === 'order.shipped');
  assert.ok(shipped.length >= 20);
  for (const m of shipped) {
    const order = wh.orders[m.data.orderId];
    assert.equal(order.status, 'shipped');
    assert.equal(m.clientId, order.clientId);
    for (const l of m.data.lines) assert.ok(l.shipped > 0, `${m.data.orderId} ${l.itemNo} shipped`);
  }
  const byPallet = shipped.find((m) => m.data.pallets.length);
  assert.ok(byPallet.data.pallets.every((p) => p.batch));
  const byCarton = shipped.find((m) => m.data.cartons.length);
  assert.ok(byCarton.data.cartons[0].lines.length && byCarton.data.cartons[0].weightKg > 0);
  const drills = shipped.find((m) => m.data.lines.some((l) => l.itemNo === 'T4001'));
  assert.ok(drills && drills.data.serials.length === drills.data.lines.find((l) => l.itemNo === 'T4001').shipped, 'every drill that left is listed by serial');
  const counted = messages.find((m) => m.type === 'stock.adjusted' && m.data.change < 0);
  assert.ok(counted, 'a short bin, counted down');

  // The log is part of the warehouse: replaying the journal numbers it the same way.
  let rt = rows[0].t;
  const again = Site.buildWarehouse(Demo.SITE, () => rt);
  for (const r of rows) { rt = r.t; COMMANDS[r.op](again, r.args, r.by); }
  assert.equal(JSON.stringify(again.messages), JSON.stringify(wh.messages));
});

test('messages out: read from where you left off, a page at a time, one client at a time', () => {
  const { wh } = shift(3);
  const all = wh.messageLog({ limit: 1000 }).messages;
  const first = wh.messageLog({ after: 0, limit: 5 });
  assert.equal(first.messages.length, 5);
  assert.equal(first.next, 5);
  assert.equal(first.more, true);
  const second = wh.messageLog({ after: first.next, limit: 5 });
  assert.deepEqual(second.messages.map((m) => m.seq), [6, 7, 8, 9, 10]);
  const end = wh.messageLog({ after: wh.messageLog({ limit: 1000 }).last });
  assert.deepEqual(end.messages, []);
  assert.equal(end.more, false);
  const mine = wh.messageLog({ limit: 1000, clientId: 'CL-PAINT' }).messages;
  assert.ok(mine.length && mine.every((m) => m.clientId === 'CL-PAINT'));
  assert.equal(mine.length, all.filter((m) => m.clientId === 'CL-PAINT').length);
  const ships = wh.messageLog({ limit: 1000, type: 'order.shipped' }).messages;
  assert.ok(ships.length && ships.every((m) => m.type === 'order.shipped'));
  // Older messages dropped past the cap: a reader that far behind is told.
  wh.messages.splice(0, 10);
  assert.equal(wh.messageLog({ after: 0 }).gap, true);
  assert.equal(wh.messageLog({ after: 10 }).gap, false);
});

async function boot() {
  const site = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'site.json'), 'utf8'));
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

const cookieOf = (headers) => ((headers.getSetCookie && headers.getSetCookie()[0]) || headers.get('set-cookie') || '').split(';')[0];

test('API keys: an administrator makes one, shown once; it works with its role, a client key sees its own client, and a revoked key is locked out', async () => {
  const app = await boot();
  try {
    const admin = cookieOf((await app.call('POST', '/api/login', { username: 'admin', password: 'sorted-admin' })).headers);
    assert.equal((await app.call('POST', '/api/keys', { name: 'boss', role: 'administrator' }, { cookie: admin })).status, 400, 'never an administrator');
    assert.equal((await app.call('POST', '/api/keys', { name: 'shop', role: 'client' }, { cookie: admin })).status, 400, 'a client key names its client');
    const made = await app.call('POST', '/api/keys', { name: 'erp', role: 'office' }, { cookie: admin });
    assert.equal(made.status, 200);
    assert.match(made.body.key, /^swk_[\w-]{20,}$/);
    const listed = await app.call('GET', '/api/keys', null, { cookie: admin });
    assert.equal(JSON.stringify(listed.body).includes(made.body.key), false, 'the key itself is never shown again');
    assert.equal(listed.body.keys[0].name, 'erp');

    const erp = { authorization: `Bearer ${made.body.key}` };
    assert.equal((await app.call('GET', '/api/messages', null, erp)).status, 200);
    assert.equal((await app.call('GET', '/api/users', null, erp)).status, 403, 'only what its role may do');
    assert.equal((await app.call('GET', '/api/orders', null, { authorization: 'Bearer swk_not-a-key' })).status, 401);

    // A client key: that client's orders and messages only.
    const shopKey = (await app.call('POST', '/api/keys', { name: 'paint-shop', role: 'client', clientId: 'cl-paint' }, { cookie: admin })).body;
    assert.equal(shopKey.clientId, 'CL-PAINT');
    app.store.exec('addOrder', { id: 'P1', customer: 'Harbour Hardware', lane: 'OUT-01', clientId: 'CL-PAINT', lines: [] }, 'office');
    app.store.exec('addOrder', { id: 'G1', customer: 'Corner Builders', lane: 'OUT-01', clientId: 'CL-GARDEN', lines: [] }, 'office');
    const shop = { 'x-api-key': shopKey.key };
    const orders = await app.call('GET', '/api/orders', null, shop);
    assert.deepEqual(orders.body.map((o) => o.id), ['P1']);
    const journal = app.store.journal({ limit: 5 });
    assert.ok(journal.length);

    const revoked = await app.call('POST', `/api/keys/${made.body.id}/revoke`, {}, { cookie: admin });
    assert.ok(revoked.body.revokedAt);
    assert.equal((await app.call('GET', '/api/messages', null, erp)).status, 401, 'revoked: locked out at once');
    const log = await app.call('GET', '/api/auth-log', null, { cookie: admin });
    assert.ok(JSON.stringify(log.body).includes('api-key-revoked'));
  } finally { await app.close(); }
});
