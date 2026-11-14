/*
 * Shopify Admin API, on top of the existing intake and message log.
 * No packages: Node https and crypto. Credentials stay in a file beside
 * the database and are never returned. See docs/connectors/SHOPIFY.md.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const http = require('node:http');
const { createHmac, timingSafeEqual } = require('node:crypto');

const API = '2024-10';

function verifyWebhook(raw, header, secret) {
  if (!secret || !header) return false;
  const digest = createHmac('sha256', secret).update(raw, 'utf8').digest('base64');
  const a = Buffer.from(digest);
  const b = Buffer.from(String(header));
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function availableQty(wh, itemNo, buffer) {
  const row = typeof wh.availability === 'function' ? wh.availability().find((r) => r.itemNo === itemNo) : null;
  const available = row ? Number(row.available) || 0 : 0;
  return Math.max(0, available - (Number(buffer) || 0));
}

function suggestItem(wh, sku, barcode) {
  const key = String(sku || '').trim();
  if (key && wh.items[key]) return key;
  const bySku = key && wh.findItem ? wh.findItem(key) : null;
  if (bySku) return bySku.itemNo;
  const code = String(barcode || '').trim();
  const byCode = code && wh.findItem ? wh.findItem(code) : null;
  return byCode ? byCode.itemNo : null;
}

async function withBackoff(run, { sleep, baseMs = 200, max = 5, onWait = () => {} } = {}) {
  let delay = baseMs;
  let last;
  for (let attempt = 0; attempt < max; attempt++) {
    last = await run();
    if (last.status !== 429 && last.status !== 503) return last;
    const header = Number(last.headers && (last.headers['retry-after'] || last.headers['Retry-After']));
    const wait = Number.isFinite(header) && header > 0 ? header * 1000 : delay;
    onWait(wait, attempt);
    await sleep(wait);
    delay = Math.min(delay * 2, 60000);
  }
  const err = new Error('Shopify asked us to slow down');
  err.response = last;
  throw err;
}

function httpRequest({ method, url, headers, body, timeoutMs = 15000 }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({
      method, hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: `${u.pathname}${u.search}`, headers, timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Shopify did not answer in time')); });
    req.on('error', (err) => reject(new Error(err.message || 'Shopify connection failed')));
    if (body) req.write(body);
    req.end();
  });
}

function createShopify({ store, secretsFile = undefined, transport = null, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), debounceMs = 2000, log = () => {}, now = null } = {}) {
  if (!store || !store.db) throw new Error('Shopify needs the warehouse database');
  const clock = typeof now === 'function' ? now : () => Date.now();
  const secretsPath = secretsFile === undefined
    ? (store.file && store.file !== ':memory:' ? path.join(path.dirname(store.file), 'shopify-secrets.json') : null)
    : secretsFile;
  let memorySecrets = { shops: {} };
  const pendingStock = new Map();
  let stockTimer = null;
  let schedule = (fn, ms) => {
    const timer = setTimeout(fn, ms);
    if (timer.unref) timer.unref();
    return timer;
  };

  function ensure() {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS shopify_shops (
        id TEXT PRIMARY KEY, site TEXT NOT NULL, client_id TEXT, name TEXT NOT NULL,
        shop TEXT NOT NULL, location_id TEXT, buffer INTEGER NOT NULL DEFAULT 0,
        poll_minutes INTEGER NOT NULL DEFAULT 15, active INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS shopify_map (
        shop_id TEXT NOT NULL, sku TEXT NOT NULL, item_no TEXT NOT NULL,
        variant_id TEXT, inventory_item_id TEXT, PRIMARY KEY (shop_id, sku)
      );
      CREATE TABLE IF NOT EXISTS shopify_catalog (
        shop_id TEXT NOT NULL, sku TEXT NOT NULL, title TEXT, barcode TEXT,
        variant_id TEXT, inventory_item_id TEXT, PRIMARY KEY (shop_id, sku)
      );
      CREATE TABLE IF NOT EXISTS shopify_link (
        shop_id TEXT NOT NULL, external_id TEXT NOT NULL, ref TEXT NOT NULL, order_id TEXT,
        PRIMARY KEY (shop_id, external_id)
      );
      CREATE TABLE IF NOT EXISTS shopify_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT, site TEXT NOT NULL, shop_id TEXT,
        t INTEGER NOT NULL, ok INTEGER NOT NULL, action TEXT NOT NULL, summary TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS shopify_stock (
        shop_id TEXT NOT NULL, item_no TEXT NOT NULL, qty INTEGER, pushed_at INTEGER,
        PRIMARY KEY (shop_id, item_no)
      );
      CREATE TABLE IF NOT EXISTS shopify_meta (site TEXT NOT NULL, key TEXT NOT NULL, value TEXT, PRIMARY KEY (site, key));
    `);
  }
  ensure();

  function siteId() { return String(store.siteId || 'MAIN').toUpperCase(); }
  function warehouse() {
    try { return store.warehouse ? store.warehouse(siteId()) : store.wh; } catch (e) { return store.wh; }
  }
  function loadSecrets() {
    if (!secretsPath) return { shops: { ...(memorySecrets.shops || {}) } };
    if (!fs.existsSync(secretsPath)) return { shops: {} };
    try { return { shops: JSON.parse(fs.readFileSync(secretsPath, 'utf8')).shops || {} }; }
    catch (e) { throw new Error('The Shopify secrets file could not be read'); }
  }
  function writeSecrets(data) {
    const clean = { shops: data.shops || {} };
    if (!secretsPath) { memorySecrets = clean; return; }
    fs.mkdirSync(path.dirname(secretsPath), { recursive: true });
    const tmp = `${secretsPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(clean), { mode: 0o600 });
    fs.renameSync(tmp, secretsPath);
    try { fs.chmodSync(secretsPath, 0o600); } catch (e) { /* mode is best-effort */ }
  }
  function redact(text) {
    let out = String(text || '');
    for (const row of Object.values(loadSecrets().shops || {})) {
      for (const value of [row.token, row.webhookSecret]) {
        if (value && String(value).length >= 4) out = out.split(String(value)).join('***');
      }
    }
    return out;
  }
  function journal(shopId, ok, action, summary) {
    const safe = redact(summary).slice(0, 500);
    store.db.prepare('INSERT INTO shopify_log (site, shop_id, t, ok, action, summary) VALUES (?, ?, ?, ?, ?, ?)').run(siteId(), shopId || null, clock(), ok ? 1 : 0, action, safe);
    if (!ok) raise(safe);
    return safe;
  }
  function raise(summary) {
    let mod = null;
    try { mod = require('../modules/registry').get('alerts'); } catch (e) { return; }
    const wh = warehouse();
    if (!mod || typeof mod.raise !== 'function') return;
    if (wh && typeof wh.module === 'function' && !wh.module('alerts')) return;
    try { mod.raise(store, { type: 'shop.sync', summary, site: siteId(), at: clock() }); }
    catch (e) { /* the alerts module may not know this type yet; the log row stays */ }
  }

  function shops() {
    return store.db.prepare('SELECT * FROM shopify_shops WHERE site = ? ORDER BY id').all(siteId());
  }
  function shopOrThrow(id) {
    const row = store.db.prepare('SELECT * FROM shopify_shops WHERE id = ? AND site = ?').get(id, siteId());
    if (!row) throw new Error('Unknown Shopify shop');
    return row;
  }
  function secretOf(id) { return (loadSecrets().shops || {})[id] || {}; }

  function publicShop(row) {
    const sec = secretOf(row.id);
    const last = store.db.prepare('SELECT t, ok, action, summary FROM shopify_log WHERE shop_id = ? ORDER BY id DESC LIMIT 1').get(row.id);
    return {
      id: row.id, name: row.name, shop: row.shop, clientId: row.client_id || null,
      locationId: row.location_id || null, buffer: row.buffer, pollMinutes: row.poll_minutes,
      active: Boolean(row.active), tokenSet: Boolean(sec.token), webhookSecretSet: Boolean(sec.webhookSecret),
      last: last ? { at: last.t, ok: Boolean(last.ok), action: last.action, summary: last.summary } : null,
    };
  }

  function saveShop(input = {}) {
    const id = String(input.id || '').trim().toLowerCase();
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(id)) throw new Error('A shop id uses lowercase letters, digits or hyphens');
    const shop = String(input.shop || '').trim().replace(/^https?:\/\//, '').replace(/\/$/, '');
    if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(shop)) throw new Error('The shop address looks like example.myshopify.com');
    const name = String(input.name || shop).trim().slice(0, 80);
    const clientId = input.clientId ? String(input.clientId).trim().toUpperCase() : null;
    const buffer = Number(input.buffer == null ? 0 : input.buffer);
    if (!Number.isInteger(buffer) || buffer < 0 || buffer > 100000) throw new Error('The stock buffer is a whole number from 0');
    const poll = Number(input.pollMinutes == null ? 15 : input.pollMinutes);
    if (!Number.isInteger(poll) || poll < 1 || poll > 1440) throw new Error('Polling is a whole number of minutes');
    const secrets = loadSecrets();
    const prev = secrets.shops[id] || {};
    const token = String(input.token || '') || prev.token;
    const webhookSecret = String(input.webhookSecret || '') || prev.webhookSecret;
    if (!token) throw new Error('A Shopify access token is required');
    secrets.shops[id] = { token, webhookSecret: webhookSecret || null };
    store.db.prepare(`INSERT INTO shopify_shops (id, site, client_id, name, shop, location_id, buffer, poll_minutes, active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, shop = excluded.shop, client_id = excluded.client_id,
        location_id = excluded.location_id, buffer = excluded.buffer, poll_minutes = excluded.poll_minutes`).run(
      id, siteId(), clientId, name, shop, input.locationId ? String(input.locationId) : null, buffer, poll,
    );
    writeSecrets(secrets);
    return publicShop(shopOrThrow(id));
  }

  function mapSku(shopId, sku, itemNo, extra = {}) {
    shopOrThrow(shopId);
    const wh = warehouse();
    if (!wh.items[itemNo]) throw new Error(`Unknown item ${itemNo}`);
    const key = String(sku || '').trim();
    if (!key) throw new Error('A shop SKU is required');
    store.db.prepare(`INSERT INTO shopify_map (shop_id, sku, item_no, variant_id, inventory_item_id) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(shop_id, sku) DO UPDATE SET item_no = excluded.item_no, variant_id = excluded.variant_id, inventory_item_id = excluded.inventory_item_id`)
      .run(shopId, key, itemNo, extra.variantId ? String(extra.variantId) : null, extra.inventoryItemId ? String(extra.inventoryItemId) : null);
    return { shopId, sku: key, itemNo };
  }

  function itemFor(shopId, sku, barcode) {
    const mapped = store.db.prepare('SELECT item_no, variant_id, inventory_item_id FROM shopify_map WHERE shop_id = ? AND sku = ?').get(shopId, sku);
    if (mapped) return mapped;
    const guessed = suggestItem(warehouse(), sku, barcode);
    return guessed ? { item_no: guessed, variant_id: null, inventory_item_id: null, guessed: true } : null;
  }

  function orderDoc(shop, order) {
    const lines = (order.line_items || []).map((line, i) => {
      const sku = line.sku || '';
      const hit = itemFor(shop.id, sku, line.barcode);
      if (!hit) throw new Error(`Line ${i + 1}: no item for SKU ${sku || '(blank)'}`);
      return { itemNo: hit.item_no, units: Number(line.quantity) || 0 };
    });
    const name = (order.shipping_address && order.shipping_address.name) || order.email || 'Shopify customer';
    return {
      type: 'order',
      ref: `shopify-${shop.id}-${order.id}`.slice(0, 60),
      customer: String(name).slice(0, 80),
      clientId: shop.client_id || null,
      lines,
    };
  }

  function wanted(order) {
    const paid = order.financial_status === 'paid' || order.financial_status === 'partially_paid';
    const open = !order.fulfillment_status || order.fulfillment_status === 'partial' || order.fulfillment_status === null;
    return paid && open && order.cancelled_at == null;
  }

  function takeOrder(shop, order) {
    if (!wanted(order)) return { status: 'skipped', id: order.id };
    const doc = orderDoc(shop, order);
    const result = store.exec('intake', { doc }, 'shopify');
    store.db.prepare('INSERT INTO shopify_link (shop_id, external_id, ref, order_id) VALUES (?, ?, ?, ?) ON CONFLICT(shop_id, external_id) DO UPDATE SET order_id = excluded.order_id')
      .run(shop.id, String(order.id), doc.ref, result.id);
    return result;
  }

  async function callShop(shop, pathName, { method = 'GET', json = null } = {}) {
    const sec = secretOf(shop.id);
    const url = `https://${shop.shop}/admin/api/${API}${pathName}`;
    const headers = { 'x-shopify-access-token': sec.token, accept: 'application/json' };
    let body = null;
    if (json) { body = Buffer.from(JSON.stringify(json)); headers['content-type'] = 'application/json'; }
    const run = () => (transport || httpRequest)({ method, url, headers, body });
    const res = await withBackoff(run, { sleep, onWait: (wait) => journal(shop.id, false, 'rate-limit', `Waiting ${wait} ms`) });
    if (res.status < 200 || res.status >= 300) throw new Error(`Shopify answered HTTP ${res.status}`);
    const text = Buffer.isBuffer(res.body) ? res.body.toString('utf8') : String(res.body || '');
    return text ? JSON.parse(text) : {};
  }

  async function pull(shopId) {
    const shop = shopOrThrow(shopId);
    try {
      const page = await callShop(shop, '/orders.json?status=open&financial_status=paid&limit=50');
      const orders = page.orders || [];
      let created = 0; let duplicate = 0; let skipped = 0;
      for (const order of orders) {
        const result = takeOrder(shop, order);
        if (result.status === 'created') created++;
        else if (result.status === 'duplicate') duplicate++;
        else skipped++;
      }
      return journal(shop.id, true, 'import', `Imported ${created}, already had ${duplicate}, skipped ${skipped}`);
    } catch (e) {
      journal(shop.id, false, 'import', e.message);
      throw new Error(redact(e.message));
    }
  }

  async function pullProducts(shopId) {
    const shop = shopOrThrow(shopId);
    const page = await callShop(shop, '/products.json?limit=50');
    const stmt = store.db.prepare(`INSERT INTO shopify_catalog (shop_id, sku, title, barcode, variant_id, inventory_item_id) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(shop_id, sku) DO UPDATE SET title = excluded.title, barcode = excluded.barcode, variant_id = excluded.variant_id, inventory_item_id = excluded.inventory_item_id`);
    let n = 0;
    for (const product of page.products || []) {
      for (const variant of product.variants || []) {
        if (!variant.sku) continue;
        stmt.run(shop.id, variant.sku, product.title || '', variant.barcode || '', String(variant.id), String(variant.inventory_item_id || ''));
        const guess = suggestItem(warehouse(), variant.sku, variant.barcode);
        if (guess && !store.db.prepare('SELECT sku FROM shopify_map WHERE shop_id = ? AND sku = ?').get(shop.id, variant.sku)) {
          mapSku(shop.id, variant.sku, guess, { variantId: variant.id, inventoryItemId: variant.inventory_item_id });
        }
        n++;
      }
    }
    journal(shop.id, true, 'catalog', `Read ${n} SKUs`);
    return n;
  }

  function mappings(shopId) {
    shopOrThrow(shopId);
    const catalog = store.db.prepare('SELECT sku, title, barcode, variant_id, inventory_item_id FROM shopify_catalog WHERE shop_id = ? ORDER BY sku').all(shopId);
    const maps = Object.fromEntries(store.db.prepare('SELECT sku, item_no FROM shopify_map WHERE shop_id = ?').all(shopId).map((r) => [r.sku, r.item_no]));
    return catalog.map((row) => ({
      sku: row.sku, title: row.title, barcode: row.barcode, variantId: row.variant_id, inventoryItemId: row.inventory_item_id,
      itemNo: maps[row.sku] || null,
      suggestion: maps[row.sku] ? null : suggestItem(warehouse(), row.sku, row.barcode),
    }));
  }

  function queueStock(itemNo) {
    const wh = warehouse();
    if (!wh.items[itemNo]) return;
    pendingStock.set(itemNo, true);
    if (stockTimer) return;
    stockTimer = schedule(() => { stockTimer = null; return flushStock().catch((e) => log(redact(e.message))); }, debounceMs);
  }

  async function flushStock() {
    const items = [...pendingStock.keys()];
    pendingStock.clear();
    for (const shop of shops()) {
      if (!shop.active || !shop.location_id) continue;
      for (const itemNo of items) {
        const qty = availableQty(warehouse(), itemNo, shop.buffer);
        const prev = store.db.prepare('SELECT qty FROM shopify_stock WHERE shop_id = ? AND item_no = ?').get(shop.id, itemNo);
        if (prev && prev.qty === qty) continue;
        const maps = store.db.prepare('SELECT inventory_item_id FROM shopify_map WHERE shop_id = ? AND item_no = ? AND inventory_item_id IS NOT NULL').all(shop.id, itemNo);
        for (const map of maps) {
          await callShop(shop, '/inventory_levels/set.json', { method: 'POST', json: { location_id: Number(shop.location_id), inventory_item_id: Number(map.inventory_item_id), available: qty } });
        }
        if (maps.length) {
          store.db.prepare('INSERT INTO shopify_stock (shop_id, item_no, qty, pushed_at) VALUES (?, ?, ?, ?) ON CONFLICT(shop_id, item_no) DO UPDATE SET qty = excluded.qty, pushed_at = excluded.pushed_at').run(shop.id, itemNo, qty, clock());
          journal(shop.id, true, 'stock', `${itemNo} available ${qty}`);
        }
      }
    }
  }

  async function pushFulfilment(message) {
    const data = message.data || {};
    const order = warehouse().orders && warehouse().orders[data.orderId];
    const ref = (order && order.ref) || data.ref || '';
    const link = store.db.prepare('SELECT shop_id, external_id FROM shopify_link WHERE ref = ?').get(ref);
    if (!link) return null;
    const shop = shopOrThrow(link.shop_id);
    const tracking = (order && order.tracking) || data.tracking || null;
    const carrier = (order && order.carrierName) || data.carrier || null;
    await callShop(shop, `/orders/${link.external_id}/fulfillments.json`, {
      method: 'POST',
      json: { fulfillment: { tracking_number: tracking, tracking_company: carrier, notify_customer: true } },
    });
    return journal(shop.id, true, 'fulfil', `${data.orderId} tracking ${tracking || 'none'}`);
  }

  function acceptWebhook(shopId, raw, header) {
    const shop = shopOrThrow(shopId);
    const sec = secretOf(shop.id);
    if (!verifyWebhook(raw, header, sec.webhookSecret)) {
      journal(shop.id, false, 'webhook', 'Signature did not match');
      const err = new Error('Shopify signature did not match');
      err.status = 401;
      throw err;
    }
    const order = JSON.parse(raw);
    const result = takeOrder(shop, order.order || order);
    journal(shop.id, true, 'webhook', `${result.status} ${order.id || (order.order && order.order.id) || ''}`);
    return result;
  }

  function status() {
    return {
      shops: shops().map(publicShop),
      errors: store.db.prepare('SELECT t, shop_id, action, summary FROM shopify_log WHERE site = ? AND ok = 0 ORDER BY id DESC LIMIT 20').all(siteId()).map((r) => ({ at: r.t, shopId: r.shop_id, action: r.action, summary: r.summary })),
    };
  }

  function onCommand(op) {
    if (op === 'intake' || op === 'noteTracking' || op === 'enableDemandReplenishment') return;
    const wh = warehouse();
    if (!wh || typeof wh.module === 'function' && !wh.module('shopify')) return;
    for (const itemNo of Object.keys(wh.items || {})) queueStock(itemNo);
  }

  function start() {
    const timer = setInterval(() => {
      for (const shop of shops()) {
        if (!shop.active) continue;
        const key = `poll:${shop.id}`;
        const row = store.db.prepare('SELECT value FROM shopify_meta WHERE site = ? AND key = ?').get(siteId(), key);
        const last = row ? Number(row.value) : 0;
        if (clock() - last < shop.poll_minutes * 60000) continue;
        store.db.prepare('INSERT INTO shopify_meta (site, key, value) VALUES (?, ?, ?) ON CONFLICT(site, key) DO UPDATE SET value = excluded.value').run(siteId(), key, String(clock()));
        pull(shop.id).catch((e) => log(redact(e.message)));
      }
      const wh = warehouse();
      if (!wh || typeof wh.messageLog !== 'function') return;
      const cursorKey = 'message-cursor';
      const cur = store.db.prepare('SELECT value FROM shopify_meta WHERE site = ? AND key = ?').get(siteId(), cursorKey);
      let after = cur ? Number(cur.value) : 0;
      const page = wh.messageLog({ after, limit: 100, type: 'order.shipped' });
      for (const message of page.messages) pushFulfilment(message).catch((e) => journal(null, false, 'fulfil', e.message));
      if (page.next && page.next !== after) store.db.prepare('INSERT INTO shopify_meta (site, key, value) VALUES (?, ?, ?) ON CONFLICT(site, key) DO UPDATE SET value = excluded.value').run(siteId(), cursorKey, String(page.next));
    }, 15000);
    if (timer.unref) timer.unref();
    return () => clearInterval(timer);
  }

  return {
    status, saveShop, mapSku, mappings, pull, pullProducts, takeOrder, acceptWebhook, flushStock, queueStock, pushFulfilment, onCommand, start, verifyWebhook, availableQty, suggestItem, withBackoff,
    _setSchedule(fn) { schedule = fn; },
  };
}

module.exports = { createShopify, verifyWebhook, availableQty, suggestItem, withBackoff };
