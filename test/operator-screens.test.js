const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const settle = () => new Promise((resolve) => setImmediate(resolve));

function screen(name) {
  const nodes = new Map();
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, { id, value: '', textContent: '', innerHTML: '', open: false, contains: () => false, focus() {}, closest: () => null });
    return nodes.get(id);
  };
  const timers = [], requests = [];
  let acceptToken = false, rejectAction = false;
  const payload = (path) => {
    if (path === '/api/stations') return [{ id: 'PRESS', name: 'Pallet change' }];
    if (path === '/api/devices') return [{ id: 'DESK1', kind: 'desk' }];
    if (path === '/api/deliveries') return [];
    if (path === '/api/stations/PRESS') return { station: { name: 'Pallet change', machine: 'Press', sop: [], message: null }, working: [], queue: [], waiting: [], coming: 0 };
    if (path === '/api/devices/DESK1') return { instruction: { kind: 'idle' }, message: null };
    return { ok: true };
  };
  const ctx = vm.createContext({
    URLSearchParams, Date, console, location: { search: '' },
    localStorage: { getItem: () => null, setItem() {} },
    document: { querySelector: (s) => node(s.slice(1)), querySelectorAll: () => [], activeElement: null, body: { addEventListener() {} } },
    fetch: async (path, opts) => {
      requests.push({ path, ...opts });
      const ok = acceptToken && opts.headers['x-token'] === 'test-only-token' && !(rejectAction && opts.method === 'POST');
      return { ok, statusText: 'Unauthorized', json: async () => ok ? payload(path) : { error: rejectAction && opts.method === 'POST' ? 'Action refused for testing' : 'Token required' } };
    },
    setInterval: (fn) => timers.push(fn), window: {},
  });
  const source = fs.readFileSync(`server/public/${name}.html`, 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
  vm.runInContext(source, ctx, { filename: `${name}.html` });
  return { node, timers, requests, authorize() { acceptToken = true; }, rejectAction() { rejectAction = true; } };
}

for (const name of ['station', 'desk']) {
  test(`${name}: failed startup is visible; Connect retries with a non-persisted token and one poller`, async () => {
    const s = screen(name);
    await settle();
    assert.match(s.node('main').innerHTML, /Token required/);
    assert.equal(s.node('connection').open, true);
    s.authorize();
    s.node('token').value = 'test-only-token';
    s.node('connectForm').onsubmit({ preventDefault() {} });
    await settle();
    assert.doesNotMatch(s.node('main').innerHTML, /Token required/);
    assert.equal(s.node('connectionStatus').textContent, '');
    const count = s.timers.length;
    assert.equal(count, name === 'station' ? 2 : 1);
    s.node('connectForm').onsubmit({ preventDefault() {} });
    await settle();
    assert.equal(s.timers.length, count);
    assert.ok(s.requests.slice(1).every((r) => r.headers['x-token'] === 'test-only-token'));
    s.node('token').value = 'wrong-token';
    await s.node('connectForm').onsubmit({ preventDefault() {} });
    assert.match(s.node('main').innerHTML, /Token required/);
    assert.equal(s.node('connection').open, true);
    assert.equal(s.timers.length, count);
  });
}

test('station: action errors remain visible after a successful refresh', async () => {
  const s = screen('station');
  await settle();
  s.authorize();
  s.node('token').value = 'test-only-token';
  s.node('connectForm').onsubmit({ preventDefault() {} });
  await settle();
  s.rejectAction();
  s.node('scanIn').value = 'DEMO-PALLET';
  await s.node('scanForm').onsubmit({ preventDefault() {} });
  await settle();
  assert.match(s.node('main').innerHTML, /Action refused for testing/);
  await s.timers[0]();
  assert.match(s.node('main').innerHTML, /Action refused for testing/);
});

test('new operator screens expose accessible scan and connection controls and their scripts parse', () => {
  for (const name of ['station', 'desk']) {
    const html = fs.readFileSync(`server/public/${name}.html`, 'utf8');
    assert.match(html, /aria-label="(?:Station|Receiving desk)"/);
    assert.match(html, /aria-label="Scan (?:pallet|pallet label)"/);
    assert.match(html, /id="token" type="password"/);
    for (const [, source] of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) assert.doesNotThrow(() => new vm.Script(source));
  }
});
