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
