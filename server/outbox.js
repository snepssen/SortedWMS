/*
 * Messages pushed out as they happen, for systems that would rather be told
 * than ask: webhooks, and an outbox folder.
 *
 * A webhook is a URL an administrator adds, for some message types and, if
 * it is for one client, that client's messages only. New messages are POSTed
 * to it in order, a batch at a time, signed with the webhook's secret. Only a
 * 2xx answer moves it on; anything else is tried again later, waiting longer
 * each time (up to 15 minutes), so nothing is skipped while the other side is
 * down. Where each webhook has got to is kept in the database, so a restart
 * carries on from there.
 *
 * The outbox folder (SORTED_OUTBOX) gets every message as a file of its own,
 * 000123-order.shipped.json, for a system that picks up files.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { createHmac, randomBytes } = require('crypto');

const BATCH = 50;
const MAX_WAIT = 15 * 60 * 1000;
const TYPES = ['delivery.received', 'order.shipped', 'return.received', 'return.graded', 'stock.adjusted'];

function sign(secret, body) {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

function createOutbox({ store, now = () => Date.now(), fetchImpl = (...a) => fetch(...a), timeoutMs = 10000, log = console } = {}) {
  const db = store.db;
  db.exec(`CREATE TABLE IF NOT EXISTS webhooks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT NOT NULL,
    types TEXT,
    client_id TEXT,
    site TEXT NOT NULL DEFAULT 'MAIN',
    secret TEXT NOT NULL,
    cursor INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    created_by TEXT,
    failures INTEGER NOT NULL DEFAULT 0,
    next_try INTEGER NOT NULL DEFAULT 0,
    last_ok INTEGER,
    last_error TEXT
  )`);
  const busy = new Set();
  const whOf = (site) => store.warehouse(site || 'MAIN');

  function view(row) {
    const wh = whOf(row.site);
    const types = row.types ? JSON.parse(row.types) : null;
    // How many messages it still has to get.
    let waiting = 0;
    try {
      let after = row.cursor;
      for (;;) {
        const page = wh.messageLog({ after, limit: 1000, clientId: row.client_id, type: types ? types.join(',') : null });
        waiting += page.messages.length;
        if (!page.more) break;
        after = page.next;
      }
    } catch (e) { waiting = null; }
    return { id: row.id, url: row.url, types, clientId: row.client_id || null, site: row.site, delivered: row.cursor, waiting, failures: row.failures, nextTry: row.next_try || null, lastOk: row.last_ok || null, lastError: row.last_error || null, createdAt: row.created_at, createdBy: row.created_by || null };
  }

  function list() {
    return db.prepare('SELECT * FROM webhooks ORDER BY id').all().map(view);
  }

  /** A new webhook. It starts at the next message, unless `fromStart`. Its secret is shown once. */
  function add({ url, types = null, clientId = null, site = 'MAIN', fromStart = false } = {}, by = null) {
    let u;
    try { u = new URL(String(url || '').trim()); } catch (e) { throw new Error('A webhook needs a full URL, like https://erp.example/sortedwms'); }
    if (!['http:', 'https:'].includes(u.protocol)) throw new Error('A webhook URL starts with http:// or https://');
    const kinds = types == null || types === '' || (Array.isArray(types) && !types.length) ? null : (Array.isArray(types) ? types : String(types).split(/[\s,]+/)).map((t) => t.trim()).filter(Boolean);
    for (const t of kinds || []) if (!TYPES.includes(t)) throw new Error(`Message type is one of ${TYPES.join(', ')}`);
    const owner = clientId ? String(clientId).trim().toUpperCase() : null;
    const wh = whOf(site);
    const start = fromStart ? 0 : wh.messageLog({ after: Number.MAX_SAFE_INTEGER }).last;
    const secret = `whs_${randomBytes(24).toString('base64url')}`;
    const info = db.prepare('INSERT INTO webhooks (url, types, client_id, site, secret, cursor, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(u.toString(), kinds ? JSON.stringify(kinds) : null, owner, String(site || 'MAIN').toUpperCase(), secret, start, now(), by);
    return { ...view(db.prepare('SELECT * FROM webhooks WHERE id = ?').get(Number(info.lastInsertRowid))), secret };
  }

  function remove(id) {
    const n = db.prepare('DELETE FROM webhooks WHERE id = ?').run(Number(id)).changes;
    if (!n) throw new Error('Unknown webhook');
    return { removed: Number(id) };
  }

  /** Try again now, without waiting for the back-off. */
  function retry(id) {
    const n = db.prepare('UPDATE webhooks SET next_try = 0 WHERE id = ?').run(Number(id)).changes;
    if (!n) throw new Error('Unknown webhook');
    return view(db.prepare('SELECT * FROM webhooks WHERE id = ?').get(Number(id)));
  }

  /** One round for one webhook: the next batch after its cursor, posted and, on 2xx, done. */
  async function deliver(row) {
    const types = row.types ? JSON.parse(row.types) : null;
    const page = whOf(row.site).messageLog({ after: row.cursor, limit: BATCH, clientId: row.client_id, type: types ? types.join(',') : null });
    if (!page.messages.length) {
      // Only other types or clients' messages since: move past them.
      if (page.next > row.cursor) db.prepare('UPDATE webhooks SET cursor = ? WHERE id = ?').run(page.next, row.id);
      return { sent: 0 };
    }
    const body = JSON.stringify({ webhook: row.id, messages: page.messages, gap: page.gap });
    let error = null;
    try {
      const res = await fetchImpl(row.url, {
        method: 'POST', body, signal: AbortSignal.timeout(timeoutMs),
        headers: { 'content-type': 'application/json', 'user-agent': 'SortedWMS', 'x-sorted-signature': sign(row.secret, body), 'x-sorted-delivery': `${row.id}-${page.messages[0].seq}-${page.messages[page.messages.length - 1].seq}` },
      });
      if (res.status < 200 || res.status >= 300) error = `HTTP ${res.status}`;
    } catch (e) { error = e.name === 'TimeoutError' ? 'No answer in time' : e.message; }
    if (error) {
      const failures = row.failures + 1;
      const wait = Math.min(MAX_WAIT, 5000 * 2 ** Math.min(failures - 1, 10));
      db.prepare('UPDATE webhooks SET failures = ?, next_try = ?, last_error = ? WHERE id = ?').run(failures, now() + wait, error, row.id);
      if (failures === 1 || failures % 10 === 0) log.warn(`Webhook ${row.id} (${row.url}): ${error}; trying again in ${Math.round(wait / 1000)} s`);
      return { sent: 0, error };
    }
    db.prepare('UPDATE webhooks SET cursor = ?, failures = 0, next_try = 0, last_ok = ?, last_error = NULL WHERE id = ?').run(page.messages[page.messages.length - 1].seq, now(), row.id);
    return { sent: page.messages.length, more: page.more };
  }

  /** Every webhook that is due, one request at a time each. */
  async function pump() {
    const out = {};
    for (const row of db.prepare('SELECT * FROM webhooks WHERE next_try <= ? ORDER BY id').all(now())) {
      if (busy.has(row.id)) continue;
      busy.add(row.id);
      try { out[row.id] = await deliver(row); } catch (e) { out[row.id] = { sent: 0, error: e.message }; } finally { busy.delete(row.id); }
    }
    return out;
  }

  /** The outbox folder: every new message as a file, where it left off kept in the database. */
  function writeFolder(dir) {
    fs.mkdirSync(dir, { recursive: true });
    const wh = whOf('MAIN');
    let after = store.meta('outbox.cursor') || 0;
    let written = 0;
    for (let page; (page = wh.messageLog({ after, limit: 500 })).messages.length;) {
      for (const m of page.messages) {
        const name = `${String(m.seq).padStart(6, '0')}-${m.type}.json`;
        const tmp = path.join(dir, `.${name}.tmp`);
        fs.writeFileSync(tmp, `${JSON.stringify(m, null, 2)}\n`);
        fs.renameSync(tmp, path.join(dir, name)); // whole files only: a reader never sees half of one
        written++;
      }
      after = page.next;
      store.meta('outbox.cursor', after);
      if (!page.more) break;
    }
    return written;
  }

  function start({ every = 5000, folder = null } = {}) {
    const timer = setInterval(() => {
      if (folder) { try { writeFolder(folder); } catch (e) { log.error('outbox folder', e); } }
      pump().catch((e) => log.error('webhooks', e));
    }, every);
    if (timer.unref) timer.unref();
    return () => clearInterval(timer);
  }

  return { list, add, remove, retry, pump, deliver, writeFolder, start, TYPES };
}

module.exports = { createOutbox, sign, TYPES };
