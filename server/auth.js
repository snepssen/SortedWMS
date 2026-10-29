/*
 * Accounts, password hashes and sessions. Stored in the same SQLite file as
 * the journal, but not in the journal: replaying warehouse commands must not
 * depend on who is signed in. Passwords are scrypt hashes. The cookie holds
 * the raw session token; the database stores its SHA-256.
 */
const { scryptSync, randomBytes, timingSafeEqual, createHash } = require('node:crypto');
const { PERMISSIONS, ALL, ROLES, ROLE_IDS, DEFAULTS, roleLabel } = require('./permissions');

const SCRYPT_N = Number(process.env.SORTED_SCRYPT_N) || 16384;
const SESSION_MS = 12 * 60 * 60 * 1000;
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
  `);
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

  function insertUser({ username, password, role, displayName }) {
    const name = String(username || '').trim().toLowerCase();
    if (!/^[a-z][a-z0-9._-]{1,31}$/.test(name)) throw new Error('Username: start with a letter, then letters, digits, dot, underscore or hyphen');
    if (String(password || '').length < 8) throw new Error('Password must be at least 8 characters');
    if (!ROLE_IDS.includes(role)) throw new Error(`Role is one of ${ROLE_IDS.join(', ')}`);
    const display = String(displayName || name).trim();
    if (!display) throw new Error('A display name is required');
    if (getUser(name)) throw new Error(`User ${name} already exists`);
    const t = now();
    const result = db.prepare('INSERT INTO users (username, display_name, password_hash, role, active, created_at) VALUES (?, ?, ?, ?, 1, ?)').run(name, display, hashPassword(password), role, t);
    return rowToUser(db.prepare('SELECT * FROM users WHERE id = ?').get(Number(result.lastInsertRowid)));
  }

  function activeAdmins(exceptId = null) {
    return db.prepare("SELECT id FROM users WHERE role = 'administrator' AND active = 1").all().filter((r) => r.id !== exceptId);
  }

  function login(username, password) {
    const row = getUser(username);
    const ok = row ? verifyPassword(password, row.password_hash) : verifyPassword(password, dummy);
    if (!row || !ok) {
      record('login-failed', String(username || '').slice(0, 40), null);
      return null;
    }
    if (!row.active) {
      record('login-disabled', row.username, null);
      return null;
    }
    const token = randomBytes(32).toString('base64url');
    const t = now();
    db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(tokenHash(token), row.id, t, t + SESSION_MS);
    record('login', row.username, null);
    return { token, user: rowToUser(row), maxAge: Math.floor(SESSION_MS / 1000) };
  }

  function userFromToken(token) {
    if (!token) return null;
    const row = db.prepare('SELECT s.expires_at, u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?').get(tokenHash(token));
    if (!row) return null;
    if (row.expires_at <= now() || !row.active) {
      db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash(token));
      return null;
    }
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
    if (patch.password) {
      if (String(patch.password).length < 8) throw new Error('Password must be at least 8 characters');
      hash = hashPassword(patch.password);
    }
    db.prepare('UPDATE users SET display_name = ?, role = ?, active = ?, password_hash = ? WHERE id = ?').run(display, role, active ? 1 : 0, hash, row.id);
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

  return {
    hashPassword,
    verifyPassword,
    record,
    permissionsFor,
    can,
    getUser,
    insertUser,
    login,
    logout,
    userFromToken,
    userFromRequest,
    listUsers,
    updateUser,
    setRolePermissions,
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

module.exports = { createAuth, hashPassword, verifyPassword, DEMO_USERS, SESSION_MS };
