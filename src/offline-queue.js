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
      discardConflict(index) {
        const data = load();
        data.conflicts.splice(Number(index), 1);
        save(data);
        return data.conflicts;
      },
      async flush(send) {
        const data = load();
        let sent = 0;
        while (data.pending.length) {
          const item = data.pending[0];
          let res;
          try {
            res = await send(item);
          } catch (e) {
            if (e && e.network) {
              save(data);
              return { pending: data.pending.length, conflicts: data.conflicts.slice(), stopped: 'offline', sent };
            }
            data.pending.shift();
            data.conflicts.push({ ...item, error: e.message || 'Rejected', at: Date.now() });
            save(data);
            return { pending: data.pending.length, conflicts: data.conflicts.slice(), stopped: 'conflict', sent };
          }
          if (res && (res.ok === false || res.conflict)) {
            data.pending.shift();
            data.conflicts.push({ ...item, error: res.text || res.error || 'The warehouse refused this scan', at: Date.now() });
            save(data);
            return { pending: data.pending.length, conflicts: data.conflicts.slice(), stopped: 'conflict', sent };
          }
          data.pending.shift();
          sent++;
          save(data);
        }
        return { pending: 0, conflicts: data.conflicts.slice(), stopped: null, sent };
      },
    };
  }

  return { createOfflineQueue };
});
