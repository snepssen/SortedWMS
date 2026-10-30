/*
 * Accounts, password hashes and sessions. Stored in the same SQLite file as
 * the journal, but not in the journal: replaying warehouse commands must not
 * depend on who is signed in. Passwords are scrypt hashes. The cookie holds
 * the raw session token; the database stores its SHA-256.
 */
const { scryptSync, randomBytes, timingSafeEqual, createHash, createHmac } = require('node:crypto');
const { PERMISSIONS, ALL, ROLES, ROLE_IDS, DEFAULTS, roleLabel } = require('./permissions');

const SCRYPT_N = Number(process.env.SORTED_SCRYPT_N) || 16384;
const SESSION_MS = 12 * 60 * 60 * 1000;
const IDLE_MS = Number(process.env.SORTED_IDLE_MS) || 30 * 60 * 1000;
const LOCK_MS = 15 * 60 * 1000;
const MAX_FAILS = 5;
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const DEMO_USERS = [
  ['admin', 'sorted-admin', 'administrator', 'Alex Admin'],
  ['manager', 'sorted-manager', 'manager', 'Morgan Supervisor'],
  ['office', 'sorted-office', 'office', 'Olivia Office'],
  ['tech', 'sorted-tech', 'technician', 'Taylor Technical'],
  ['operator', 'sorted-operator', 'operator', 'Omar Operator'],
  ['machine', 'sorted-machine', 'machine', 'Mina Machine'],
];

function hashPassword(password, params = {}) {
  const N = params.N || SCRYPT_N;
  const r = params.r || 8;
  const p = params.p || 1;
  const salt = params.salt || randomBytes(16);
  const hash = scryptSync(String(password), salt, 32, { N, r, p });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  let salt;
  let expect;
  try {
    salt = Buffer.from(parts[4], 'base64');
    expect = Buffer.from(parts[5], 'base64');
  } catch (e) {
    return false;
  }
  const hash = scryptSync(String(password), salt, expect.length, { N, r, p });
  return hash.length === expect.length && timingSafeEqual(hash, expect);
}

function tokenHash(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(text) {
  const clean = String(text || '').toUpperCase().replace(/=+$/g, '').replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const char of clean) {
    const idx = BASE32.indexOf(char);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function totpCode(secret, at = Date.now(), step = 30) {
  const counter = Math.floor(at / 1000 / step);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const hmac = createHmac('sha1', base32Decode(secret)).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 1000000;
  return String(code).padStart(6, '0');
}

function verifyTotp(secret, code, at = Date.now()) {
  const want = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(want) || !secret) return false;
  return [-1, 0, 1].some((window) => totpCode(secret, at + window * 30000) === want);
}

function cookies(req) {
  const out = {};
  for (const part of String((req.headers && req.headers.cookie) || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function createAuth(db, { now = () => Date.now() } = {}) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS role_permissions (
      role TEXT PRIMARY KEY,
      permissions TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS auth_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      t INTEGER NOT NULL,
      action TEXT NOT NULL,
      by TEXT,
      detail TEXT
    );
    CREATE TABLE IF NOT EXISTS mfa_challenges (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
  `);
  const have = (table, column) => db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
  const add = (table, column, ddl) => { if (!have(table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`); };
  add('users', 'must_change', 'INTEGER NOT NULL DEFAULT 0');
  add('users', 'failed_logins', 'INTEGER NOT NULL DEFAULT 0');
  add('users', 'locked_until', 'INTEGER');
  add('users', 'totp_secret', 'TEXT');
  add('users', 'totp_enabled', 'INTEGER NOT NULL DEFAULT 0');
  add('users', 'sites', 'TEXT');
  add('users', 'client_id', 'TEXT');
  add('sessions', 'last_seen', 'INTEGER');
  const dummy = hashPassword('not-a-real-password');

  function record(action, by, detail) {
    db.prepare('INSERT INTO auth_audit (t, action, by, detail) VALUES (?, ?, ?, ?)').run(now(), action, by || null, detail ? JSON.stringify(detail) : null);
  }

  function rowToUser(row) {
    if (!row) return null;
    return {
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      role: row.role,
      roleLabel: roleLabel(row.role),
      active: Boolean(row.active),
      mustChangePassword: Boolean(row.must_change),
      totpEnabled: Boolean(row.totp_enabled),
      sites: row.sites ? JSON.parse(row.sites) : null,
      clientId: row.client_id || null,
      permissions: permissionsFor(row.role),
    };
  }

  function permissionsFor(role) {
    if (role === 'administrator') return ALL.slice();
    const saved = db.prepare('SELECT permissions FROM role_permissions WHERE role = ?').get(role);
    if (saved) return JSON.parse(saved.permissions);
    return (DEFAULTS[role] || []).slice();
  }

  function can(user, perm) {
    if (!user || user.active === false) return false;
    if (user.service || user.role === 'administrator') return true;
    return permissionsFor(user.role).includes(perm);
  }

  function getUser(username) {
    return db.prepare('SELECT * FROM users WHERE username = ?').get(String(username || '').trim().toLowerCase());
  }

  function insertUser({ username, password, role, displayName, clientId = null }) {
    const name = String(username || '').trim().toLowerCase();
    if (!/^[a-z][a-z0-9._-]{1,31}$/.test(name)) throw new Error('Username: start with a letter, then letters, digits, dot, underscore or hyphen');
    if (String(password || '').length < 8) throw new Error('Password must be at least 8 characters');
    if (!ROLE_IDS.includes(role)) throw new Error(`Role is one of ${ROLE_IDS.join(', ')}`);
    const owner = clientId ? String(clientId).trim().toUpperCase() : null;
    if (role === 'client' && !owner) throw new Error('A client login needs a client id');
    const display = String(displayName || name).trim();
    if (!display) throw new Error('A display name is required');
    if (getUser(name)) throw new Error(`User ${name} already exists`);
    const t = now();
    const result = db.prepare('INSERT INTO users (username, display_name, password_hash, role, active, created_at, client_id) VALUES (?, ?, ?, ?, 1, ?, ?)').run(name, display, hashPassword(password), role, t, owner);
    return rowToUser(db.prepare('SELECT * FROM users WHERE id = ?').get(Number(result.lastInsertRowid)));
  }

  function activeAdmins(exceptId = null) {
    return db.prepare("SELECT id FROM users WHERE role = 'administrator' AND active = 1").all().filter((r) => r.id !== exceptId);
  }

  function openSession(row) {
    const token = randomBytes(32).toString('base64url');
    const t = now();
    db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen) VALUES (?, ?, ?, ?, ?)').run(tokenHash(token), row.id, t, t + SESSION_MS, t);
    db.prepare('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?').run(row.id);
    record('login', row.username, null);
    return { token, user: rowToUser(db.prepare('SELECT * FROM users WHERE id = ?').get(row.id)), maxAge: Math.floor(SESSION_MS / 1000) };
  }

  function login(username, password) {
    const row = getUser(username);
    if (row && row.locked_until && row.locked_until > now()) {
      record('login-locked', row.username, { until: row.locked_until });
      return { locked: true, until: row.locked_until };
    }
    const ok = row ? verifyPassword(password, row.password_hash) : verifyPassword(password, dummy);
    if (!row || !ok || !row.active) {
      if (row && row.active) {
        const fails = Number(row.failed_logins || 0) + 1;
        const lockedUntil = fails >= MAX_FAILS ? now() + LOCK_MS : null;
        db.prepare('UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?').run(fails, lockedUntil, row.id);
        record(lockedUntil ? 'login-locked' : 'login-failed', row.username, lockedUntil ? { until: lockedUntil } : null);
      } else record(row && !row.active ? 'login-disabled' : 'login-failed', String(username || '').slice(0, 40), null);
      return null;
    }
    if (row.totp_enabled) {
      const mfaToken = randomBytes(24).toString('base64url');
      db.prepare('INSERT INTO mfa_challenges (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(tokenHash(mfaToken), row.id, now() + 5 * 60 * 1000);
      record('login-mfa', row.username, null);
      return { mfaRequired: true, mfaToken };
    }
    return openSession(row);
  }

  function loginTotp(mfaToken, code) {
    const challenge = db.prepare('SELECT c.expires_at, u.* FROM mfa_challenges c JOIN users u ON u.id = c.user_id WHERE c.token_hash = ?').get(tokenHash(mfaToken || ''));
    if (!challenge || challenge.expires_at <= now()) throw new Error('That sign-in challenge has expired');
    if (!verifyTotp(challenge.totp_secret, code)) throw new Error('That code is not valid');
    db.prepare('DELETE FROM mfa_challenges WHERE token_hash = ?').run(tokenHash(mfaToken));
    return openSession(challenge);
  }

  function userFromToken(token) {
    if (!token) return null;
    const row = db.prepare('SELECT s.expires_at AS session_expires, s.last_seen AS session_seen, s.created_at AS session_created, u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?').get(tokenHash(token));
    if (!row) return null;
    const seen = row.session_seen || row.session_created || 0;
    if (row.session_expires <= now() || now() - seen > IDLE_MS || !row.active) {
      db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash(token));
      if (now() - seen > IDLE_MS) record('session-timeout', row.username, null);
      return null;
    }
    db.prepare('UPDATE sessions SET last_seen = ? WHERE token_hash = ?').run(now(), tokenHash(token));
    return rowToUser(row);
  }

  function userFromRequest(req) {
    return userFromToken(cookies(req).sorted_session);
  }

  function logout(token) {
    if (!token) return;
    const user = userFromToken(token);
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash(token));
    if (user) record('logout', user.username, null);
  }

  function listUsers() {
    return db.prepare('SELECT * FROM users ORDER BY username').all().map(rowToUser);
  }

  function updateUser(id, patch) {
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(id));
    if (!row) throw new Error('Unknown user');
    const role = patch.role == null ? row.role : patch.role;
    const active = patch.active == null ? Boolean(row.active) : Boolean(patch.active);
    if (!ROLE_IDS.includes(role)) throw new Error(`Role is one of ${ROLE_IDS.join(', ')}`);
    if (row.role === 'administrator' && row.active && (role !== 'administrator' || !active) && activeAdmins(row.id).length < 1) {
      throw new Error('The last administrator cannot be removed');
    }
    const display = patch.displayName == null ? row.display_name : String(patch.displayName).trim();
    if (!display) throw new Error('A display name is required');
    let hash = row.password_hash;
    let mustChange = row.must_change || 0;
    if (patch.password) {
      if (String(patch.password).length < 8) throw new Error('Password must be at least 8 characters');
      hash = hashPassword(patch.password);
      mustChange = 0;
    }
    let sites = row.sites;
    let clientId = row.client_id;
    if ('clientId' in patch) clientId = patch.clientId ? String(patch.clientId).trim().toUpperCase() : null;
    if (role === 'client' && !clientId) throw new Error('A client login needs a client id');
    if ('sites' in patch) {
      if (patch.sites == null || patch.sites === '') sites = null;
      else {
        if (!Array.isArray(patch.sites) || patch.sites.some((s) => typeof s !== 'string' || !s.trim())) throw new Error('Warehouse access is a list of warehouse ids');
        sites = JSON.stringify([...new Set(patch.sites.map((s) => s.trim().toUpperCase()))]);
      }
    }
    db.prepare('UPDATE users SET display_name = ?, role = ?, active = ?, password_hash = ?, must_change = ?, sites = ?, client_id = ? WHERE id = ?').run(display, role, active ? 1 : 0, hash, mustChange, sites, clientId, row.id);
    if (!active) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.id);
    record('user-updated', patch.by || null, { id: row.id, username: row.username, role, active });
    return rowToUser(db.prepare('SELECT * FROM users WHERE id = ?').get(row.id));
  }

  function setRolePermissions(role, permissions, by) {
    if (!ROLE_IDS.includes(role)) throw new Error(`Role is one of ${ROLE_IDS.join(', ')}`);
    if (role === 'administrator') throw new Error('The administrator role always has every permission');
    if (!Array.isArray(permissions) || permissions.some((p) => !ALL.includes(p))) throw new Error('Unknown permission in the list');
    const unique = [...new Set(permissions)];
    db.prepare('INSERT INTO role_permissions (role, permissions) VALUES (?, ?) ON CONFLICT(role) DO UPDATE SET permissions = excluded.permissions').run(role, JSON.stringify(unique));
    record('role-permissions', by || null, { role, permissions: unique });
    return unique;
  }

  function audit(limit = 100) {
    return db.prepare('SELECT id, t, action, by, detail FROM auth_audit ORDER BY id DESC LIMIT ?').all(Math.min(Number(limit) || 100, 500)).map((r) => ({
      ...r, detail: r.detail ? JSON.parse(r.detail) : null,
    }));
  }

  function changePassword(userId, { current, next }) {
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(userId));
    if (!row) throw new Error('Unknown user');
    if (!verifyPassword(current, row.password_hash)) throw new Error('Current password is wrong');
    if (String(next || '').length < 8) throw new Error('Password must be at least 8 characters');
    if (String(next) === String(current)) throw new Error('Choose a different password');
    db.prepare('UPDATE users SET password_hash = ?, must_change = 0 WHERE id = ?').run(hashPassword(next), row.id);
    record('password-changed', row.username, null);
    return rowToUser(db.prepare('SELECT * FROM users WHERE id = ?').get(row.id));
  }

  function resetPassword(id, by) {
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(id));
    if (!row) throw new Error('Unknown user');
    const temporaryPassword = `Tmp-${randomBytes(6).toString('base64url')}`;
    db.prepare('UPDATE users SET password_hash = ?, must_change = 1, failed_logins = 0, locked_until = NULL WHERE id = ?').run(hashPassword(temporaryPassword), row.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.id);
    record('password-reset', by || null, { username: row.username });
    return { username: row.username, temporaryPassword };
  }

  function beginTotp(userId) {
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(userId));
    if (!row) throw new Error('Unknown user');
    const secret = base32Encode(randomBytes(20));
    db.prepare('UPDATE users SET totp_secret = ?, totp_enabled = 0 WHERE id = ?').run(secret, row.id);
    return { secret, otpauth: `otpauth://totp/SortedWMS:${encodeURIComponent(row.username)}?secret=${secret}&issuer=SortedWMS` };
  }

  function enableTotp(userId, code) {
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(userId));
    if (!row || !row.totp_secret) throw new Error('Start two-factor setup first');
    if (!verifyTotp(row.totp_secret, code)) throw new Error('That code is not valid');
    db.prepare('UPDATE users SET totp_enabled = 1 WHERE id = ?').run(row.id);
    record('totp-enabled', row.username, null);
    return rowToUser(db.prepare('SELECT * FROM users WHERE id = ?').get(row.id));
  }

  function disableTotp(userId, { password, code }) {
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(userId));
    if (!row || !verifyPassword(password, row.password_hash) || !verifyTotp(row.totp_secret, code)) throw new Error('Password or code is wrong');
    db.prepare('UPDATE users SET totp_enabled = 0, totp_secret = NULL WHERE id = ?').run(row.id);
    record('totp-disabled', row.username, null);
    return rowToUser(db.prepare('SELECT * FROM users WHERE id = ?').get(row.id));
  }

  function canAccessSite(user, siteId) {
    if (!user || user.active === false) return false;
    if (user.service || user.role === 'administrator') return true;
    if (!user.sites || !user.sites.length) return true;
    return user.sites.includes(String(siteId || 'MAIN').toUpperCase());
  }

  return {
    hashPassword,
    verifyPassword,
    totpCode,
    verifyTotp,
    record,
    permissionsFor,
    can,
    getUser,
    insertUser,
    login,
    loginTotp,
    logout,
    userFromToken,
    userFromRequest,
    listUsers,
    updateUser,
    setRolePermissions,
    changePassword,
    resetPassword,
    beginTotp,
    enableTotp,
    disableTotp,
    canAccessSite,
    audit,
    catalog() {
      return {
        permissions: PERMISSIONS.map(([id, label]) => ({ id, label })),
        roles: ROLES.map(([id, label]) => ({ id, label, permissions: permissionsFor(id), fixed: id === 'administrator' })),
      };
    },
    ensureAdmin({ username = 'admin', password = 'sorted-admin', displayName = 'Administrator' } = {}) {
      if (getUser(username)) return { created: false, username: String(username).toLowerCase() };
      const user = insertUser({ username, password, role: 'administrator', displayName });
      record('bootstrap-admin', 'bootstrap', { username: user.username });
      return { created: true, username: user.username };
    },
    ensureDemoUsers() {
      const created = [];
      for (const [username, password, role, displayName] of DEMO_USERS) {
        if (getUser(username)) continue;
        insertUser({ username, password, role, displayName });
        created.push(username);
      }
      if (created.length) record('bootstrap-demo', 'bootstrap', { users: created });
      return created;
    },
    sessionCookie(token, maxAge) {
      return `sorted_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
    },
    clearCookie() {
      return 'sorted_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0';
    },
    cookieToken(req) {
      return cookies(req).sorted_session || null;
    },
  };
}

module.exports = { createAuth, hashPassword, verifyPassword, totpCode, verifyTotp, DEMO_USERS, SESSION_MS, IDLE_MS };
