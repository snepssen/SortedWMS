const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { build, collect, OUT } = require('../scripts/api-reference');

test('docs/API.md is what the route tables say today: run `npm run api-reference` after adding or changing a route', () => {
  assert.equal(fs.readFileSync(OUT, 'utf8'), build());
});

test('the reference has every route once, each with a permission or marked public', () => {
  const { rows, roles } = collect();
  assert.ok(rows.length > 300, `the route list is whole (${rows.length})`);
  assert.equal(new Set(rows.map((r) => `${r.method} ${r.pattern}`)).size, rows.length);
  for (const r of rows) {
    assert.ok(r.public || r.permission, `${r.method} ${r.pattern} needs a permission`);
    if (!r.public) assert.ok(r.roles.includes('administrator'), `${r.method} ${r.pattern}: an administrator can always call it`);
  }
  assert.ok(roles.includes('picker'));

  const find = (method, pattern) => rows.find((r) => r.method === method && r.pattern === pattern);
  assert.equal(find('GET', '/api/health').public, true);
  assert.equal(find('POST', '/api/login').public, true);
  assert.equal(find('GET', '/api/metrics').permission, 'settings.read', 'a route the server answers itself is here too');
  assert.equal(find('POST', '/api/password-rules').permission, 'users.write');
  assert.deepEqual(find('POST', '/api/password-rules').roles, ['administrator']);
  assert.equal(find('GET', '/api/notify/inbox').module, 'alerts', 'a module route names its module');
  assert.equal(find('GET', '/api/stock').module, null);
});

test('each route names the fields its handler reads, and the page is built from that', () => {
  const { rows } = collect();
  const orders = rows.find((r) => r.method === 'POST' && r.pattern === '/api/orders');
  for (const name of ['id', 'customer', 'lane', 'lines']) assert.ok(orders.fields.body.includes(name), name);
  assert.ok(orders.fields.required.includes('id'));
  assert.match(orders.request, /id\*/);

  const health = rows.find((r) => r.method === 'GET' && r.pattern === '/api/health');
  assert.deepEqual(health.fields.response, ['ok', 'auth']);

  const login = rows.find((r) => r.method === 'POST' && r.pattern === '/api/login');
  assert.ok(login.fields.body.includes('username') && login.fields.body.includes('password'));
  assert.ok(login.fields.response.includes('user'));

  for (const row of rows) {
    for (const m of (row.fields.src || '').matchAll(/\bb(?:ody)?\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
      if (m[1] === 'length' || m[1] === 'then') continue;
      assert.ok(row.fields.body.includes(m[1]), `${row.method} ${row.pattern} reads ${m[1]}`);
    }
    assert.ok(row.request && row.response, `${row.method} ${row.pattern} has both columns`);
  }
});
