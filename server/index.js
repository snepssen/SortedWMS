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

const ROOT = path.join(__dirname, '..');

function createServer({ store, printers, token = process.env.SORTED_TOKEN || null }) {
  const api = createApi({ store, printers });
  const pages = {
    '/': 'index.html', '/index.html': 'index.html',
    '/handheld': 'server/public/handheld.html', '/admin': 'server/public/admin.html', '/card': 'server/public/card.html', '/card.html': 'server/public/card.html',
    '/keys': 'server/public/keys.html', '/keys.html': 'server/public/keys.html',
    '/src/engine.js': 'src/engine.js', '/src/gs1.js': 'src/gs1.js', '/src/labels.js': 'src/labels.js', '/src/barcode.js': 'src/barcode.js',
  };
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (status, body, type = 'application/json; charset=utf-8') => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
    };
    if (req.method === 'GET' && pages[url.pathname]) {
      const file = path.join(ROOT, pages[url.pathname]);
      return send(200, fs.readFileSync(file), types[path.extname(file)]);
    }
    if (!url.pathname.startsWith('/api/')) return send(404, { error: 'Not found' });
    if (token && req.headers['x-token'] !== token && url.searchParams.get('token') !== token) return send(401, { error: 'Token required' });

    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 5e6) req.destroy(); });
    req.on('end', () => {
      let body;
      try { body = raw ? JSON.parse(raw) : {}; } catch (e) { return send(400, { error: 'Body is not JSON' }); }
      const by = String(req.headers['x-operator'] || body.by || url.pathname.split('/')[3] || 'office').slice(0, 40);
      const out = api.handle(req.method, req.url, body, by);
      send(out.status, out.body);
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
  if (process.argv.includes('--seed-demo') && !Object.keys(store.wh.pallets).length) {
    const { seedDemo } = require('./seed');
    console.log(seedDemo(store));
  }
  const server = createServer({ store, printers });
  const tick = setInterval(() => { try { store.tick(); printers.flush(store.wh.printQueue); } catch (e) { console.error('tick', e); } }, 10000);
  const port = Number(process.env.PORT || 8080);
  server.listen(port, () => console.log(`SortedWMS on http://localhost:${port}  ·  handheld: /handheld  ·  office: /admin  ·  demo: /`));
  const stop = () => { clearInterval(tick); server.close(); store.close(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (require.main === module) main();

module.exports = { createServer };
