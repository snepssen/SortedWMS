/*
 * Handheld scans kept on the device while the network is down.
 * They send in order when the connection returns. A refusal stops the
 * rest of the queue so a later scan cannot run on the wrong stock.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SortedOffline = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function createOfflineQueue(storage, key = 'sorted.offline.queue') {
    function load() {
      try {
        const parsed = JSON.parse(storage.getItem(key) || '');
        if (parsed && Array.isArray(parsed.pending) && Array.isArray(parsed.conflicts)) return parsed;
      } catch (e) { /* empty */ }
      return { pending: [], conflicts: [] };
    }
    function save(data) {
      storage.setItem(key, JSON.stringify(data));
    }
    let running;
    async function drain(send) {
      let sent = 0;
      for (;;) {
        const { pending, conflicts } = load();
        const item = pending[0];
        if (conflicts.length || !item) return { pending: pending.length, conflicts, stopped: conflicts.length ? 'conflict' : null, sent };
        let result;
        try {
          result = await send(item);
        } catch (e) {
          if (e.network) return { pending: load().pending.length, conflicts, stopped: 'offline', sent };
          result = { ok: false, text: e.message };
        }
        // Another scan may have joined the queue while the request was in flight.
        const latest = load();
        if (latest.pending[0]?.id !== item.id) continue;
        latest.pending.shift();
        if (result && (result.ok === false || result.conflict)) {
          latest.conflicts.push({ ...item, error: result.text || result.error || 'Rejected', at: Date.now() });
        } else sent++;
        save(latest);
      }
    }
    return {
      enqueue(item) {
        const data = load();
        data.pending.push({ method: item.method, path: item.path, body: item.body || null, id: item.id || `off-${data.pending.length + 1}`, queuedAt: Date.now() });
        save(data);
        return data.pending.length;
      },
      snapshot() {
        return load();
      },
      discardSequence() {
        if (load().conflicts.length) save({ pending: [], conflicts: [] });
      },
      discardConflict(index) {
        const data = load();
        data.conflicts.splice(Number(index), 1);
        save(data);
        return data.conflicts;
      },
      flush(send) {
        if (!running) running = drain(send).finally(() => { running = null; });
        return running;
      },
    };
  }

  return { createOfflineQueue };
});
