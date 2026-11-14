/*
 * Encrypted off-site backups. The daily local copy stays a plain file until
 * an encrypted target has a verified run and an administrator chooses
 * otherwise. This module can then keep that local copy encrypted, or stop
 * it. Old plain files are removed only when someone confirms.
 *
 * The passphrase and target credentials live beside the database, not in it,
 * so they are not in the export and not in the encrypted file. Password
 * hashes are in the file: it is a copy of the database, same as the local backup.
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const { createHash } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const crypto = require('./backup-crypto');
const { signRequest, sha256 } = require('./sigv4');
const { backup, inspect } = require('./backups');

const DAY = 86400000;
const FILE_RE = /^sorted-(\d{4}-\d{2}-\d{2}-\d{6})(?:-(\d+))?\.db\.enc$/;
const RETRY_MS = 15 * 60 * 1000;

function sha256buf(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

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

function addDays(day, n) {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
}

/** UTC instant of a warehouse-local civil time. */
function zonedAt(day, hh, mm, ss, timeZone) {
  const want = Date.parse(`${day}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}Z`);
  let ms = want;
  for (let i = 0; i < 6; i++) {
    const p = localParts(ms, timeZone);
    const seen = Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`);
    if (seen === want) return ms;
    ms += want - seen;
  }
  return ms;
}

function localStamp(ms, timeZone) {
  const p = localParts(ms, timeZone);
  return `${p.year}-${p.month}-${p.day}-${p.hour}${p.minute}${p.second}`;
}

function stampToMs(stamp, timeZone) {
  const m = /^(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(stamp);
  if (!m) return null;
  return zonedAt(`${m[1]}-${m[2]}-${m[3]}`, Number(m[4]), Number(m[5]), Number(m[6]), timeZone);
}

function weekKey(day) {
  const tmp = new Date(`${day}T00:00:00Z`);
  const dow = tmp.getUTCDay() || 7;
  tmp.setUTCDate(tmp.getUTCDate() + 4 - dow);
  const yearStart = Date.UTC(tmp.getUTCFullYear(), 0, 1);
  const week = Math.ceil((((tmp.getTime() - yearStart) / DAY) + 1) / 7);
  return `${tmp.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function clockTime(value, label) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
  if (!m) throw new Error(`${label} is a time like 02:30`);
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh > 23 || mm > 59) throw new Error(`${label} is a time like 02:30`);
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function whole(value, label, min, max) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${label} must be a whole number from ${min} to ${max}`);
  return n;
}

/**
 * Files to keep: the newest in each of the last N local days, ISO weeks and
 * calendar months. A file that fills any of those stays.
 */
function selectRetention(files, { daily = 7, weekly = 4, monthly = 6, timeZone = 'UTC' } = {}) {
  const sorted = [...files].filter((f) => Number.isFinite(f.at)).sort((a, b) => b.at - a.at || String(b.name).localeCompare(String(a.name)));
  const keep = new Set();
  const take = (limit, keyOf) => {
    const seen = new Set();
    let n = 0;
    for (const file of sorted) {
      const key = keyOf(file);
      if (seen.has(key)) continue;
      seen.add(key);
      if (n >= limit) continue;
      keep.add(file.name);
      n++;
    }
  };
  take(Math.max(0, daily), (file) => localDay(file.at, timeZone));
  take(Math.max(0, weekly), (file) => weekKey(localDay(file.at, timeZone)));
  take(Math.max(0, monthly), (file) => localDay(file.at, timeZone).slice(0, 7));
  return { keep: sorted.filter((file) => keep.has(file.name)), drop: sorted.filter((file) => !keep.has(file.name)) };
}

function isDue({ mode = 'daily', dailyTime = '02:00', intervalHours = 24, timeZone = 'UTC', now, lastSuccess = null } = {}) {
  if (mode === 'interval') {
    const hours = Math.max(1, Number(intervalHours) || 24);
    if (!lastSuccess) return true;
    return now >= lastSuccess + hours * 3600000;
  }
  const [hh, mm] = clockTime(dailyTime, 'Daily time').split(':').map(Number);
  const slot = zonedAt(localDay(now, timeZone), hh, mm, 0, timeZone);
  if (now < slot) return false;
  return !lastSuccess || lastSuccess < slot;
}

function nextRunAt({ mode = 'daily', dailyTime = '02:00', intervalHours = 24, timeZone = 'UTC', now, lastSuccess = null } = {}) {
  if (mode === 'interval') {
    const hours = Math.max(1, Number(intervalHours) || 24);
    if (!lastSuccess) return now;
    const next = lastSuccess + hours * 3600000;
    return next > now ? next : now;
  }
  const [hh, mm] = clockTime(dailyTime, 'Daily time').split(':').map(Number);
  const today = zonedAt(localDay(now, timeZone), hh, mm, 0, timeZone);
  if (now < today) return today;
  if (!lastSuccess || lastSuccess < today) return now;
  return zonedAt(addDays(localDay(now, timeZone), 1), hh, mm, 0, timeZone);
}

function defaultConfig() {
  return {
    mode: 'daily',
    dailyTime: '02:00',
    intervalHours: 24,
    retainDaily: 7,
    retainWeekly: 4,
    retainMonthly: 6,
    testDecrypt: false,
    localCopy: 'plain',
    targets: [],
  };
}

const LOCAL_ENC = /^sorted-\d{4}-\d{2}-\d{2}-\d{6}(?:-\d+)?\.db\.enc$/;

function listLocalEncrypted(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => LOCAL_ENC.test(name)).map((name) => {
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    return { file: name, path: full, bytes: st.size, at: st.mtimeMs, encrypted: true };
  }).sort((a, b) => b.file.localeCompare(a.file));
}

function requestHttp({ method, url, headers, body, timeoutMs = 60000 }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({
      method,
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: `${u.pathname}${u.search}`,
      headers,
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('The off-site target did not answer in time')); });
    req.on('error', (err) => reject(new Error(err.message || 'The off-site target refused the connection')));
    if (body) req.write(body);
    req.end();
  });
}

function redact(text, secrets) {
  let out = String(text || '');
  const list = [...secrets].filter((s) => typeof s === 'string' && s.length >= 4).sort((a, b) => b.length - a.length);
  for (const secret of list) out = out.split(secret).join('***');
  return out;
}

function createOffsite({ store, secretsFile = undefined, env = process.env, transport = null, log = () => {}, now = null } = {}) {
  if (!store || !store.db) throw new Error('Off-site backups need the warehouse database');
  const clock = typeof now === 'function' ? now : () => Date.now();
  const send = transport || requestHttp;
  const secretsPath = secretsFile === undefined
    ? (store.file && store.file !== ':memory:' ? path.join(path.dirname(store.file), 'offsite-secrets.json') : null)
    : secretsFile;
  let memorySecrets = { passphrase: null, targets: {} };
  let running = false;

  function ensure() {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS offsite_config (site TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS offsite_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        site TEXT NOT NULL,
        t INTEGER NOT NULL,
        ok INTEGER NOT NULL,
        summary TEXT NOT NULL
      );
    `);
  }
  ensure();

  function siteId() {
    return String(store.siteId || 'MAIN').toUpperCase();
  }

  function timeZone() {
    const wh = warehouse();
    return (wh && wh.config && wh.config.timeZone) || 'Europe/Brussels';
  }

  function warehouse() {
    try { return store.warehouse ? store.warehouse(siteId()) : store.wh; } catch (e) { return store.wh; }
  }

  function loadSecrets() {
    if (!secretsPath) return { passphrase: memorySecrets.passphrase || null, targets: { ...(memorySecrets.targets || {}) } };
    if (!fs.existsSync(secretsPath)) return { passphrase: null, targets: {} };
    try {
      const data = JSON.parse(fs.readFileSync(secretsPath, 'utf8'));
      return { passphrase: data.passphrase || null, targets: data.targets || {} };
    } catch (e) {
      throw new Error('The off-site secrets file could not be read');
    }
  }

  function writeSecrets(data) {
    const clean = { passphrase: data.passphrase || null, targets: data.targets || {} };
    if (!secretsPath) { memorySecrets = clean; return; }
    fs.mkdirSync(path.dirname(secretsPath), { recursive: true });
    const tmp = `${secretsPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(clean), { mode: 0o600 });
    fs.renameSync(tmp, secretsPath);
    try { fs.chmodSync(secretsPath, 0o600); } catch (e) { /* a platform that ignores the mode */ }
  }

  function secretValues() {
    const secrets = loadSecrets();
    const values = [];
    if (secrets.passphrase) values.push(secrets.passphrase);
    if (env.SORTED_BACKUP_PASSPHRASE) values.push(String(env.SORTED_BACKUP_PASSPHRASE));
    for (const row of Object.values(secrets.targets || {})) {
      for (const value of Object.values(row || {})) if (typeof value === 'string') values.push(value);
    }
    return values;
  }

  function passphrase() {
    const fromEnv = env.SORTED_BACKUP_PASSPHRASE ? String(env.SORTED_BACKUP_PASSPHRASE) : '';
    if (fromEnv) return { value: fromEnv, source: 'env' };
    const saved = loadSecrets().passphrase;
    if (saved) return { value: saved, source: 'settings' };
    return { value: null, source: null };
  }

  function readConfig() {
    const row = store.db.prepare('SELECT json FROM offsite_config WHERE site = ?').get(siteId());
    const cfg = { ...defaultConfig(), ...(row ? JSON.parse(row.json) : {}) };
    cfg.targets = Array.isArray(cfg.targets) ? cfg.targets : [];
    return cfg;
  }

  function writeConfig(cfg) {
    store.db.prepare('INSERT INTO offsite_config (site, json) VALUES (?, ?) ON CONFLICT(site) DO UPDATE SET json = excluded.json').run(siteId(), JSON.stringify(cfg));
  }

  function record(ok, summary, actor = 'system') {
    const safe = redact(summary, secretValues()).slice(0, 500);
    store.db.prepare('INSERT INTO offsite_runs (site, t, ok, summary) VALUES (?, ?, ?, ?)').run(siteId(), clock(), ok ? 1 : 0, safe);
    const audit = store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'auth_audit'").get();
    if (audit) store.db.prepare('INSERT INTO auth_audit (t, action, by, detail) VALUES (?, ?, ?, ?)').run(clock(), ok ? 'offsite-backup' : 'offsite-backup-failed', String(actor || 'system').slice(0, 40), JSON.stringify({ summary: safe }));
    log(ok ? `Off-site backup: ${safe}` : `Off-site backup failed: ${safe}`);
    if (!ok) notify(safe);
    return safe;
  }

  function notify(summary) {
    let mod = null;
    try { mod = require('../modules/registry').get('alerts'); } catch (e) { return; }
    if (!mod || typeof mod.raise !== 'function') return;
    const wh = warehouse();
    if (wh && typeof wh.module === 'function' && !wh.module('alerts')) return;
    try {
      mod.raise(store, { type: 'backup.failed', summary, site: siteId(), at: clock() });
    } catch (e) {
      log('Off-site backup: the alert was not sent');
    }
  }

  function lastRun(ok = null) {
    const sql = ok == null
      ? 'SELECT t, ok, summary FROM offsite_runs WHERE site = ? ORDER BY id DESC LIMIT 1'
      : 'SELECT t, ok, summary FROM offsite_runs WHERE site = ? AND ok = ? ORDER BY id DESC LIMIT 1';
    const row = ok == null
      ? store.db.prepare(sql).get(siteId())
      : store.db.prepare(sql).get(siteId(), ok ? 1 : 0);
    return row ? { at: row.t, ok: Boolean(row.ok), summary: row.summary } : null;
  }

  function runs(limit = 20) {
    return store.db.prepare('SELECT t, ok, summary FROM offsite_runs WHERE site = ? ORDER BY id DESC LIMIT ?').all(siteId(), Math.min(100, limit)).map((row) => ({ at: row.t, ok: Boolean(row.ok), summary: row.summary }));
  }

  function scheduleOf(cfg = readConfig()) {
    const last = lastRun(true);
    const attempt = lastRun();
    const base = { mode: cfg.mode, dailyTime: cfg.dailyTime, intervalHours: cfg.intervalHours, timeZone: timeZone(), now: clock(), lastSuccess: last ? last.at : null };
    let due = isDue(base);
    if (due && attempt && !attempt.ok && clock() - attempt.at < RETRY_MS) due = false;
    return { ...base, due, nextRun: nextRunAt(base), lastSuccess: last, lastAttempt: attempt };
  }

  function publicTarget(target, secrets) {
    const creds = (secrets.targets || {})[target.id] || {};
    const row = { id: target.id, kind: target.kind, credentialsSet: false };
    if (target.kind === 'folder') row.path = target.path;
    if (target.kind === 's3') {
      row.endpoint = target.endpoint;
      row.bucket = target.bucket;
      row.region = target.region;
      row.prefix = target.prefix || '';
      row.pathStyle = Boolean(target.pathStyle);
      row.credentialsSet = Boolean(creds.accessKeyId && creds.secretAccessKey);
    }
    if (target.kind === 'webdav') {
      row.url = target.url;
      row.credentialsSet = Boolean(creds.username && creds.password);
    }
    return row;
  }

  async function status() {
    const cfg = readConfig();
    const secrets = loadSecrets();
    const pass = passphrase();
    const sched = scheduleOf(cfg);
    const targets = [];
    for (const target of cfg.targets) {
      const row = publicTarget(target, secrets);
      try { row.files = await listTarget(target, secrets); }
      catch (e) { row.files = []; row.error = redact(e.message, secretValues()); }
      targets.push(row);
    }
    return {
      configured: Boolean(pass.value && cfg.targets.length),
      passphraseSet: Boolean(pass.value),
      passphraseFromEnv: pass.source === 'env',
      timeZone: timeZone(),
      mode: cfg.mode,
      dailyTime: cfg.dailyTime,
      intervalHours: cfg.intervalHours,
      retainDaily: cfg.retainDaily,
      retainWeekly: cfg.retainWeekly,
      retainMonthly: cfg.retainMonthly,
      testDecrypt: Boolean(cfg.testDecrypt),
      localCopy: cfg.localCopy || 'plain',
      effectiveLocalCopy: localMode(),
      offerPlainOff: (cfg.localCopy || 'plain') === 'plain' && plainOptional(cfg),
      plainCopies: plainFiles().length,
      last: sched.lastAttempt,
      lastSuccess: sched.lastSuccess,
      nextRun: sched.nextRun,
      due: sched.due,
      targets,
      runs: runs(),
    };
  }

  function save(patch = {}) {
    const cfg = readConfig();
    const secrets = loadSecrets();
    if (patch.mode != null) {
      if (!['daily', 'interval'].includes(patch.mode)) throw new Error('Schedule is daily or every few hours');
      cfg.mode = patch.mode;
    }
    if (patch.dailyTime != null) cfg.dailyTime = clockTime(patch.dailyTime, 'Daily time');
    if (patch.intervalHours != null) cfg.intervalHours = whole(patch.intervalHours, 'Hours between backups', 1, 168);
    if (patch.retainDaily != null) cfg.retainDaily = whole(patch.retainDaily, 'Daily backups to keep', 0, 100);
    if (patch.retainWeekly != null) cfg.retainWeekly = whole(patch.retainWeekly, 'Weekly backups to keep', 0, 100);
    if (patch.retainMonthly != null) cfg.retainMonthly = whole(patch.retainMonthly, 'Monthly backups to keep', 0, 100);
    if (patch.testDecrypt != null) cfg.testDecrypt = Boolean(patch.testDecrypt);
    if (patch.localCopy != null) {
      if (!['plain', 'encrypted', 'off'].includes(patch.localCopy)) throw new Error('The local copy is plain, encrypted, or off');
      if (patch.localCopy !== 'plain' && !plainOptional(cfg)) throw new Error('Keep the plain daily copy until an encrypted target has one verified backup');
      cfg.localCopy = patch.localCopy;
    }
    if (patch.clearPassphrase) secrets.passphrase = null;
    if (typeof patch.passphrase === 'string' && patch.passphrase) {
      if (patch.passphrase.length < 8 || patch.passphrase.length > 1024) throw new Error('The passphrase needs 8 to 1024 characters');
      secrets.passphrase = patch.passphrase;
    }
    if (patch.removeTarget) {
      cfg.targets = cfg.targets.filter((t) => t.id !== patch.removeTarget);
      delete secrets.targets[patch.removeTarget];
    }
    if (patch.target) cfg.targets = upsertTarget(cfg.targets, secrets, patch.target);
    if (cfg.targets.length > 8) throw new Error('At most 8 off-site targets');
    writeConfig(cfg);
    writeSecrets(secrets);
    return { ok: true };
  }

  function upsertTarget(targets, secrets, raw) {
    const kind = raw.kind;
    if (!['folder', 's3', 'webdav'].includes(kind)) throw new Error('A target is a folder, S3 or WebDAV');
    const id = String(raw.id || '').trim() || `${kind}-${Math.random().toString(36).slice(2, 8)}`;
    if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(id)) throw new Error('A target id uses lowercase letters, digits and hyphens');
    const next = { id, kind };
    if (kind === 'folder') {
      const folder = String(raw.path || '').trim();
      if (!folder) throw new Error('Name the folder the backups go to');
      next.path = folder;
    } else if (kind === 's3') {
      let endpoint;
      try { endpoint = new URL(String(raw.endpoint || '').trim()); } catch (e) { throw new Error('The S3 endpoint is a URL, like https://s3.amazonaws.com'); }
      if (!['https:', 'http:'].includes(endpoint.protocol)) throw new Error('The S3 endpoint starts with https:// or http://');
      endpoint.username = '';
      endpoint.password = '';
      next.endpoint = endpoint.origin;
      next.bucket = String(raw.bucket || '').trim();
      if (!/^[a-z0-9][a-z0-9.-]{1,62}$/.test(next.bucket)) throw new Error('The bucket name is not valid');
      next.region = String(raw.region || 'us-east-1').trim();
      if (!/^[a-z0-9-]{1,32}$/.test(next.region)) throw new Error('The region is not valid');
      next.prefix = String(raw.prefix || '').replace(/^\/+|\/+$/g, '');
      next.pathStyle = Boolean(raw.pathStyle);
      const prev = secrets.targets[id] || {};
      const accessKeyId = String(raw.accessKeyId || '').trim() || prev.accessKeyId;
      const secretAccessKey = String(raw.secretAccessKey || '') || prev.secretAccessKey;
      if (!accessKeyId || !secretAccessKey) throw new Error('S3 needs an access key and a secret key');
      secrets.targets[id] = { accessKeyId, secretAccessKey };
    } else {
      let url;
      try { url = new URL(String(raw.url || '').trim()); } catch (e) { throw new Error('The WebDAV address is a URL'); }
      if (url.protocol !== 'https:') throw new Error('WebDAV backups use HTTPS');
      url.username = '';
      url.password = '';
      if (!url.pathname.endsWith('/')) url.pathname += '/';
      next.url = url.toString();
      const prev = secrets.targets[id] || {};
      const username = String(raw.username || '').trim() || prev.username;
      const password = String(raw.password || '') || prev.password;
      if (!username || !password) throw new Error('WebDAV needs a user and a password');
      secrets.targets[id] = { username, password };
    }
    const rest = targets.filter((t) => t.id !== id);
    rest.push(next);
    return rest;
  }

  function enabled() {
    const wh = warehouse();
    return !wh || typeof wh.module !== 'function' || wh.module('backup-offsite');
  }

  async function run(by = 'system') {
    if (!enabled()) throw new Error('Off-site backups are switched off for this warehouse');
    if (running) throw new Error('An off-site backup is already running');
    running = true;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sorted-offsite-'));
    let noted = false;
    const note = (ok, summary) => { record(ok, summary, by); noted = true; };
    try {
      const pass = passphrase();
      if (!pass.value) throw new Error('Set a backup passphrase before an off-site backup');
      const cfg = readConfig();
      if (!cfg.targets.length) throw new Error('Add an off-site target first');
      const copy = backup(store.db, dir, { keep: 5, now: clock() });
      const plain = fs.readFileSync(copy.path);
      const enc = crypto.encrypt(plain, pass.value);
      const name = uniqueName(localStamp(clock(), timeZone()));
      const digest = sha256buf(enc);
      const sent = [];
      const errors = [];
      for (const target of cfg.targets) {
        try {
          await upload(target, name, enc, { digest, testDecrypt: cfg.testDecrypt, passphrase: pass.value });
          await prune(target, cfg);
          sent.push(target.id);
        } catch (e) {
          errors.push(`${labelOf(target)}: ${redact(e.message, secretValues())}`);
        }
      }
      if (errors.length) {
        const summary = errors.join('; ') + (sent.length ? `; sent to ${sent.join(', ')}` : '');
        note(false, summary);
        throw new Error(summary);
      }
      const summary = `${name} verified on ${sent.join(', ')} (${Math.max(1, Math.round(enc.length / 1024))} KB)`;
      note(true, summary);
      return { file: name, bytes: enc.length, sha256: digest, targets: sent, summary };
    } catch (e) {
      if (!noted) note(false, e.message);
      throw new Error(redact(e.message, secretValues()));
    } finally {
      running = false;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  function labelOf(target) {
    if (target.kind === 'folder') return `folder ${target.id}`;
    if (target.kind === 's3') return `s3 ${target.id}`;
    return `webdav ${target.id}`;
  }

  function uniqueName(stamp) {
    return `sorted-${stamp}.db.enc`;
  }

  async function upload(target, name, bytes, { digest, testDecrypt, passphrase: pass }) {
    const got = await putAndRead(target, name, bytes);
    if (got.length !== bytes.length) throw new Error(`Size mismatch after upload (${got.length} of ${bytes.length})`);
    if (sha256buf(got) !== digest) throw new Error('Hash mismatch after upload');
    if (testDecrypt) {
      const plain = crypto.decrypt(got, pass);
      if (!plain.subarray(0, 15).equals(Buffer.from('SQLite format 3'))) throw new Error('Test decrypt did not produce a database');
    }
  }

  async function putAndRead(target, name, bytes) {
    if (target.kind === 'folder') return folderPut(target, name, bytes);
    if (target.kind === 's3') return s3Put(target, name, bytes);
    if (target.kind === 'webdav') return davPut(target, name, bytes);
    throw new Error('Unknown off-site target');
  }

  function folderFile(target, name) {
    if (!FILE_RE.test(name)) throw new Error('Backup name is not valid');
    const dir = path.resolve(target.path);
    const dest = path.resolve(dir, name);
    if (dest !== path.join(dir, name)) throw new Error('Backup name is not valid');
    return dest;
  }

  function folderPut(target, name, bytes) {
    const dest = folderFile(target, name);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.partial`;
    fs.writeFileSync(tmp, bytes, { mode: 0o600 });
    fs.renameSync(tmp, dest);
    return fs.readFileSync(dest);
  }

  function creds(target) {
    return (loadSecrets().targets || {})[target.id] || {};
  }

  function objectUrl(target, key) {
    const endpoint = new URL(target.endpoint);
    const encoded = key.split('/').map((seg) => encodeURIComponent(seg)).join('/');
    if (target.pathStyle) {
      endpoint.pathname = `/${target.bucket}/${encoded}`;
      return endpoint;
    }
    endpoint.hostname = `${target.bucket}.${endpoint.hostname}`;
    endpoint.pathname = `/${encoded}`;
    return endpoint;
  }

  async function s3Call(target, { method, key, query = null, body = null, contentType = null }) {
    const keys = creds(target);
    if (!keys.accessKeyId || !keys.secretAccessKey) throw new Error('S3 credentials are not set');
    const url = key ? objectUrl(target, key) : new URL(target.endpoint);
    if (!key) {
      url.pathname = target.pathStyle ? `/${target.bucket}` : '/';
      if (!target.pathStyle) url.hostname = `${target.bucket}.${new URL(target.endpoint).hostname}`;
    }
    if (query) for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
    const headers = {};
    if (contentType) headers['content-type'] = contentType;
    const signed = signRequest({
      method, url: url.toString(), headers, body: body || Buffer.alloc(0),
      accessKeyId: keys.accessKeyId, secretAccessKey: keys.secretAccessKey, region: target.region, now: new Date(clock()),
    });
    if (body) signed.headers['content-length'] = String(body.length);
    const res = await send({ method, url: url.toString(), headers: signed.headers, body });
    if (res.status < 200 || res.status >= 300) throw new Error(`S3 answered HTTP ${res.status}`);
    return res;
  }

  async function s3Put(target, name, bytes) {
    const key = [target.prefix, name].filter(Boolean).join('/');
    await s3Call(target, { method: 'PUT', key, body: bytes, contentType: 'application/octet-stream' });
    const got = await s3Call(target, { method: 'GET', key });
    return got.body;
  }

  async function davPut(target, name, bytes) {
    const keys = creds(target);
    if (!keys.username || !keys.password) throw new Error('WebDAV credentials are not set');
    const url = new URL(target.url);
    if (url.protocol !== 'https:') throw new Error('WebDAV backups use HTTPS');
    url.pathname = `${url.pathname.replace(/\/$/, '')}/${encodeURIComponent(name)}`;
    const auth = `Basic ${Buffer.from(`${keys.username}:${keys.password}`).toString('base64')}`;
    const headers = { authorization: auth, 'content-type': 'application/octet-stream', 'content-length': String(bytes.length) };
    const put = await send({ method: 'PUT', url: url.toString(), headers, body: bytes });
    if (put.status < 200 || put.status >= 300) throw new Error(`WebDAV answered HTTP ${put.status}`);
    const got = await send({ method: 'GET', url: url.toString(), headers: { authorization: auth } });
    if (got.status < 200 || got.status >= 300) throw new Error(`WebDAV answered HTTP ${got.status}`);
    return got.body;
  }

  function fileTime(name) {
    const m = FILE_RE.exec(name);
    if (!m) return null;
    return stampToMs(m[1], timeZone());
  }

  async function listTarget(target, secrets = loadSecrets()) {
    if (target.kind === 'folder') {
      if (!fs.existsSync(target.path)) return [];
      return fs.readdirSync(target.path).filter((name) => FILE_RE.test(name)).map((name) => {
        const st = fs.statSync(path.join(target.path, name));
        return { name, bytes: st.size, at: fileTime(name) || st.mtimeMs };
      }).sort((a, b) => b.at - a.at);
    }
    if (target.kind === 's3') {
      const listed = await s3Call(target, { method: 'GET', query: { 'list-type': '2', prefix: target.prefix ? `${target.prefix}/` : '' } });
      return parseS3List(listed.body.toString('utf8')).map((row) => ({ name: row.name, bytes: row.bytes, at: fileTime(row.name) || Date.parse(row.modified) || 0 })).filter((row) => FILE_RE.test(row.name)).sort((a, b) => b.at - a.at);
    }
    const keys = (secrets.targets || {})[target.id] || {};
    const url = new URL(target.url);
    if (url.protocol !== 'https:') throw new Error('WebDAV backups use HTTPS');
    const auth = `Basic ${Buffer.from(`${keys.username || ''}:${keys.password || ''}`).toString('base64')}`;
    const body = '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/><d:getcontentlength/></d:prop></d:propfind>';
    const res = await send({ method: 'PROPFIND', url: url.toString(), headers: { authorization: auth, depth: '1', 'content-type': 'application/xml', 'content-length': String(Buffer.byteLength(body)) }, body: Buffer.from(body) });
    if (res.status < 200 || res.status >= 300) throw new Error(`WebDAV answered HTTP ${res.status}`);
    return parseDavList(res.body.toString('utf8')).filter((row) => FILE_RE.test(row.name)).map((row) => ({ ...row, at: fileTime(row.name) || 0 })).sort((a, b) => b.at - a.at);
  }

  async function prune(target, cfg) {
    const files = await listTarget(target);
    const { drop } = selectRetention(files, { daily: cfg.retainDaily, weekly: cfg.retainWeekly, monthly: cfg.retainMonthly, timeZone: timeZone() });
    for (const file of drop) await removeFile(target, file.name);
  }

  async function removeFile(target, name) {
    if (!FILE_RE.test(name)) throw new Error('Backup name is not valid');
    if (target.kind === 'folder') {
      fs.rmSync(folderFile(target, name), { force: true });
      return;
    }
    if (target.kind === 's3') {
      await s3Call(target, { method: 'DELETE', key: [target.prefix, name].filter(Boolean).join('/') });
      return;
    }
    const keys = creds(target);
    const url = new URL(target.url);
    url.pathname = `${url.pathname.replace(/\/$/, '')}/${encodeURIComponent(name)}`;
    const res = await send({ method: 'DELETE', url: url.toString(), headers: { authorization: `Basic ${Buffer.from(`${keys.username}:${keys.password}`).toString('base64')}` } });
    if (res.status >= 300 && res.status !== 404) throw new Error(`WebDAV answered HTTP ${res.status}`);
  }

  async function fetchFile(target, name) {
    if (!FILE_RE.test(name)) throw new Error('Backup name is not valid');
    if (target.kind === 'folder') return fs.readFileSync(folderFile(target, name));
    if (target.kind === 's3') {
      const got = await s3Call(target, { method: 'GET', key: [target.prefix, name].filter(Boolean).join('/') });
      return got.body;
    }
    const keys = creds(target);
    const url = new URL(target.url);
    if (url.protocol !== 'https:') throw new Error('WebDAV backups use HTTPS');
    url.pathname = `${url.pathname.replace(/\/$/, '')}/${encodeURIComponent(name)}`;
    const got = await send({ method: 'GET', url: url.toString(), headers: { authorization: `Basic ${Buffer.from(`${keys.username}:${keys.password}`).toString('base64')}` } });
    if (got.status < 200 || got.status >= 300) throw new Error(`WebDAV answered HTTP ${got.status}`);
    return got.body;
  }

  async function restore({ targetId, name, file, passphrase: given } = {}) {
    if (!enabled()) throw new Error('Off-site backups are switched off for this warehouse');
    let bytes;
    if (file) bytes = fs.readFileSync(file);
    else {
      const cfg = readConfig();
      const target = cfg.targets.find((t) => t.id === targetId);
      if (!target) throw new Error('Unknown off-site target');
      bytes = await fetchFile(target, name);
    }
    const pass = given || passphrase().value;
    if (!pass) throw new Error('Set SORTED_BACKUP_PASSPHRASE or save a passphrase before restoring');
    const plain = crypto.decrypt(bytes, pass);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sorted-restore-'));
    const plainPath = path.join(dir, 'restore.db');
    try {
      fs.writeFileSync(plainPath, plain, { mode: 0o600 });
      const found = inspect(plainPath);
      if (store.file && store.file !== ':memory:' && store.backupDir) backup(store.db, store.backupDir, { keep: 14, now: clock() });
      copyDatabase(store, plainPath);
      const report = store._upgrade();
      store.load();
      const summary = `Restored ${name || path.basename(file)} (${found.changes} changes, ${found.users} users)`;
      record(true, summary);
      return { ...found, summary, schema: report.to, upgrades: report.applied, lines: report.lines };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  function start({ every = 60000 } = {}) {
    const timer = setInterval(() => {
      if (!enabled()) return;
      let due = false;
      try { due = scheduleOf().due && passphrase().value && readConfig().targets.length; } catch (e) { return; }
      if (!due || running) return;
      run('schedule').catch(() => {});
    }, every);
    if (timer.unref) timer.unref();
    return () => clearInterval(timer);
  }

  function hasVerifiedSuccess() {
    const row = store.db.prepare("SELECT id FROM offsite_runs WHERE site = ? AND ok = 1 AND summary LIKE '%verified on%' LIMIT 1").get(siteId());
    return Boolean(row);
  }

  /** Plain stays on until a target exists and one encrypted upload has been verified. */
  function plainOptional(cfg = readConfig()) {
    return Array.isArray(cfg.targets) && cfg.targets.length > 0 && hasVerifiedSuccess();
  }

  function localDir() {
    if (store.backupDir) return store.backupDir;
    if (store.file && store.file !== ':memory:') return path.join(path.dirname(store.file), 'backups');
    return null;
  }

  function plainFiles(dir = localDir()) {
    if (!dir) return [];
    return require('./backups').listBackups(dir);
  }

  function localMode() {
    const cfg = readConfig();
    const chosen = cfg.localCopy || 'plain';
    if (chosen === 'plain') return 'plain';
    if (!plainOptional(cfg)) return 'plain';
    return chosen;
  }

  function listLocal(dir = localDir()) {
    if (!dir) return [];
    const plain = plainFiles(dir).map((file) => ({ ...file, encrypted: false }));
    return [...plain, ...listLocalEncrypted(dir)].sort((a, b) => String(b.file).localeCompare(String(a.file)));
  }

  /** A local copy encrypted with the same passphrase. Plain .db files are left where they are. */
  function writeLocalEncrypted({ dir, keep = 14, log = () => {}, force = false } = {}) {
    const folder = dir || localDir();
    if (!folder) throw new Error('There is no local backup folder');
    const newest = listLocalEncrypted(folder)[0];
    if (!force && newest && Date.now() - newest.at < 86400000) return null;
    const pass = passphrase();
    if (!pass.value) throw new Error('Set a backup passphrase before an encrypted local copy');
    fs.mkdirSync(folder, { recursive: true });
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sorted-local-'));
    try {
      const copy = require('./backups').backup(store.db, scratch, { keep: 2, now: clock() });
      const enc = crypto.encrypt(fs.readFileSync(copy.path), pass.value);
      const { stamp } = require('./backups');
      let name = `sorted-${stamp(clock())}.db.enc`;
      let dest = path.join(folder, name);
      for (let n = 2; fs.existsSync(dest); n++) {
        name = `sorted-${stamp(clock())}-${n}.db.enc`;
        dest = path.join(folder, name);
      }
      const tmp = `${dest}.partial`;
      fs.writeFileSync(tmp, enc, { mode: 0o600 });
      fs.renameSync(tmp, dest);
      const back = fs.readFileSync(dest);
      if (back.length !== enc.length || sha256buf(back) !== sha256buf(enc)) throw new Error('Local encrypted copy did not match');
      const plain = crypto.decrypt(back, pass.value);
      if (!plain.subarray(0, 15).equals(Buffer.from('SQLite format 3'))) throw new Error('Local encrypted copy did not decrypt');
      const extra = listLocalEncrypted(folder).slice(Math.max(1, keep));
      for (const old of extra) fs.rmSync(old.path, { force: true });
      const made = { file: name, path: dest, bytes: enc.length, encrypted: true };
      log(`Encrypted local backup ${name} (${Math.max(1, Math.round(enc.length / 1024))} KB) in ${folder}`);
      return made;
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }

  /**
   * Delete plain sorted-*.db files in the local folder. Never called from the
   * schedule. `confirm` must be exactly true.
   */
  function prunePlain({ confirm = false, dir = null } = {}) {
    if (confirm !== true) throw new Error('Confirm before removing the plain copies. They are not removed on their own.');
    const folder = dir || localDir();
    const files = plainFiles(folder);
    for (const file of files) fs.rmSync(file.path, { force: true });
    return { removed: files.length };
  }

  return { status, save, run, restore, start, enabled, scheduleOf, readConfig, secretsPath, localMode, writeLocalEncrypted, prunePlain, listLocal };
}

function parseS3List(xml) {
  const out = [];
  for (const block of xml.match(/<Contents>[\s\S]*?<\/Contents>/g) || []) {
    const key = (block.match(/<Key>([^<]*)<\/Key>/) || [])[1];
    if (!key) continue;
    const base = key.split('/').pop();
    out.push({ name: decodeXml(base), bytes: Number((block.match(/<Size>([^<]*)<\/Size>/) || [])[1] || 0), modified: (block.match(/<LastModified>([^<]*)<\/LastModified>/) || [])[1] || '' });
  }
  return out;
}

function parseDavList(xml) {
  const out = [];
  for (const block of xml.match(/<(?:\w+:)?response>[\s\S]*?<\/(?:\w+:)?response>/g) || []) {
    const href = (block.match(/<(?:\w+:)?href>([^<]*)<\/(?:\w+:)?href>/) || [])[1] || '';
    const name = decodeURIComponent(href.split('/').filter(Boolean).pop() || '');
    const size = Number((block.match(/<(?:\w+:)?getcontentlength>([^<]*)<\/(?:\w+:)?getcontentlength>/i) || [])[1] || 0);
    if (FILE_RE.test(name)) out.push({ name, bytes: size });
  }
  return out;
}

function decodeXml(value) {
  return String(value).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
}

function copyDatabase(store, file) {
  const src = new DatabaseSync(file, { readOnly: true });
  const names = ['meta', 'journal', 'snapshots', 'extra_sites', 'extra_journal', 'sessions', 'role_permissions', 'users', 'upgrade_log', 'module_settings', 'auth_audit', 'webhooks', 'offsite_config', 'offsite_runs'];
  const db = store.db;
  db.exec('BEGIN');
  try {
    for (const name of names) {
      const dest = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
      const from = src.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
      if (!dest) continue;
      db.exec(`DELETE FROM ${name}`);
      if (!from) continue;
      const rows = src.prepare(`SELECT * FROM ${name}`).all();
      if (!rows.length) continue;
      const have = new Set(db.prepare(`PRAGMA table_info(${name})`).all().map((col) => col.name));
      const cols = Object.keys(rows[0]).filter((col) => have.has(col));
      const stmt = db.prepare(`INSERT INTO ${name} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`);
      for (const row of rows) stmt.run(...cols.map((col) => row[col]));
    }
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (ignore) { /* already closed */ }
    throw e;
  } finally {
    src.close();
  }
}

/** Decrypt to a temporary database file. The caller deletes `dir`. */
function decryptToFile(file, passphrase) {
  const bytes = fs.readFileSync(file);
  if (!crypto.isEncrypted(bytes)) return { file, dir: null, encrypted: false };
  const plain = crypto.decrypt(bytes, passphrase);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sorted-restore-'));
  const dest = path.join(dir, 'restore.db');
  fs.writeFileSync(dest, plain, { mode: 0o600 });
  return { file: dest, dir, encrypted: true };
}

module.exports = {
  createOffsite, selectRetention, isDue, nextRunAt, localDay, localStamp, zonedAt, decryptToFile, copyDatabase, HEADER: crypto.HEADER_LEN,
};
