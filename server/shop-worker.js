'use strict';

/** Persist shipment work before advancing the ingestion cursor. */
function createShopWorker({ store, connector, metaTable, shops, pull, deliver, journal, now = Date.now }) {
  store.db.exec(`CREATE TABLE IF NOT EXISTS shop_deliveries (
    connector TEXT NOT NULL, site TEXT NOT NULL, seq INTEGER NOT NULL, payload TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL DEFAULT 0,
    delivered_at INTEGER, PRIMARY KEY (connector, site, seq)
  )`);
  const busy = new Set();

  async function runSite() {
    const site = store.siteId || 'MAIN';
    if (busy.has(site)) return;
    const wh = store.warehouse(site);
    if (!wh.module(connector)) return;
    busy.add(site);
    try {
      for (const shop of shops()) {
        if (!shop.active) continue;
        const key = `poll:${shop.id}`;
        const previous = store.db.prepare(`SELECT value FROM ${metaTable} WHERE site = ? AND key = ?`).get(site, key);
        if (previous && now() - Number(previous.value) < shop.poll_minutes * 60000) continue;
        try {
          await pull(shop.id);
          store.db.prepare(`INSERT INTO ${metaTable} (site, key, value) VALUES (?, ?, ?)
            ON CONFLICT(site, key) DO UPDATE SET value = excluded.value`).run(site, key, String(now()));
        } catch (e) { journal(shop.id, false, 'import', e.message); }
      }
      const cursor = store.db.prepare(`SELECT value FROM ${metaTable} WHERE site = ? AND key = ?`).get(site, 'message-cursor');
      let after = Number(cursor?.value) || 0;
      let page;
      do {
        page = store.warehouse(site).messageLog({ after, limit: 100, type: 'order.shipped' });
        store.db.exec('BEGIN');
        try {
          for (const message of page.messages) {
            store.db.prepare('INSERT OR IGNORE INTO shop_deliveries (connector, site, seq, payload) VALUES (?, ?, ?, ?)')
              .run(connector, site, message.seq, JSON.stringify(message));
          }
          store.db.prepare(`INSERT INTO ${metaTable} (site, key, value) VALUES (?, ?, ?)
            ON CONFLICT(site, key) DO UPDATE SET value = excluded.value`).run(site, 'message-cursor', String(page.next));
          store.db.exec('COMMIT');
        } catch (e) {
          store.db.exec('ROLLBACK');
          throw e;
        }
        after = page.next;
      } while (page.more);

      const waiting = store.db.prepare(`SELECT seq, payload, attempts FROM shop_deliveries
        WHERE connector = ? AND site = ? AND delivered_at IS NULL AND next_attempt <= ? ORDER BY seq LIMIT 100`)
        .all(connector, site, now());
      for (const row of waiting) {
        try {
          await deliver(JSON.parse(row.payload));
          store.db.prepare('UPDATE shop_deliveries SET delivered_at = ? WHERE connector = ? AND site = ? AND seq = ?')
            .run(now(), connector, site, row.seq);
        } catch (e) {
          const wait = Math.min(900000, 15000 * 2 ** Math.min(row.attempts, 6));
          store.db.prepare('UPDATE shop_deliveries SET attempts = attempts + 1, next_attempt = ? WHERE connector = ? AND site = ? AND seq = ?')
            .run(now() + wait, connector, site, row.seq);
          journal(null, false, 'fulfil', e.message);
        }
      }
    } finally { busy.delete(site); }
  }

  async function run() {
    for (const site of store.listSites()) {
      await store._withSite(site.id, runSite);
    }
  }

  function start() {
    const timer = setInterval(() => run().catch((e) => journal(null, false, 'worker', e.message)), 15000);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  return { run, start };
}

module.exports = { createShopWorker };
