const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Store } = require('../server/store');
const { Printers } = require('../server/print');
const { createApi } = require('../server/api');

const site = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'site.json'), 'utf8'));
const src = (f) => fs.readFileSync(path.join(__dirname, '..', 'server', f), 'utf8');

// A route that names something its file never declared answers with one of
// these. A merge that drops a parameter or a helper shows up here.
const BROKEN = /is not defined|is not a function|before initialization/;
// An empty request is refused in words a person can act on, not in the
// engine's own ("rows is not iterable", "Unknown item undefined").
const CLUMSY = /is not iterable|Cannot read propert|Cannot destructure|\b(undefined|null|NaN|\[object Object\])\b/;

/** The names in `function <fn>({ a, b = null })`, and in a call `<fn>({ a, b })`. */
function names(text) {
  return text.split(',').map((p) => p.split('=')[0].split(':')[0].trim()).filter(Boolean);
}
function declared(source, fn) {
  const m = source.match(new RegExp(`function ${fn}\\(\\{([^}]*)\\}\\)`));
  assert.ok(m, `${fn} takes one object of named services`);
  return names(m[1]);
}
function calls(source, fn) {
  return [...source.matchAll(new RegExp(`(?<!function )\\b${fn}\\(\\{([^}]*)\\}\\)`, 'g'))].map((m) => names(m[1]));
}

test('every route answers an empty request in plain words, and names nothing its file never declared', async () => {
  const store = new Store({ site });
  try {
    // No optional service is passed: a route for one says so, it does not fall over.
    const api = createApi({ store, printers: new Printers({}) });
    const routes = api.routes();
    assert.ok(routes.length > 150, `the route list is whole (${routes.length})`);
    const actor = { username: 'admin', role: 'administrator', name: 'Administrator' };
    const broken = [];
    const clumsy = [];
    for (const { method, pattern } of routes) {
      const url = pattern.replace(/:(\w+)/g, 'x');
      let out;
      try { out = await api.handle(method, url, {}, 'admin', null, actor); } catch (e) { out = { status: 500, body: { error: e.message } }; }
      const error = out && out.body && typeof out.body === 'object' ? String(out.body.error || '') : '';
      if ((out && out.status >= 500) || BROKEN.test(error)) broken.push(`${method} ${pattern}: ${out.status} ${error}`);
      else if (CLUMSY.test(error)) clumsy.push(`${method} ${pattern}: ${error}`);
    }
    assert.deepEqual(broken, []);
    assert.deepEqual(clumsy, [], 'an empty request is refused in plain words');
  } finally { store.close(); }
});

test('every service the API takes is handed to it, and every service the server takes is handed on', () => {
  const index = src('index.js');
  const apiTakes = declared(src('api.js'), 'createApi');
  const serverTakes = declared(index, 'createServer');

  // The server builds its API from what it was given.
  const built = calls(index, 'createApi');
  assert.ok(built.length >= 1);
  const optional = apiTakes.filter((n) => !['store', 'printers'].includes(n));
  for (const name of optional) {
    assert.ok(serverTakes.includes(name), `createServer takes ${name}, which createApi needs`);
    assert.ok(built[0].includes(name), `createServer passes ${name} to createApi`);
  }

  // main() builds the server from every service it starts. The token comes from the environment.
  const started = calls(index, 'createServer');
  assert.equal(started.length, 1, 'main() starts one server');
  for (const name of serverTakes.filter((n) => n !== 'token')) {
    assert.ok(started[0].includes(name), `main() passes ${name} to createServer`);
  }
});
