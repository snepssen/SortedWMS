#!/usr/bin/env node
/*
 * SortedWMS server: JSON API for handhelds, desks, stations and the office,
 * backed by the engine and a SQLite journal. No dependencies beyond Node 22.
 *
 *   PORT=8080 SORTED_DB=data/sorted.db SORTED_SITE=server/site.example.json node --no-warnings server/index.js
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

const ROOT = path.join(__dirname, '..');

function createServer({ store, printers, token = process.env.SORTED_TOKEN || null, auth = null, hardware = null }) {
  hardware = hardware || (auth ? createHardware({ printers, store }) : null);
  const api = createApi({ store, printers, hardware });
  const pages = {
    '/': 'index.html', '/index.html': 'index.html',
    '/login': 'server/public/login.html', '/app': 'server/public/app.html', '/setup': 'server/public/setup.html',
    '/handheld': 'server/public/handheld.html', '/admin': 'server/public/admin.html', '/card': 'server/public/card.html', '/card.html': 'server/public/card.html',
    '/keys': 'server/public/keys.html', '/keys.html': 'server/public/keys.html',
    '/kit': 'server/public/kit.html', '/kit.html': 'server/public/kit.html',
    '/station': 'server/public/station.html', '/station.html': 'server/public/station.html',
    '/desk': 'server/public/desk.html', '/desk.html': 'server/public/desk.html',
    '/loading': 'server/public/loading.html', '/loading.html': 'server/public/loading.html',
    '/src/engine.js': 'src/engine.js', '/src/gs1.js': 'src/gs1.js', '/src/labels.js': 'src/labels.js', '/src/locations.js': 'src/locations.js', '/src/presets.js': 'src/presets.js', '/src/foundation.js': 'src/foundation.js', '/src/barcode.js': 'src/barcode.js',
  };
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (status, body, type = 'application/json; charset=utf-8', headers = {}) => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...headers });
      res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
    };
    if (req.method === 'GET' && pages[url.pathname]) {
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
        if (!signed) return send(401, { error: 'Unknown username or password' });
        return send(200, { user: signed.user }, 'application/json; charset=utf-8', { 'set-cookie': auth.sessionCookie(signed.token, signed.maxAge) });
      }
      if (auth && access.public && req.method === 'POST' && url.pathname === '/api/logout') {
        auth.logout(auth.cookieToken(req));
        return send(200, { ok: true }, 'application/json; charset=utf-8', { 'set-cookie': auth.clearCookie() });
      }
      if (access.public && req.method === 'GET' && url.pathname === '/api/health') return send(200, { ok: true, auth: Boolean(auth) });
      if (auth && access.public && req.method === 'GET' && url.pathname === '/api/session') {
        if (!sessionUser) return send(401, { error: 'Sign in required' });
        return send(200, { user: sessionUser });
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
      } else if (token) {
        return send(401, { error: 'Token required' });
      } else if (auth) {
        return send(401, { error: 'Sign in required' });
      } else {
        by = legacyBy();
      }
      if (auth && actor && access.permission && !auth.can(actor, access.permission)) {
        return send(403, { error: `Missing permission: ${access.permission}` });
      }

      if (auth && req.method === 'GET' && url.pathname === '/api/users') return send(200, { users: auth.listUsers() });
      if (auth && req.method === 'POST' && url.pathname === '/api/users') {
        try {
          const user = auth.insertUser(body);
          auth.record('user-created', by, { username: user.username, role: user.role });
          return send(200, { user });
        } catch (e) { return send(400, { error: e.message }); }
      }
      const userEdit = url.pathname.match(/^\/api\/users\/(\d+)$/);
      if (auth && req.method === 'POST' && userEdit) {
        try { return send(200, { user: auth.updateUser(userEdit[1], { ...body, by }) }); } catch (e) { return send(400, { error: e.message }); }
      }
      if (auth && req.method === 'GET' && url.pathname === '/api/roles') return send(200, auth.catalog());
      const roleEdit = url.pathname.match(/^\/api\/roles\/([a-z]+)$/);
      if (auth && req.method === 'POST' && roleEdit) {
        try { return send(200, { role: roleEdit[1], permissions: auth.setRolePermissions(roleEdit[1], body.permissions, by) }); } catch (e) { return send(400, { error: e.message }); }
      }
      if (auth && req.method === 'GET' && url.pathname === '/api/auth-log') return send(200, auth.audit(url.searchParams.get('limit')));

      const requestId = req.headers['x-request-id'] ? String(req.headers['x-request-id']).slice(0, 80) : null;
      Promise.resolve(api.handle(req.method, req.url, body, by, requestId)).then((out) => {
        if (out.contentType) return send(out.status, out.body, out.contentType);
        send(out.status, out.body);
      });
    });
  });
}

function main() {
  const dbFile = process.env.SORTED_DB || path.join(ROOT, 'data', 'sorted.db');
  const siteFile = process.env.SORTED_SITE || path.join(__dirname, 'site.example.json');
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const site = JSON.parse(fs.readFileSync(siteFile, 'utf8'));
  const store = new Store({ file: dbFile, site });
  if (store.replayErrors.length) console.warn(`Replay finished with ${store.replayErrors.length} error(s):\n${store.replayErrors.slice(0, 10).join('\n')}`);
  const printers = new Printers(store.siteUsed.printers || {});
  printers.sentUpTo = Math.max(0, ...store.wh.printQueue.map((j) => j.id)); // don't reprint history
  const auth = createAuth(store.db);
  const adminUser = process.env.SORTED_ADMIN_USER || 'admin';
  const adminPass = process.env.SORTED_ADMIN_PASSWORD || 'sorted-admin';
  const boot = auth.ensureAdmin({ username: adminUser, password: adminPass, displayName: 'Administrator' });
  const demoUsers = process.env.SORTED_DEMO_USERS === '0' ? [] : auth.ensureDemoUsers();
  if (process.argv.includes('--seed-demo') && !Object.keys(store.wh.pallets).length) {
    const { seedDemo } = require('./seed');
    console.log(seedDemo(store));
  }
  const hardware = createHardware({ printers, store });
  const server = createServer({ store, printers, auth, hardware });
  const tick = setInterval(() => { try { store.tick(); printers.flush(store.wh.printQueue); } catch (e) { console.error('tick', e); } }, 10000);
  const port = Number(process.env.PORT || 8080);
  server.listen(port, () => {
    console.log(`SortedWMS on http://localhost:${port}  ·  sign in: /login  ·  roles: /app  ·  handheld: /handheld  ·  office: /admin  ·  demo: /`);
    if (boot.created && adminPass === 'sorted-admin') console.log(`Administrator ${boot.username} / sorted-admin  (set SORTED_ADMIN_PASSWORD to change it)`);
    else if (boot.created) console.log(`Administrator ${boot.username} created from SORTED_ADMIN_PASSWORD`);
    if (demoUsers.length) console.log(`Demo sign-in (password sorted-<role>): ${demoUsers.join(', ')}`);
  });
  const stop = () => { clearInterval(tick); server.close(); store.close(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (require.main === module) main();

module.exports = { createServer };
