#!/usr/bin/env node
/*
 * SortedWMS server: JSON API for handhelds, desks, stations and the office,
 * backed by the engine and a SQLite journal. No dependencies beyond Node 22.
 *
 *   PORT=8080 SORTED_DB=data/sorted.db node --no-warnings server/index.js
 *
 * Set SORTED_TOKEN to require a token on every API call (header x-token).
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { Store } = require('./store');
const { Printers } = require('./print');
const { createApi } = require('./api');
const { createAuth } = require('./auth');
const { createHardware } = require('./hardware');
const { permissionFor } = require('./permissions');
const registry = require('../modules/registry');

const ROOT = path.join(__dirname, '..');

function createServer({ store, printers, token = process.env.SORTED_TOKEN || null, auth = null, hardware = null, backups = null, outbox = null }) {
  hardware = hardware || (auth ? createHardware({ printers, store }) : null);
  const api = createApi({ store, printers, hardware, backups });
  const pages = {
    '/login': 'server/public/login.html', '/app': 'server/public/app.html', '/setup': 'server/public/setup.html', '/pair': 'server/public/pair.html',
    '/handheld': 'server/public/handheld.html', '/bins': 'server/public/bins.html', '/camera.js': 'server/public/camera.js', '/src/messages.js': 'src/messages.js', '/src/intake.js': 'src/intake.js', '/theme.js': 'server/public/theme.js', '/admin': 'server/public/admin.html', '/card': 'server/public/card.html', '/card.html': 'server/public/card.html',
    '/keys': 'server/public/keys.html', '/keys.html': 'server/public/keys.html',
    '/station': 'server/public/station.html', '/station.html': 'server/public/station.html',
    '/desk': 'server/public/desk.html', '/desk.html': 'server/public/desk.html',
    '/loading': 'server/public/loading.html', '/loading.html': 'server/public/loading.html',
    '/src/engine.js': 'src/engine.js', '/src/gs1.js': 'src/gs1.js', '/src/labels.js': 'src/labels.js', '/src/locations.js': 'src/locations.js', '/src/presets.js': 'src/presets.js', '/src/operations.js': 'src/operations.js', '/src/bins.js': 'src/bins.js', '/src/waves.js': 'src/waves.js', '/src/corrections.js': 'src/corrections.js', '/src/sheets.js': 'src/sheets.js', '/src/renames.js': 'src/renames.js', '/src/serials.js': 'src/serials.js', '/src/abc.js': 'src/abc.js', '/src/offline-queue.js': 'src/offline-queue.js', '/src/foundation.js': 'src/foundation.js', '/src/barcode.js': 'src/barcode.js',
    '/app.html': 'server/public/app.html',
  };
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (status, body, type = 'application/json; charset=utf-8', headers = {}) => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...headers });
      res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
    };
    if (req.method === 'GET' && url.pathname === '/') return send(302, '', 'text/plain', { location: '/app' });
    if (req.method === 'GET' && url.pathname.startsWith('/pair/')) {
      return send(200, fs.readFileSync(path.join(ROOT, 'server/public/pair.html')), 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && pages[url.pathname]) {
      // Someone who must choose a password first gets the screen that asks for it.
      if (auth && /^\/(setup|admin|handheld|bins|kit|station|desk|loading|keys|card)(\.html)?$/.test(url.pathname)) {
        const pending = auth.userFromRequest(req);
        if (pending && pending.mustChangePassword) return send(302, '', 'text/plain', { location: `/app?next=${encodeURIComponent(url.pathname + url.search)}` });
      }
      const file = path.join(ROOT, pages[url.pathname]);
      return send(200, fs.readFileSync(file), types[path.extname(file)]);
    }
    if (!url.pathname.startsWith('/api/')) return send(404, { error: 'Not found' });

    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 5e6) req.destroy(); });
    req.on('end', () => {
      let body;
      try { body = raw ? JSON.parse(raw) : {}; } catch (e) { return send(400, { error: 'Body is not JSON' }); }
      const sharedOk = Boolean(token) && (req.headers['x-token'] === token || url.searchParams.get('token') === token);
      const sessionUser = auth ? auth.userFromRequest(req) : null;
      const access = permissionFor(req.method, url.pathname);

      if (auth && access.public && req.method === 'POST' && url.pathname === '/api/login') {
        const signed = auth.login(body.username, body.password);
        if (signed && signed.locked) return send(429, { error: 'Too many sign-in attempts. Try again later.', until: signed.until });
        if (!signed) return send(401, { error: 'Unknown username or password' });
        if (signed.mfaRequired) return send(200, { mfaRequired: true, mfaToken: signed.mfaToken });
        return send(200, { user: signed.user }, 'application/json; charset=utf-8', { 'set-cookie': auth.sessionCookie(signed.token, signed.maxAge) });
      }
      if (auth && access.public && req.method === 'POST' && url.pathname === '/api/login/totp') {
        try {
          const signed = auth.loginTotp(body.mfaToken, body.code);
          return send(200, { user: signed.user }, 'application/json; charset=utf-8', { 'set-cookie': auth.sessionCookie(signed.token, signed.maxAge) });
        } catch (e) { return send(401, { error: e.message }); }
      }
      if (auth && access.public && req.method === 'POST' && url.pathname === '/api/logout') {
        auth.logout(auth.cookieToken(req));
        return send(200, { ok: true }, 'application/json; charset=utf-8', { 'set-cookie': auth.clearCookie() });
      }
      if (access.public && req.method === 'GET' && url.pathname === '/api/health') return send(200, { ok: true, auth: Boolean(auth) });
      if (auth && access.public && req.method === 'GET' && url.pathname === '/api/login/info') return send(200, { demoUsers: auth.hasDemoUsers() });
      if (auth && access.public && req.method === 'GET' && url.pathname === '/api/session') {
        if (!sessionUser) return send(401, { error: 'Sign in required' });
        return send(200, { user: sessionUser, features: (store.wh && store.wh.features) || {}, categories: (store.wh && store.wh.categories) || {}, itemApproval: Boolean(store.wh && store.wh.config && store.wh.config.itemApproval) });
      }

      let by;
      let actor = null;
      // A shared token keeps the old operator header, or the device id in the path (/api/devices/HH03/…).
      const legacyBy = () => String(req.headers['x-operator'] || body.by || url.pathname.split('/')[3] || 'office').slice(0, 40);
      if (sharedOk) {
        actor = { username: 'service', role: 'administrator', service: true, active: true };
        by = legacyBy();
      } else if (sessionUser) {
        actor = sessionUser;
        by = sessionUser.username;
      } else if (token && !access.public) {
        return send(401, { error: 'Token required' });
      } else if (auth && !access.public) {
        return send(401, { error: 'Sign in required' });
      } else {
        by = legacyBy();
      }
      if (auth && actor && access.permission && !auth.can(actor, access.permission)) {
        return send(403, { error: `Missing permission: ${access.permission}` });
      }
      const siteForModule = decodeURIComponent(String(req.headers['x-site'] || '').trim() || 'MAIN').toUpperCase() || 'MAIN';
      let moduleWh = store.wh;
      try { moduleWh = store.warehouse(siteForModule === 'MAIN' ? 'MAIN' : siteForModule); } catch (e) { moduleWh = store.wh; }
      if (actor && actor.role === 'client' && moduleWh && typeof moduleWh.module === 'function' && !moduleWh.module('clients') && !['/api/session', '/api/modules', '/api/logout'].includes(url.pathname)) {
        return send(403, { error: 'Client login is switched off for this warehouse.', module: 'clients' });
      }
      const denied = registry.denial(moduleWh, req.method, url.pathname);
      if (denied) return send(denied.status, denied.body);
      if (auth && actor && actor.mustChangePassword && !['/api/password', '/api/logout', '/api/session'].includes(url.pathname)) {
        return send(403, { error: 'Change your password before continuing', mustChangePassword: true });
      }
      const siteCookie = String((req.headers.cookie || '').split(';').map((p) => p.trim()).find((p) => p.startsWith('sorted_site=')) || '').slice('sorted_site='.length);
      const requestedSite = decodeURIComponent(req.headers['x-site'] || siteCookie || 'MAIN').toUpperCase() || 'MAIN';
      if (req.method === 'POST' && url.pathname === '/api/sites/switch') {
        try {
          const target = String(body.id || 'MAIN').toUpperCase();
          if (auth && actor && !auth.canAccessSite(actor, target)) return send(403, { error: `No access to warehouse ${target}` });
          store.warehouse(target);
          store.siteId = target;
          return send(200, { current: store.siteId, sites: store.listSites() }, 'application/json; charset=utf-8', { 'set-cookie': `sorted_site=${encodeURIComponent(store.siteId)}; Path=/; SameSite=Lax` });
        } catch (e) { return send(400, { error: e.message }); }
      }
      if (auth && actor && !auth.canAccessSite(actor, requestedSite)) return send(403, { error: `No access to warehouse ${requestedSite}` });
      store.siteId = requestedSite;
      if (auth && req.method === 'POST' && url.pathname === '/api/password') {
        try { return send(200, { user: auth.changePassword(actor.id, body) }); } catch (e) { return send(400, { error: e.message }); }
      }
      if (auth && req.method === 'POST' && url.pathname === '/api/totp/setup') {
        try { return send(200, auth.beginTotp(actor.id)); } catch (e) { return send(400, { error: e.message }); }
      }
      if (auth && req.method === 'POST' && url.pathname === '/api/totp/enable') {
        try { return send(200, { user: auth.enableTotp(actor.id, body.code) }); } catch (e) { return send(400, { error: e.message }); }
      }
      if (auth && req.method === 'POST' && url.pathname === '/api/totp/disable') {
        try { return send(200, { user: auth.disableTotp(actor.id, body) }); } catch (e) { return send(400, { error: e.message }); }
      }
      const reset = url.pathname.match(/^\/api\/users\/(\d+)\/reset-password$/);
      if (auth && req.method === 'POST' && reset) {
        try { return send(200, auth.resetPassword(reset[1], by)); } catch (e) { return send(400, { error: e.message }); }
      }

      if (auth && req.method === 'GET' && url.pathname === '/api/users') return send(200, { users: auth.listUsers() });
      if (auth && req.method === 'POST' && url.pathname === '/api/users') {
        try {
          const user = auth.insertUser(body);
          auth.record('user-created', by, { username: user.username, role: user.role });
          return send(200, { user });
        } catch (e) { return send(400, { error: e.message }); }
      }
      if (auth && req.method === 'GET' && url.pathname === '/api/pairing') {
        if (!actor) return send(401, { error: 'Sign in required' });
        return send(200, { addresses: require('./pairing').lanAddresses() });
      }
      if (auth && req.method === 'POST' && url.pathname === '/api/pairing') {
        if (!actor) return send(401, { error: 'Sign in required' });
        try {
          const users = auth.listUsers();
          const target = body.userId ? users.find((u) => u.username === String(body.userId).toLowerCase() || u.id === Number(body.userId)) : actor;
          if (!target) return send(400, { error: 'Unknown user' });
          const forSomeoneElse = target.id !== actor.id;
          if (forSomeoneElse && actor.role !== 'administrator' && !auth.can(actor, 'users.write')) return send(403, { error: 'Missing permission: users.write' });
          const issued = auth.createPairToken({ userId: target.id, createdBy: actor.id, requireSecret: forSomeoneElse });
          const { lanAddresses, pairCard } = require('./pairing');
          const addresses = lanAddresses();
          const address = addresses.includes(body.address) ? body.address : addresses[0];
          const listenPort = Number(process.env.PORT || (req.socket && req.socket.localPort) || 8080);
          const card = pairCard({ address, port: listenPort, token: issued.token, code: issued.code });
          try { store.exec('deviceEvent', { device: issued.code, text: `pairing code for ${target.username}` }, actor.username); } catch (e) { /* journal after the account record */ }
          return send(200, { ...card, addresses, expiresAt: issued.expiresAt, username: target.username, requireSecret: forSomeoneElse });
        } catch (e) { return send(400, { error: e.message }); }
      }
      if (auth && req.method === 'POST' && url.pathname === '/api/pairing/claim') {
        try {
          const ip = String(req.socket && req.socket.remoteAddress || '');
          if (!require('./pairing').privateAddress(ip) && process.env.SORTED_PAIR_PUBLIC !== '1') return send(403, { error: 'Pairing is only accepted from the local network' });
          const claimed = auth.claimPair({ token: body.token, code: body.code, secret: body.secret, userAgent: req.headers['user-agent'], ip });
          try { store.exec('deviceEvent', { device: claimed.deviceId, text: `${claimed.user.username} paired a device` }, claimed.user.username); } catch (e) { /* account record already written */ }
          const cookies = [
            auth.sessionCookie(claimed.token, claimed.maxAge),
            `sorted_device=${encodeURIComponent(claimed.deviceId)}; Path=/; SameSite=Lax; Max-Age=${claimed.maxAge}`,
          ];
          return send(200, { user: claimed.user, deviceId: claimed.deviceId }, 'application/json; charset=utf-8', { 'set-cookie': cookies });
        } catch (e) { return send(400, { error: e.message }); }
      }
      if (auth && req.method === 'GET' && url.pathname === '/api/devices/paired') {
        if (!actor || !auth.can(actor, 'devices.manage')) return send(403, { error: 'Missing permission: devices.manage' });
        return send(200, { devices: auth.listDevices() });
      }
      if (auth && req.method === 'POST' && url.pathname === '/api/devices/paired/revoke-all') {
        if (!actor || !auth.can(actor, 'devices.manage')) return send(403, { error: 'Missing permission: devices.manage' });
        const out = auth.revokeAllDevices(actor.username);
        try { store.exec('deviceEvent', { text: `all paired devices revoked (${out.revoked})` }, actor.username); } catch (e) { /* audit already written */ }
        return send(200, out);
      }
      const deviceEdit = url.pathname.match(/^\/api\/devices\/paired\/([^/]+)(?:\/(rename|revoke))?$/);
      if (auth && req.method === 'POST' && deviceEdit) {
        if (!actor || !auth.can(actor, 'devices.manage')) return send(403, { error: 'Missing permission: devices.manage' });
        try {
          const id = decodeURIComponent(deviceEdit[1]);
          const out = deviceEdit[2] === 'rename' ? auth.renameDevice(id, body.name, actor.username) : auth.revokeDevice(id, actor.username);
          try { store.exec('deviceEvent', { device: id, text: deviceEdit[2] === 'rename' ? `renamed to ${out.name}` : 'revoked' }, actor.username); } catch (e) { /* audit already written */ }
          return send(200, out);
        } catch (e) { return send(400, { error: e.message }); }
      }
      const userEdit = url.pathname.match(/^\/api\/users\/(\d+)$/);
      if (auth && req.method === 'POST' && userEdit) {
        try { return send(200, { user: auth.updateUser(userEdit[1], { ...body, by }) }); } catch (e) { return send(400, { error: e.message }); }
      }
      if (auth && req.method === 'GET' && url.pathname === '/api/roles') {
        const cat = auth.catalog();
        const hidden = registry.hiddenPermissions(store.wh);
        cat.permissions = cat.permissions.filter((perm) => !hidden.has(perm.id));
        return send(200, cat);
      }
      const roleEdit = url.pathname.match(/^\/api\/roles\/([a-z]+)$/);
      if (auth && req.method === 'POST' && roleEdit) {
        try {
          const hidden = registry.hiddenPermissions(store.wh);
          const current = (auth.catalog().roles.find((role) => role.id === roleEdit[1]) || {}).permissions || [];
          const kept = current.filter((perm) => hidden.has(perm));
          return send(200, { role: roleEdit[1], permissions: auth.setRolePermissions(roleEdit[1], [...(body.permissions || []), ...kept], by) });
        } catch (e) { return send(400, { error: e.message }); }
      }
      if (auth && req.method === 'GET' && url.pathname === '/api/auth-log') return send(200, auth.audit(url.searchParams.get('limit')));
      // API keys for other systems: made by an administrator, shown once, revoked here.
      if (auth && req.method === 'GET' && url.pathname === '/api/keys') return send(200, { keys: auth.listApiKeys() });
      if (auth && req.method === 'POST' && url.pathname === '/api/keys') {
        try { return send(200, auth.createApiKey(body, by)); } catch (e) { return send(400, { error: e.message }); }
      }
      // Webhooks: messages pushed to another system as they happen (server/outbox.js).
      if (outbox && req.method === 'GET' && url.pathname === '/api/webhooks') return send(200, { webhooks: outbox.list(), types: outbox.TYPES });
      if (outbox && req.method === 'POST' && url.pathname === '/api/webhooks') {
        try { const made = outbox.add(body, by); if (auth) auth.record('webhook-added', by, { url: made.url }); return send(200, made); } catch (e) { return send(400, { error: e.message }); }
      }
      const hookAct = url.pathname.match(/^\/api\/webhooks\/(\d+)\/(remove|retry)$/);
      if (outbox && req.method === 'POST' && hookAct) {
        try {
          if (hookAct[2] === 'retry') return send(200, outbox.retry(hookAct[1]));
          const gone = outbox.remove(hookAct[1]);
          if (auth) auth.record('webhook-removed', by, { id: gone.removed });
          return send(200, gone);
        } catch (e) { return send(400, { error: e.message }); }
      }
      const keyRevoke = url.pathname.match(/^\/api\/keys\/(\d+)\/revoke$/);
      if (auth && req.method === 'POST' && keyRevoke) {
        try { return send(200, auth.revokeApiKey(keyRevoke[1], by)); } catch (e) { return send(400, { error: e.message }); }
      }

      const requestId = req.headers['x-request-id'] ? String(req.headers['x-request-id']).slice(0, 80) : null;
      Promise.resolve(api.handle(req.method, req.url, body, by, requestId, actor)).then((out) => {
        if (out.contentType) return send(out.status, out.body, out.contentType);
        send(out.status, out.body);
      });
    });
  });
}

function main() {
  const dbFile = process.env.SORTED_DB || path.join(ROOT, 'data', 'sorted.db');
  const siteFile = process.env.SORTED_SITE || path.join(__dirname, 'site.blank.json');
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const site = JSON.parse(fs.readFileSync(siteFile, 'utf8'));
  const store = new Store({ file: dbFile, site });
  for (const line of store.upgradeLines) console.log(line);
  if (store.replayErrors.length) console.warn(`Replay finished with ${store.replayErrors.length} error(s):\n${store.replayErrors.slice(0, 10).join('\n')}`);
  const printers = new Printers(store.siteUsed.printers || {});
  printers.sentUpTo = Math.max(0, ...store.wh.printQueue.map((j) => j.id)); // don't reprint history
  const auth = createAuth(store.db);
  const adminUser = process.env.SORTED_ADMIN_USER || 'admin';
  const adminPass = process.env.SORTED_ADMIN_PASSWORD || 'sorted-admin';
  // A real warehouse (no demo sign-ins) never keeps the password printed on the sign-in page.
  const boot = auth.ensureAdmin({ username: adminUser, password: adminPass, displayName: 'Administrator', mustChange: adminPass === 'sorted-admin' && process.env.SORTED_DEMO_USERS === '0' });
  const demoUsers = process.env.SORTED_DEMO_USERS === '0' ? [] : auth.ensureDemoUsers();
  const sample = (process.argv.find((a) => a.startsWith('--sample=')) || '').slice('--sample='.length);
  if (sample) {
    const { loadSample } = require('./samples');
    console.log(loadSample(store, sample));
  }
  // A copy of the database a day, the newest 14 kept. SORTED_BACKUPS=0 turns it off.
  const backups = process.env.SORTED_BACKUPS === '0' ? null : require('./backups').schedule(store, process.env.SORTED_BACKUP_DIR || path.join(path.dirname(dbFile), 'backups'), { keep: Number(process.env.SORTED_BACKUP_KEEP) || 14 });
  const hardware = createHardware({ printers, store });
  // Messages pushed out: webhooks always, the outbox folder when SORTED_OUTBOX names one.
  const outbox = require('./outbox').createOutbox({ store });
  const connectionsOn = () => !store.wh || typeof store.wh.module !== 'function' || store.wh.module('connections');
  const stopOutbox = outbox.start({ folder: process.env.SORTED_OUTBOX || null, enabled: connectionsOn });
  const server = createServer({ store, printers, auth, hardware, backups, outbox });
  const tick = setInterval(() => { try { store.tick(); printers.flush(store.wh.printQueue); } catch (e) { console.error('tick', e); } }, 10000);
  // The drop folder: orders and ASNs as files (docs/CONNECTIONS.md). SORTED_INBOX=0 turns it off.
  const inbox = process.env.SORTED_INBOX === '0' ? null : require('./inbox').watchInbox({ dir: process.env.SORTED_INBOX || path.join(path.dirname(dbFile), 'inbox'), api: createApi({ store, printers, hardware, backups }), enabled: connectionsOn });
  const port = Number(process.env.PORT || 8080);
  server.listen(port, () => {
    console.log(`SortedWMS on http://localhost:${port}  ·  sign in: /login  ·  roles: /app  ·  handheld: /handheld  ·  office: /admin`);
    if (boot.mustChange) console.log(`Administrator ${boot.username} / sorted-admin: sign in and choose a new password`);
    else if (boot.created && adminPass === 'sorted-admin') console.log(`Administrator ${boot.username} / sorted-admin  (set SORTED_ADMIN_PASSWORD to change it)`);
    else if (boot.created) console.log(`Administrator ${boot.username} created from SORTED_ADMIN_PASSWORD`);
    if (demoUsers.length) console.log(`Sample sign-in (password sorted-<role>): ${demoUsers.join(', ')}`);
    if (inbox) console.log(`Drop folder for orders and ASNs: ${inbox.dir}`);
    if (process.env.SORTED_OUTBOX) console.log(`Outbox folder for messages: ${process.env.SORTED_OUTBOX}`);
  });
  const stop = () => { clearInterval(tick); stopOutbox(); if (inbox) inbox.stop(); if (backups) backups.stop(); server.close(); store.close(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (require.main === module) main();

module.exports = { createServer, main };
