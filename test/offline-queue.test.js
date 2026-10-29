const test = require('node:test');
const assert = require('node:assert/strict');
const { createOfflineQueue } = require('../src/offline-queue');

function memory() {
  const data = new Map();
  return { getItem: (k) => (data.has(k) ? data.get(k) : null), setItem: (k, v) => data.set(k, String(v)) };
}

test('offline scans send in order and a refusal holds the rest', async () => {
  const q = createOfflineQueue(memory());
  q.enqueue({ method: 'POST', path: '/api/devices/HH01/scan', body: { code: 'PALLET' }, id: 'a' });
  q.enqueue({ method: 'POST', path: '/api/devices/HH01/scan', body: { code: 'LOC' }, id: 'b' });
  q.enqueue({ method: 'POST', path: '/api/devices/HH01/scan', body: { code: 'NEXT' }, id: 'c' });
  const seen = [];
  const stopped = await q.flush(async (item) => {
    seen.push(item.body.code);
    if (item.body.code === 'LOC') return { ok: false, text: 'That location is blocked' };
    return { ok: true };
  });
  assert.deepEqual(seen, ['PALLET', 'LOC']);
  assert.equal(stopped.stopped, 'conflict');
  assert.equal(stopped.pending, 1);
  assert.equal(stopped.conflicts[0].error, 'That location is blocked');
  const sent = [];
  const again = await q.flush(async (item) => { sent.push(item.body.code); return { ok: true }; });
  assert.deepEqual(sent, ['NEXT']);
  assert.equal(again.pending, 0);
});

test('a network failure keeps the queued scan', async () => {
  const q = createOfflineQueue(memory());
  q.enqueue({ method: 'POST', path: '/scan', body: { code: 'ONE' }, id: 'a' });
  const first = await q.flush(async () => { const e = new Error('offline'); e.network = true; throw e; });
  assert.equal(first.stopped, 'offline');
  assert.equal(first.pending, 1);
  const second = await q.flush(async () => ({ ok: true }));
  assert.equal(second.sent, 1);
  assert.equal(second.pending, 0);
});
