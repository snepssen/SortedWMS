/*
 * Low-stock alerts. One alert per item until it recovers, then an optional
 * reminder while it stays low. A bounce back under the line before the
 * quiet period ends does not send another alert.
 *
 * Channels: the signed message log (webhooks and the outbox), SMTP, and the
 * in-app bell. A daily digest can hold the stock alerts until a local time.
 * backup.failed from the off-site backup module is delivered here when both
 * are on. See docs/ALERTS.md.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { sendMail } = require('./smtp');
const i18n = require('../src/i18n');
const { DEFAULTS } = require('./permissions');

const DAY = 86400000;
const KINDS = ['stock.low', 'stock.recovered', 'stock.digest', 'backup.failed', 'alert.test'];

function zoneFormat(timeZone) {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    });
  } catch (e) {
    throw new Error(`Unknown time zone ${timeZone}`);
  }
}

function localParts(ms, timeZone) {
  const bag = {};
  for (const part of zoneFormat(timeZone).formatToParts(new Date(ms))) bag[part.type] = part.value;
  if (bag.hour === '24') bag.hour = '00';
  return bag;
}

function localDay(ms, timeZone) {
  const p = localParts(ms, timeZone);
  return `${p.year}-${p.month}-${p.day}`;
}

function zonedAt(day, hh, mm, timeZone) {
  const want = Date.parse(`${day}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00Z`);
  let ms = want;
  for (let i = 0; i < 6; i++) {
    const p = localParts(ms, timeZone);
    const seen = Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`);
    if (seen === want) return ms;
    ms += want - seen;
  }
  return ms;
}

function clockTime(value, label) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
  if (!m) throw new Error(`${label} is a time like 07:00`);
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh > 23 || mm > 59) throw new Error(`${label} is a time like 07:00`);
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function minutes(hhmm) {
  const [hh, mm] = hhmm.split(':').map(Number);
  return hh * 60 + mm;
}

function inQuiet(cfg, now, timeZone) {
  if (!cfg.quietFrom || !cfg.quietTo || cfg.quietFrom === cfg.quietTo) return false;
  const p = localParts(now, timeZone);
  const cur = Number(p.hour) * 60 + Number(p.minute);
  const from = minutes(cfg.quietFrom);
  const to = minutes(cfg.quietTo);
  if (from < to) return cur >= from && cur < to;
  return cur >= from || cur < to;
}

/**
 * One step of the latch. `clear` alerts once when the level is low.
 * `low` stays quiet until it recovers, apart from a reminder.
 * `recovering` waits out the debounce. Dropping back under the line in that
 * window does not send a new alert and does not send a recovery.
 */
function advance(latch, isLow, now, { debounceMs = 0, reminderMs = 24 * 3600000 } = {}) {
  const phase = latch && latch.phase || 'clear';
  if (phase === 'clear') {
    if (!isLow) return { latch: { phase: 'clear', sinceMs: now, lastSent: null, pendingSince: null }, emit: null };
    return { latch: { phase: 'low', sinceMs: now, lastSent: now, pendingSince: null }, emit: 'low' };
  }
  if (phase === 'low') {
    if (!isLow) return { latch: { ...latch, phase: 'recovering', pendingSince: now }, emit: null };
    if (latch.lastSent != null && reminderMs > 0 && now - latch.lastSent >= reminderMs) {
      return { latch: { ...latch, lastSent: now }, emit: 'reminder' };
    }
    return { latch, emit: null };
  }
  if (isLow) return { latch: { ...latch, phase: 'low', pendingSince: null }, emit: null };
  if (now - (latch.pendingSince || now) >= debounceMs) {
    return { latch: { phase: 'clear', sinceMs: now, lastSent: null, pendingSince: null }, emit: 'recovered' };
  }
  return { latch, emit: null };
}

function sentence(lang, key, vars) {
  return i18n.t(lang, key).replace(/\{(\w+)\}/g, (_, name) => (vars[name] == null ? '' : String(vars[name])));
}

function describe(lang, event) {
  if (event.type === 'backup.failed') return sentence(lang, 'Backup failed: {summary}', event);
  if (event.type === 'alert.test') return sentence(lang, 'This is a test alert from SortedWMS.', event);
  if (event.type === 'stock.digest') return event.summary || sentence(lang, 'Low-stock digest', event);
  const face = event.face ? sentence(lang, '{item} at {face} is at or below its reorder point: {available} available, reorder point {point}.', { item: event.name || event.itemNo, face: event.face, available: event.available, point: event.reorderPoint }) : '';
  if (event.type === 'stock.recovered' || event.emit === 'recovered') {
    return sentence(lang, '{item} is back above its reorder point: {available} available, reorder point {point}.', { item: event.name || event.itemNo, available: event.available, point: event.reorderPoint });
  }
  if (event.reminder || event.emit === 'reminder') {
    return sentence(lang, 'Reminder: {item} is still at or below its reorder point ({available} available, reorder point {point}).', { item: event.name || event.itemNo, available: event.available, point: event.reorderPoint });
  }
  if (face && event.face) return face;
  return sentence(lang, '{item} is at or below its reorder point: {available} available, reorder point {point}.', { item: event.name || event.itemNo, available: event.available, point: event.reorderPoint });
}

function defaultConfig() {
  return {
    mode: 'instant',
    digestTime: '07:00',
    quietFrom: '',
    quietTo: '',
    reminderHours: 24,
    debounceMinutes: 30,
    perPickFace: false,
    warehouseRecipients: [],
    clientRecipients: {},
    smtp: { host: '', port: 587, mode: 'starttls', user: '', from: '' },
  };
}

function createAlerts({ store, secretsFile = undefined, env = process.env, log = () => {}, now = null, mailer = sendMail } = {}) {
  if (!store || !store.db) throw new Error('Alerts need the warehouse database');
  const clock = typeof now === 'function' ? now : () => Date.now();
  const secretsPath = secretsFile === undefined
    ? (store.file && store.file !== ':memory:' ? path.join(path.dirname(store.file), 'alert-secrets.json') : null)
    : secretsFile;
  let memorySecrets = { smtpPassword: null };
  let busy = false;

  function ensure() {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS alert_config (site TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS alert_latch (
        site TEXT NOT NULL,
        item_key TEXT NOT NULL,
        phase TEXT NOT NULL,
        since_ms INTEGER NOT NULL,
        last_sent INTEGER,
        pending_since INTEGER,
        PRIMARY KEY (site, item_key)
      );
      CREATE TABLE IF NOT EXISTS alert_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        site TEXT NOT NULL,
        t INTEGER NOT NULL,
        hold TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS alert_sent (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        site TEXT NOT NULL,
        t INTEGER NOT NULL,
        channel TEXT NOT NULL,
        kind TEXT NOT NULL,
        summary TEXT NOT NULL,
        recipient TEXT
      );
      CREATE TABLE IF NOT EXISTS alert_note (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        site TEXT NOT NULL,
        t INTEGER NOT NULL,
        kind TEXT NOT NULL,
        summary TEXT NOT NULL,
        client_id TEXT
      );
      CREATE TABLE IF NOT EXISTS alert_read (
        note INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        PRIMARY KEY (note, user_id)
      );
      CREATE TABLE IF NOT EXISTS alert_meta (site TEXT NOT NULL, key TEXT NOT NULL, value TEXT, PRIMARY KEY (site, key));
    `);
  }
  ensure();

  function siteId() { return String(store.siteId || 'MAIN').toUpperCase(); }
  function warehouse() {
    try { return store.warehouse ? store.warehouse(siteId()) : store.wh; } catch (e) { return store.wh; }
  }
  function timeZone() {
    const wh = warehouse();
    return (wh && wh.config && wh.config.timeZone) || 'Europe/Brussels';
  }
  function language() {
    const wh = warehouse();
    return (wh && wh.config && wh.config.language) || 'en';
  }

  function loadSecrets() {
    if (!secretsPath) return { smtpPassword: memorySecrets.smtpPassword || null };
    if (!fs.existsSync(secretsPath)) return { smtpPassword: null };
    try {
      const data = JSON.parse(fs.readFileSync(secretsPath, 'utf8'));
      return { smtpPassword: data.smtpPassword || null };
    } catch (e) {
      throw new Error('The alert secrets file could not be read');
    }
  }
  function writeSecrets(data) {
    const clean = { smtpPassword: data.smtpPassword || null };
    if (!secretsPath) { memorySecrets = clean; return; }
    fs.mkdirSync(path.dirname(secretsPath), { recursive: true });
    const tmp = `${secretsPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(clean), { mode: 0o600 });
    fs.renameSync(tmp, secretsPath);
    try { fs.chmodSync(secretsPath, 0o600); } catch (e) { /* the platform may ignore the mode */ }
  }
  function password() {
    if (env.SORTED_SMTP_PASSWORD) return String(env.SORTED_SMTP_PASSWORD);
    return loadSecrets().smtpPassword || '';
  }
  function redact(text) {
    let out = String(text || '');
    const secret = password();
    if (secret && secret.length >= 4) out = out.split(secret).join('***');
    return out;
  }

  function readConfig() {
    const row = store.db.prepare('SELECT json FROM alert_config WHERE site = ?').get(siteId());
    const cfg = { ...defaultConfig(), ...(row ? JSON.parse(row.json) : {}) };
    cfg.smtp = { ...defaultConfig().smtp, ...(cfg.smtp || {}) };
    cfg.warehouseRecipients = Array.isArray(cfg.warehouseRecipients) ? cfg.warehouseRecipients : [];
    cfg.clientRecipients = cfg.clientRecipients && typeof cfg.clientRecipients === 'object' ? cfg.clientRecipients : {};
    return cfg;
  }
  function writeConfig(cfg) {
    store.db.prepare('INSERT INTO alert_config (site, json) VALUES (?, ?) ON CONFLICT(site) DO UPDATE SET json = excluded.json').run(siteId(), JSON.stringify(cfg));
  }

  function meta(key, value) {
    if (value === undefined) {
      const row = store.db.prepare('SELECT value FROM alert_meta WHERE site = ? AND key = ?').get(siteId(), key);
      return row ? JSON.parse(row.value) : null;
    }
    store.db.prepare('INSERT INTO alert_meta (site, key, value) VALUES (?, ?, ?) ON CONFLICT(site, key) DO UPDATE SET value = excluded.value').run(siteId(), key, JSON.stringify(value));
    return value;
  }

  function enabled() {
    const wh = warehouse();
    return !wh || typeof wh.module !== 'function' || wh.module('alerts');
  }

  function publicConfig(actor) {
    const cfg = readConfig();
    const own = actor && actor.role === 'client' ? String(actor.clientId || '').toUpperCase() : null;
    const smtp = { host: cfg.smtp.host, port: cfg.smtp.port, mode: cfg.smtp.mode, user: cfg.smtp.user, from: cfg.smtp.from, passwordSet: Boolean(password()) };
    if (own) {
      const mine = (cfg.clientRecipients[own] || []).find((r) => r.userId === actor.id) || null;
      return { mode: cfg.mode, digestTime: cfg.digestTime, timeZone: timeZone(), language: language(), clientId: own, subscribed: Boolean(mine), email: mine ? mine.email || '' : '' };
    }
    return {
      ...cfg,
      smtp,
      timeZone: timeZone(),
      language: language(),
      passphrase: undefined,
    };
  }

  function save(patch = {}, actor = null) {
    if (actor && actor.role === 'client') throw new Error('A client login can subscribe, not change the warehouse alerts');
    const cfg = readConfig();
    const secrets = loadSecrets();
    if (patch.mode != null) {
      if (!['instant', 'digest'].includes(patch.mode)) throw new Error('Alerts are instant or a daily digest');
      cfg.mode = patch.mode;
    }
    if (patch.digestTime != null) cfg.digestTime = clockTime(patch.digestTime, 'Digest time');
    if (patch.quietFrom != null) cfg.quietFrom = patch.quietFrom ? clockTime(patch.quietFrom, 'Quiet hours') : '';
    if (patch.quietTo != null) cfg.quietTo = patch.quietTo ? clockTime(patch.quietTo, 'Quiet hours') : '';
    if (patch.reminderHours != null) {
      const n = Number(patch.reminderHours);
      if (!Number.isInteger(n) || n < 1 || n > 720) throw new Error('The reminder is a whole number of hours from 1 to 720');
      cfg.reminderHours = n;
    }
    if (patch.debounceMinutes != null) {
      const n = Number(patch.debounceMinutes);
      if (!Number.isInteger(n) || n < 0 || n > 1440) throw new Error('The quiet period after a recovery is a whole number of minutes from 0 to 1440');
      cfg.debounceMinutes = n;
    }
    if (patch.perPickFace != null) cfg.perPickFace = Boolean(patch.perPickFace);
    if (patch.smtp) {
      const smtp = patch.smtp;
      if (smtp.host != null) cfg.smtp.host = String(smtp.host).trim();
      if (smtp.port != null) {
        const port = Number(smtp.port);
        if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('The SMTP port is not valid');
        cfg.smtp.port = port;
      }
      if (smtp.mode != null) {
        if (!['starttls', 'smtps', 'plain'].includes(smtp.mode)) throw new Error('SMTP mode is starttls, smtps or plain');
        cfg.smtp.mode = smtp.mode;
      }
      if (smtp.user != null) cfg.smtp.user = String(smtp.user);
      if (smtp.from != null) cfg.smtp.from = String(smtp.from).trim();
      if (typeof smtp.password === 'string' && smtp.password) secrets.smtpPassword = smtp.password;
      if (smtp.clearPassword) secrets.smtpPassword = null;
    }
    if (patch.warehouseRecipients) cfg.warehouseRecipients = cleanRecipients(patch.warehouseRecipients);
    if (patch.clientRecipients) {
      const next = {};
      for (const [id, list] of Object.entries(patch.clientRecipients)) {
        const key = String(id).trim().toUpperCase();
        if (!key) continue;
        next[key] = cleanRecipients(list);
      }
      cfg.clientRecipients = next;
    }
    writeConfig(cfg);
    writeSecrets(secrets);
    return { ok: true };
  }

  function cleanRecipients(list) {
    if (!Array.isArray(list)) throw new Error('Recipients are a list');
    return list.slice(0, 50).map((row) => {
      const email = String(row.email || '').trim();
      if (email && !/^[^\s@]+@[^\s@]+$/.test(email)) throw new Error('That email address is not valid');
      const userId = row.userId == null || row.userId === '' ? null : Number(row.userId);
      if (userId != null && !Number.isInteger(userId)) throw new Error('A recipient user is a whole number');
      if (!email && userId == null) throw new Error('A recipient needs an email or a user');
      return { email, userId };
    });
  }

  function subscribe(actor, body = {}) {
    if (!actor || actor.role !== 'client' || !actor.clientId) throw new Error('A client login subscribes for its own items');
    const clientId = String(actor.clientId).toUpperCase();
    const cfg = readConfig();
    const list = (cfg.clientRecipients[clientId] || []).filter((r) => r.userId !== actor.id);
    if (body.unsubscribe) {
      cfg.clientRecipients[clientId] = list;
    } else {
      const email = String(body.email || '').trim();
      if (email && !/^[^\s@]+@[^\s@]+$/.test(email)) throw new Error('That email address is not valid');
      list.push({ email, userId: actor.id });
      cfg.clientRecipients[clientId] = list;
    }
    writeConfig(cfg);
    return { ok: true, subscribed: !body.unsubscribe, clientId };
  }

  function levels() {
    const wh = warehouse();
    const cfg = readConfig();
    const rows = [];
    if (!wh || typeof wh.availability !== 'function') return rows;
    for (const row of wh.availability()) {
      if (row.reorderPoint == null) continue;
      const item = wh.items[row.itemNo] || {};
      rows.push({
        key: `item:${row.itemNo}`,
        itemNo: row.itemNo,
        name: row.name || item.name || row.itemNo,
        clientId: item.clientId || null,
        available: row.available,
        reorderPoint: row.reorderPoint,
        face: null,
        low: row.available <= row.reorderPoint,
      });
    }
    if (cfg.perPickFace && typeof wh._pickFaces === 'function') {
      for (const loc of wh._pickFaces()) {
        const spec = loc.replenishment;
        const item = spec && wh.items[spec.itemNo];
        if (!item || item.reorderPoint == null) continue;
        const qty = typeof wh._faceQty === 'function' ? wh._faceQty(loc) : 0;
        rows.push({
          key: `face:${loc.code}:${spec.itemNo}`,
          itemNo: spec.itemNo,
          name: item.name,
          clientId: item.clientId || null,
          available: qty,
          reorderPoint: item.reorderPoint,
          face: loc.code,
          low: qty <= item.reorderPoint,
        });
      }
    }
    return rows;
  }

  function readLatch(key) {
    const row = store.db.prepare('SELECT phase, since_ms, last_sent, pending_since FROM alert_latch WHERE site = ? AND item_key = ?').get(siteId(), key);
    if (!row) return null;
    return { phase: row.phase, sinceMs: row.since_ms, lastSent: row.last_sent, pendingSince: row.pending_since };
  }
  function writeLatch(key, latch) {
    store.db.prepare(`INSERT INTO alert_latch (site, item_key, phase, since_ms, last_sent, pending_since) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(site, item_key) DO UPDATE SET phase = excluded.phase, since_ms = excluded.since_ms, last_sent = excluded.last_sent, pending_since = excluded.pending_since`)
      .run(siteId(), key, latch.phase, latch.sinceMs, latch.lastSent, latch.pendingSince);
  }

  function evaluate() {
    if (!enabled()) return [];
    const cfg = readConfig();
    const sent = [];
    const opts = { debounceMs: cfg.debounceMinutes * 60000, reminderMs: cfg.reminderHours * 3600000 };
    for (const level of levels()) {
      const step = advance(readLatch(level.key), level.low, clock(), opts);
      writeLatch(level.key, step.latch);
      if (!step.emit) continue;
      const type = step.emit === 'recovered' ? 'stock.recovered' : 'stock.low';
      const event = { ...level, type, reminder: step.emit === 'reminder' };
      sent.push(event);
      holdOrSend(event);
    }
    flushDue();
    return sent;
  }

  function holdOrSend(event) {
    const cfg = readConfig();
    const immediate = event.type === 'backup.failed' || event.type === 'alert.test';
    if (!immediate && cfg.mode === 'digest') { enqueue(event, 'digest'); return; }
    if (!immediate && inQuiet(cfg, clock(), timeZone())) { enqueue(event, 'quiet'); return; }
    return dispatch(event);
  }

  function enqueue(event, hold) {
    store.db.prepare('INSERT INTO alert_queue (site, t, hold, payload) VALUES (?, ?, ?, ?)').run(siteId(), clock(), hold, JSON.stringify(event));
  }

  function flushDue() {
    const cfg = readConfig();
    const now = clock();
    const tz = timeZone();
    if (!inQuiet(cfg, now, tz)) release('quiet');
      if (cfg.mode === 'digest') {
      const [hh, mm] = cfg.digestTime.split(':').map(Number);
      const slot = zonedAt(localDay(now, tz), hh, mm, tz);
      const last = meta('lastDigest');
      if (now >= slot && (last == null || last < slot)) {
        const queued = release('digest', true);
        meta('lastDigest', now);
        if (queued.length) deliverDigest(queued);
      }
    }
  }

  function deliverDigest(queued) {
    const cfg = readConfig();
    const lang = language();
    const groups = new Map();
    for (const event of queued) {
      const key = event.clientId || '';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(event);
    }
    const warehouseText = queued.map((event) => describe(lang, event)).join('\n');
    journal('bell', 'stock.digest', warehouseText, '');
    for (const person of cfg.warehouseRecipients || []) {
      if (!person.email || !cfg.smtp.host) continue;
      mailer({
        host: cfg.smtp.host, port: cfg.smtp.port, mode: cfg.smtp.mode, user: cfg.smtp.user, password: password(),
        from: cfg.smtp.from || cfg.smtp.user, to: person.email, subject: sentence(lang, 'Low-stock digest', {}), text: warehouseText,
      }).then(() => journal('email', 'stock.digest', warehouseText, person.email)).catch((err) => journal('email-failed', 'stock.digest', redact(err.message), person.email));
    }
    for (const [key, items] of groups) {
      const clientId = key || null;
      const summary = items.map((event) => describe(lang, event)).join('\n');
      note('stock.digest', summary, clientId);
      emitMessage({ type: 'stock.digest', clientId, items, summary, name: 'digest' }, summary);
      if (!clientId) continue;
      for (const person of cfg.clientRecipients[clientId] || []) {
        if (!person.email || !cfg.smtp.host) continue;
        mailer({
          host: cfg.smtp.host, port: cfg.smtp.port, mode: cfg.smtp.mode, user: cfg.smtp.user, password: password(),
          from: cfg.smtp.from || cfg.smtp.user, to: person.email, subject: sentence(lang, 'Low-stock digest', {}), text: summary,
        }).then(() => journal('email', 'stock.digest', summary, person.email)).catch((err) => journal('email-failed', 'stock.digest', redact(err.message), person.email));
      }
    }
  }

  function release(hold, keep = false) {
    const rows = store.db.prepare('SELECT id, payload FROM alert_queue WHERE site = ? AND hold = ? ORDER BY id').all(siteId(), hold);
    if (!rows.length) return [];
    if (!keep) {
      for (const row of rows) dispatch(JSON.parse(row.payload));
    }
    store.db.prepare('DELETE FROM alert_queue WHERE site = ? AND hold = ?').run(siteId(), hold);
    return rows.map((row) => JSON.parse(row.payload));
  }

  function dispatch(event) {
    const cfg = readConfig();
    const lang = language();
    const summary = event.summary || describe(lang, event);
    const safe = redact(summary).slice(0, 1000);
    note(event.type, safe, event.clientId || null);
    journal('bell', event.type, safe, event.clientId || '');
    if (KINDS.includes(event.type) && event.type !== 'stock.digest') emitMessage(event, safe);
    if (event.type === 'stock.digest') emitMessage({ ...event, summary: safe }, safe);
    const people = audience(cfg, event);
    for (const person of people) {
      if (!person.email || !cfg.smtp.host) continue;
      const body = event.type === 'stock.digest' ? digestBody(lang, event.items || [], person) : safe;
      if (!body) continue;
      mailer({
        host: cfg.smtp.host, port: cfg.smtp.port, mode: cfg.smtp.mode, user: cfg.smtp.user, password: password(),
        from: cfg.smtp.from || cfg.smtp.user, to: person.email, subject: event.type === 'stock.digest' ? sentence(lang, 'Low-stock digest', {}) : safe.slice(0, 140), text: body,
      }).then(() => journal('email', event.type, safe, person.email)).catch((err) => {
        journal('email-failed', event.type, redact(err.message), person.email);
        log(`Alert email failed: ${redact(err.message)}`);
      });
    }
    return safe;
  }

  function digestBody(lang, items, person) {
    const rows = items.filter((event) => sees(person, event));
    if (!rows.length) return '';
    return rows.map((event) => describe(lang, event)).join('\n');
  }

  function sees(person, event) {
    if (person.scope === 'warehouse') return true;
    return event.clientId && person.clientId === event.clientId;
  }

  function audience(cfg, event) {
    const out = [];
    for (const row of cfg.warehouseRecipients || []) out.push({ ...row, scope: 'warehouse', clientId: null });
    if (event.type === 'stock.digest') {
      for (const [clientId, list] of Object.entries(cfg.clientRecipients || {})) {
        for (const row of list || []) out.push({ ...row, scope: 'client', clientId });
      }
      return out;
    }
    if (event.clientId && cfg.clientRecipients[event.clientId]) {
      for (const row of cfg.clientRecipients[event.clientId]) out.push({ ...row, scope: 'client', clientId: event.clientId });
    }
    return out;
  }

  function emitMessage(event, summary) {
    const data = {
      itemNo: event.itemNo || null,
      name: event.name || null,
      available: event.available == null ? null : event.available,
      reorderPoint: event.reorderPoint == null ? null : event.reorderPoint,
      face: event.face || null,
      reminder: Boolean(event.reminder),
      summary,
      items: event.items ? event.items.map((item) => ({ itemNo: item.itemNo, name: item.name, clientId: item.clientId || null, available: item.available, reorderPoint: item.reorderPoint, face: item.face || null, type: item.type, reminder: Boolean(item.reminder) })) : undefined,
    };
    try {
      store.exec('recordAlert', { type: event.type, data, clientId: event.clientId || null }, 'system');
      journal('webhook', event.type, summary, event.clientId || '');
    } catch (e) {
      journal('webhook-failed', event.type, redact(e.message), '');
    }
  }

  function note(kind, summary, clientId) {
    store.db.prepare('INSERT INTO alert_note (site, t, kind, summary, client_id) VALUES (?, ?, ?, ?, ?)').run(siteId(), clock(), kind, summary, clientId || null);
  }
  function journal(channel, kind, summary, recipient) {
    store.db.prepare('INSERT INTO alert_sent (site, t, channel, kind, summary, recipient) VALUES (?, ?, ?, ?, ?, ?)').run(siteId(), clock(), channel, kind, redact(summary).slice(0, 1000), recipient || null);
  }

  function inbox(actor) {
    if (!actor) return { unread: [] };
    const own = actor.role === 'client' ? String(actor.clientId || '').toUpperCase() : null;
    const notes = store.db.prepare('SELECT id, t, kind, summary, client_id FROM alert_note WHERE site = ? ORDER BY id DESC LIMIT 100').all(siteId());
    const read = new Set(store.db.prepare('SELECT note FROM alert_read WHERE user_id = ?').all(actor.id).map((row) => row.note));
    const unread = notes.filter((row) => {
      if (read.has(row.id)) return false;
      if (own) return row.client_id === own;
      if (row.kind === 'backup.failed' || row.kind === 'alert.test' || row.kind === 'stock.digest' || !row.client_id) return canRead(actor);
      return canRead(actor);
    }).filter((row) => !own || row.client_id === own);
    return { unread: unread.map((row) => ({ id: row.id, at: row.t, kind: row.kind, summary: row.summary, clientId: row.client_id || null })) };
  }

  function markRead(actor, ids) {
    const want = Array.isArray(ids) ? ids : [ids];
    for (const id of want) {
      const n = Number(id);
      if (!Number.isInteger(n)) continue;
      store.db.prepare('INSERT INTO alert_read (note, user_id) VALUES (?, ?) ON CONFLICT DO NOTHING').run(n, actor.id);
    }
    return inbox(actor);
  }

  function canRead(actor) {
    if (!actor) return false;
    if (actor.role === 'administrator' || actor.service) return true;
    const perms = actor.permissions || DEFAULTS[actor.role] || [];
    return perms.includes('alerts.read');
  }

  function sent(limit = 30) {
    return store.db.prepare('SELECT t, channel, kind, summary, recipient FROM alert_sent WHERE site = ? ORDER BY id DESC LIMIT ?').all(siteId(), Math.min(100, limit)).map((row) => ({ at: row.t, channel: row.channel, kind: row.kind, summary: row.summary, recipient: row.recipient || null }));
  }

  function status(actor) {
    const view = publicConfig(actor);
    view.last = sent(1)[0] || null;
    view.sent = actor && actor.role === 'client' ? sent(20).filter((row) => !row.recipient || row.summary) : sent(20);
    if (actor && actor.role === 'client') view.sent = sent(20).filter((row) => row.kind !== 'backup.failed');
    view.inbox = actor ? inbox(actor) : { unread: [] };
    return view;
  }

  function testSend(actor) {
    if (!enabled()) throw new Error('Alerts are switched off for this warehouse');
    const event = { type: 'alert.test', clientId: actor && actor.role === 'client' ? actor.clientId : null, summary: describe(language(), { type: 'alert.test' }) };
    holdOrSend(event);
    return { ok: true, summary: event.summary };
  }

  function raise(event = {}) {
    if (!enabled()) return { sent: false };
    const type = String(event.type || '');
    if (!KINDS.includes(type) && type !== 'backup.failed') throw new Error('Unknown alert');
    const summary = describe(language(), { type, summary: event.summary, itemNo: event.itemNo, name: event.name, available: event.available, reorderPoint: event.reorderPoint, face: event.face, reminder: event.reminder });
    dispatch({ ...event, type, summary, clientId: event.clientId || null });
    return { sent: true };
  }

  function onCommand(op) {
    if (busy || op === 'recordAlert' || op === 'enableDemandReplenishment') return;
    busy = true;
    try { evaluate(); } catch (e) { log(`Alerts: ${redact(e.message)}`); } finally { busy = false; }
  }

  function start({ every = 60000 } = {}) {
    const timer = setInterval(() => {
      if (!enabled()) return;
      try { evaluate(); } catch (e) { log(`Alerts: ${redact(e.message)}`); }
    }, every);
    if (timer.unref) timer.unref();
    return () => clearInterval(timer);
  }

  return { status, save, subscribe, evaluate, raise, onCommand, start, inbox, markRead, testSend, readConfig, advance };
}

function raiseExternal(store, event) {
  return createAlerts({ store, log() {} }).raise(event);
}

module.exports = { createAlerts, advance, inQuiet, describe, sentence, KINDS, raiseExternal };
