const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('server/public/handheld.html', 'utf8');
const queueCode = source.slice(source.indexOf('  const queue = [];'), source.indexOf('  let refreshing = false'));

function queue(api) {
  let refreshed = 0;
  const ctx = vm.createContext({
    api, busy: false, localError: null, deviceId: 'TEST', Date, JSON, Promise,
    navigator: {}, netStatus() {}, $: () => ({ classList: { add() {} } }),
    setTimeout: (fn) => { queueMicrotask(fn); return 1; }, clearTimeout() {},
    refresh: async () => { refreshed++; },
  });
  vm.runInContext(queueCode, ctx);
  return { ctx, refreshed: () => refreshed, run: (code) => vm.runInContext(code, ctx) };
}

test('after an uncertain final timeout, following queued scans never run and the outcome warning persists', async () => {
  const requests = [];
  const q = queue(async (method, path, body, opts) => {
    requests.push({ path, body, opts });
    throw Object.assign(new Error('No answer'), { network: true });
  });
  q.run(`act('POST', '/scan', { code: 'FIRST' }); act('POST', '/scan', { code: 'NEXT' });`);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.length, 6);
  assert.ok(requests.every((r) => r.body.code === 'FIRST'));
  assert.equal(new Set(requests.map((r) => r.opts.requestId)).size, 1);
  assert.match(q.run('localError'), /outcome is unknown.*1 following scan\(s\) cancelled.*audit/);
  assert.equal(q.run('queue.length'), 0);
  assert.equal(q.run('sending'), null);
  assert.equal(q.refreshed(), 1);
});

test('normal scans remain serial, while a duplicate pending pallet scan is ignored', async () => {
  const calls = [];
  let release;
  const first = new Promise((resolve) => { release = resolve; });
  const q = queue(async (method, path, body) => {
    calls.push(body.code);
    if (calls.length === 1) await first;
  });
  q.run(`act('POST', '/scan', { code: 'FIRST' }); act('POST', '/scan', { code: 'FIRST' }); act('POST', '/scan', { code: 'NEXT' });`);
  assert.deepEqual(calls, ['FIRST']);
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ['FIRST', 'NEXT']);
  assert.equal(q.run('localError'), null);
});
