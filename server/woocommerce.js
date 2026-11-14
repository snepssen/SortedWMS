/*
 * WooCommerce REST API, on top of the existing intake and message log.
 * No packages: Node https and crypto. Credentials stay in a file beside
 * the database and are never returned. See docs/connectors/WOOCOMMERCE.md.
 */
'use strict';

const { createShopWorker } = require('./shop-worker');
const { shopPages } = require('./shop-pages');

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const { createHmac, timingSafeEqual } = require('node:crypto');

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

function barcodeOf(row) {
  if (!row) return '';
  if (row.barcode) return String(row.barcode);
  if (row.global_unique_id) return String(row.global_unique_id);
  const meta = (row.meta_data || []).find((m) => /barcode|gtin|ean/i.test(String(m.key || '')));
  return meta ? String(meta.value || '') : '';
}

function shopOrigin(input) {
  let url;
  try { url = new URL(String(input || '').trim()); } catch (e) { url = null; }
  if (!url || url.protocol !== 'https:' || url.username || url.password || (url.pathname && url.pathname !== '/') || url.search || url.hash) {
    throw new Error('The shop address looks like https://shop.example.com');
  }
  return url.origin;
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
  const err = new Error('WooCommerce asked us to slow down');
  err.response = last;
  throw err;
}

function httpRequest({ method, url, headers, body, timeoutMs = 15000 }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      method, hostname: u.hostname, port: u.port || 443,
      path: `${u.pathname}${u.search}`, headers, timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('WooCommerce did not answer in time')); });
    req.on('error', (err) => reject(new Error(err.message || 'WooCommerce connection failed')));
    if (body) req.write(body);
    req.end();
  });
}

function createWoo({ store, secretsFile = undefined, transport = null, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), debounceMs = 2000, log = () => {}, now = null } = {}) {
  if (!store || !store.db) throw new Error('WooCommerce needs the warehouse database');
  const clock = typeof now === 'function' ? now : () => Date.now();
  const secretsPath = secretsFile === undefined
    ? (store.file && store.file !== ':memory:' ? path.join(path.dirname(store.file), 'woocommerce-secrets.json') : null)
    : secretsFile;
  let memorySecrets = { shops: {} };
  let schedule = (fn) => {
    const t = setTimeout(fn, debounceMs);
    if (t.unref) t.unref();
    return t;
  };
  const pendingStock = new Map();
  let stockTimer = null;

  function siteId() { return store.siteId || 'MAIN'; }
  function warehouse() { return store.warehouse(siteId()); }

  function loadSecrets() {
    if (!secretsPath) return { shops: { ...(memorySecrets.shops || {}) } };
    if (!fs.existsSync(secretsPath)) return { shops: {} };
    try { return { shops: JSON.parse(fs.readFileSync(secretsPath, 'utf8')).shops || {} }; }
    catch (e) { return { shops: {} }; }
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
      for (const value of [row.key, row.secret, row.webhookSecret]) {
        if (value && String(value).length >= 4) out = out.split(String(value)).join('***');
      }
    }
    return out;
  }
  function journal(shopId, ok, action, summary) {
    const safe = redact(summary);
    const prev = shopId ? store.db.prepare('SELECT ok FROM woo_log WHERE shop_id = ? ORDER BY id DESC LIMIT 1').get(shopId) : null;
    store.db.prepare('INSERT INTO woo_log (site, shop_id, t, ok, action, summary) VALUES (?, ?, ?, ?, ?, ?)').run(siteId(), shopId, clock(), ok ? 1 : 0, action, safe);
    if (!ok) raise(safe);
    else if (prev && !prev.ok) raise(`Recovered: ${safe}`);
    return { ok: Boolean(ok), action, summary: safe };
  }
  function raise(summary) {
    let mod;
    try { mod = require('../modules/registry').get('alerts'); } catch (e) { return; }
    const wh = warehouse();
    if (!mod || typeof mod.raise !== 'function') return;
    if (wh && typeof wh.module === 'function' && !wh.module('alerts')) return;
    try { mod.raise(store, { type: 'shop.sync', summary, site: siteId(), at: clock() }); }
    catch (e) { /* the alerts module may not know this type yet; the log row stays */ }
  }
  function shops() {
    return store.db.prepare('SELECT * FROM woo_shops WHERE site = ? ORDER BY id').all(siteId());
  }
  function shopOrThrow(id) {
    const row = store.db.prepare('SELECT * FROM woo_shops WHERE id = ? AND site = ?').get(id, siteId());
    if (!row) throw new Error('Unknown WooCommerce shop');
    return row;
  }
  function secretOf(id) { return (loadSecrets().shops || {})[id] || {}; }
  function publicShop(row) {
    const sec = secretOf(row.id);
    const last = store.db.prepare('SELECT t, ok, action, summary FROM woo_log WHERE shop_id = ? ORDER BY id DESC LIMIT 1').get(row.id);
    return {
      id: row.id, name: row.name, shop: row.shop, clientId: row.client_id || null,
      buffer: row.buffer, pollMinutes: row.poll_minutes,
      active: Boolean(row.active), keySet: Boolean(sec.key), secretSet: Boolean(sec.secret), webhookSecretSet: Boolean(sec.webhookSecret),
      last: last ? { at: last.t, ok: Boolean(last.ok), action: last.action, summary: last.summary } : null,
    };
  }

  function saveShop(input = {}) {
    const id = String(input.id || '').trim().toLowerCase();
    const existingSite = store.db.prepare('SELECT site FROM woo_shops WHERE id = ?').get(id);
    if (existingSite && existingSite.site !== siteId()) throw new Error('That shop ID belongs to another warehouse');
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(id)) throw new Error('A shop id uses lowercase letters, digits or hyphens');
    const shop = shopOrigin(input.shop);
    const name = String(input.name || shop).trim().slice(0, 80);
    const clientId = input.clientId ? String(input.clientId).trim().toUpperCase() : null;
    const buffer = Number(input.buffer == null ? 0 : input.buffer);
    if (!Number.isInteger(buffer) || buffer < 0 || buffer > 100000) throw new Error('The stock buffer is a whole number from 0');
    const poll = Number(input.pollMinutes == null ? 15 : input.pollMinutes);
    if (!Number.isInteger(poll) || poll < 1 || poll > 1440) throw new Error('Polling is a whole number of minutes');
    const secrets = loadSecrets();
    const prev = secrets.shops[id] || {};
    const key = String(input.consumerKey || input.key || '') || prev.key;
    const secret = String(input.consumerSecret || input.secret || '') || prev.secret;
    const webhookSecret = String(input.webhookSecret || '') || prev.webhookSecret;
    if (!key || !secret) throw new Error('A WooCommerce consumer key and secret are required');
    secrets.shops[id] = { key, secret, webhookSecret: webhookSecret || null };
    store.db.prepare(`INSERT INTO woo_shops (id, site, client_id, name, shop, buffer, poll_minutes, active)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, shop = excluded.shop, client_id = excluded.client_id,
        buffer = excluded.buffer, poll_minutes = excluded.poll_minutes`).run(id, siteId(), clientId, name, shop, buffer, poll);
    writeSecrets(secrets);
    return publicShop(shopOrThrow(id));
  }

  function mapSku(shopId, sku, itemNo, extra = {}) {
    shopOrThrow(shopId);
    const wh = warehouse();
    if (!wh.items[itemNo]) throw new Error(`Unknown item ${itemNo}`);
    const key = String(sku || '').trim();
    if (!key) throw new Error('A shop SKU is required');
    store.db.prepare(`INSERT INTO woo_map (shop_id, sku, item_no, product_id, variation_id) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(shop_id, sku) DO UPDATE SET item_no = excluded.item_no, product_id = excluded.product_id, variation_id = excluded.variation_id`)
      .run(shopId, key, itemNo, extra.productId ? String(extra.productId) : null, extra.variationId ? String(extra.variationId) : null);
    return { shopId, sku: key, itemNo };
  }

  function itemFor(shopId, sku, barcode) {
    const mapped = store.db.prepare('SELECT item_no, product_id, variation_id FROM woo_map WHERE shop_id = ? AND sku = ?').get(shopId, sku);
    if (mapped) return mapped;
    const guessed = suggestItem(warehouse(), sku, barcode);
    return guessed ? { item_no: guessed, product_id: null, variation_id: null, guessed: true } : null;
  }

  function orderDoc(shop, order) {
    const lines = (order.line_items || []).map((line, i) => {
      const sku = line.sku || '';
      const hit = itemFor(shop.id, sku, barcodeOf(line));
      if (!hit) throw new Error(`Line ${i + 1}: no item for SKU ${sku || '(blank)'}`);
      return { itemNo: hit.item_no, units: Number(line.quantity) || 0 };
    });
    const bill = order.billing || {};
    const name = [bill.first_name, bill.last_name].filter(Boolean).join(' ') || bill.email || 'WooCommerce customer';
    return {
      type: 'order',
      ref: `woo-${shop.id}-${order.id}`.slice(0, 60),
      customer: String(name).slice(0, 80),
      clientId: shop.client_id || null,
      lines,
    };
  }

  function wanted(order) {
    return order && order.status === 'processing';
  }

  function takeOrder(shop, order) {
    if (!wanted(order)) return { status: 'skipped', id: order.id };
    const doc = orderDoc(shop, order);
    const result = store.exec('intake', { doc }, 'woocommerce');
    store.db.prepare('INSERT INTO woo_link (shop_id, external_id, ref, order_id) VALUES (?, ?, ?, ?) ON CONFLICT(shop_id, external_id) DO UPDATE SET order_id = excluded.order_id')
      .run(shop.id, String(order.id), doc.ref, result.id);
    return result;
  }

  async function callShop(shop, pathName, { method = 'GET', json = null, response = false } = {}) {
    const sec = secretOf(shop.id);
    const url = `${shop.shop}/wp-json/wc/v3${pathName}`;
    const headers = { authorization: `Basic ${Buffer.from(`${sec.key}:${sec.secret}`).toString('base64')}`, accept: 'application/json' };
    let body = null;
    if (json) { body = Buffer.from(JSON.stringify(json)); headers['content-type'] = 'application/json'; }
    const run = () => (transport || httpRequest)({ method, url, headers, body });
    const res = await withBackoff(run, { sleep, onWait: (wait) => journal(shop.id, false, 'rate-limit', `Waiting ${wait} ms`) });
    if (res.status < 200 || res.status >= 300) throw new Error(`WooCommerce answered HTTP ${res.status}`);
    const text = Buffer.isBuffer(res.body) ? res.body.toString('utf8') : String(res.body || '');
    const data = text ? JSON.parse(text) : {};
    return response ? { data, headers: res.headers } : data;
  }

  async function pull(shopId) {
    const shop = shopOrThrow(shopId);
    try {
      let created = 0; let duplicate = 0; let skipped = 0;
      for await (const orders of shopPages({
        load: (path) => callShop(shop, path, { response: true }), path: '/orders?status=processing&per_page=50',
        rows: (data) => Array.isArray(data) ? data : data.orders || [], mode: 'page',
      })) for (const order of orders) {
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

  async function rememberProduct(shop, product, variation) {
    const row = variation || product;
    const sku = row.sku;
    if (!sku) return 0;
    const barcode = barcodeOf(row) || barcodeOf(product);
    store.db.prepare(`INSERT INTO woo_catalog (shop_id, sku, title, barcode, product_id, variation_id) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(shop_id, sku) DO UPDATE SET title = excluded.title, barcode = excluded.barcode, product_id = excluded.product_id, variation_id = excluded.variation_id`)
      .run(shop.id, sku, row.name || product.name || '', barcode, String(variation ? product.id : product.id), variation ? String(variation.id) : null);
    const guess = suggestItem(warehouse(), sku, barcode);
    if (guess && !store.db.prepare('SELECT sku FROM woo_map WHERE shop_id = ? AND sku = ?').get(shop.id, sku)) {
      mapSku(shop.id, sku, guess, { productId: product.id, variationId: variation ? variation.id : null });
    }
    return 1;
  }

  async function pullProducts(shopId) {
    const shop = shopOrThrow(shopId);
    let n = 0;
    for await (const products of shopPages({
      load: (path) => callShop(shop, path, { response: true }), path: '/products?per_page=50',
      rows: (data) => Array.isArray(data) ? data : data.products || [], mode: 'page',
    })) for (const product of products) {
      if (product.type === 'variable') {
        for await (const variations of shopPages({
          load: (path) => callShop(shop, path, { response: true }), path: `/products/${product.id}/variations?per_page=50`,
          rows: (data) => Array.isArray(data) ? data : data.variations || [], mode: 'page',
        })) for (const variation of variations) n += await rememberProduct(shop, product, variation);
      } else n += await rememberProduct(shop, product, null);
    }
    journal(shop.id, true, 'catalog', `Read ${n} SKUs`);
    return n;
  }

  function mappings(shopId) {
    shopOrThrow(shopId);
    const catalog = store.db.prepare('SELECT sku, title, barcode, product_id, variation_id FROM woo_catalog WHERE shop_id = ? ORDER BY sku').all(shopId);
    const maps = Object.fromEntries(store.db.prepare('SELECT sku, item_no FROM woo_map WHERE shop_id = ?').all(shopId).map((r) => [r.sku, r.item_no]));
    return catalog.map((row) => ({
      sku: row.sku, title: row.title, barcode: row.barcode, productId: row.product_id, variationId: row.variation_id,
      itemNo: maps[row.sku] || null,
      suggestion: maps[row.sku] ? null : suggestItem(warehouse(), row.sku, row.barcode),
    }));
  }

  function queueStock(itemNo) {
    const wh = warehouse();
    if (!wh.items[itemNo]) return;
    const site = siteId();
    const items = pendingStock.get(site) || new Set();
    items.add(itemNo);
    pendingStock.set(site, items);
    if (stockTimer) return;
    stockTimer = schedule(() => { stockTimer = null; return flushStock().catch((e) => log(redact(e.message))); }, debounceMs);
  }

  let stockFlushing = null;
  function flushStock() {
    if (stockFlushing) return stockFlushing;
    stockFlushing = flushBatches().finally(() => { stockFlushing = null; });
    return stockFlushing;
  }

  async function flushBatches() {
    const batches = [...pendingStock];
    pendingStock.clear();
    let failure = null;
    for (const [site, items] of batches) {
      try { await store._withSite(site, () => flushStockItems([...items])); }
      catch (e) {
        const waiting = pendingStock.get(site) || new Set();
        for (const item of items) waiting.add(item);
        pendingStock.set(site, waiting);
        failure = e;
      }
    }
    if (failure) throw failure;
  }

  async function flushStockItems(items) {
    for (const shop of shops()) {
      if (!shop.active) continue;
      for (const itemNo of items) {
        const qty = availableQty(warehouse(), itemNo, shop.buffer);
        const prev = store.db.prepare('SELECT qty FROM woo_stock WHERE shop_id = ? AND item_no = ?').get(shop.id, itemNo);
        if (prev && prev.qty === qty) continue;
        const maps = store.db.prepare('SELECT product_id, variation_id FROM woo_map WHERE shop_id = ? AND item_no = ? AND product_id IS NOT NULL').all(shop.id, itemNo);
        for (const map of maps) {
          const pathName = map.variation_id
            ? `/products/${map.product_id}/variations/${map.variation_id}`
            : `/products/${map.product_id}`;
          await callShop(shop, pathName, { method: 'PUT', json: { manage_stock: true, stock_quantity: qty } });
        }
        if (maps.length) {
          store.db.prepare('INSERT INTO woo_stock (shop_id, item_no, qty, pushed_at) VALUES (?, ?, ?, ?) ON CONFLICT(shop_id, item_no) DO UPDATE SET qty = excluded.qty, pushed_at = excluded.pushed_at').run(shop.id, itemNo, qty, clock());
          journal(shop.id, true, 'stock', `${itemNo} available ${qty}`);
        }
      }
    }
  }

  async function pushFulfilment(message) {
    const data = message.data || {};
    const order = warehouse().orders && warehouse().orders[data.orderId];
    const ref = (order && order.ref) || data.ref || '';
    const link = store.db.prepare('SELECT shop_id, external_id FROM woo_link WHERE ref = ?').get(ref);
    if (!link) return null;
    const shop = shopOrThrow(link.shop_id);
    const tracking = (order && order.tracking) || data.tracking || null;
    const carrier = (order && order.carrierName) || data.carrier || null;
    await callShop(shop, `/orders/${link.external_id}`, {
      method: 'PUT',
      json: {
        status: 'completed',
        meta_data: [
          { key: '_tracking_number', value: tracking || '' },
          { key: '_tracking_provider', value: carrier || '' },
        ],
      },
    });
    return journal(shop.id, true, 'fulfil', `${data.orderId} tracking ${tracking || 'none'}`);
  }

  function acceptWebhook(shopId, raw, header) {
    const shop = store.db.prepare('SELECT site FROM woo_shops WHERE id = ?').get(String(shopId));
    if (!shop) throw new Error('Unknown shop');
    return store._withSite(shop.site, () => {
      if (!warehouse().module('woocommerce')) throw new Error('The shop connector is switched off');
      return acceptWebhookHere(shopId, raw, header);
    });
  }

  function acceptWebhookHere(shopId, raw, header) {
    const shop = shopOrThrow(shopId);
    const sec = secretOf(shop.id);
    if (!verifyWebhook(raw, header, sec.webhookSecret)) {
      journal(shop.id, false, 'webhook', 'Signature did not match');
      const err = new Error('WooCommerce signature did not match');
      err.status = 401;
      throw err;
    }
    const order = JSON.parse(raw);
    const result = takeOrder(shop, order);
    journal(shop.id, true, 'webhook', `${result.status} ${order.id || ''}`);
    return result;
  }

  function status() {
    return {
      shops: shops().map(publicShop),
      errors: store.db.prepare('SELECT t, shop_id, action, summary FROM woo_log WHERE site = ? AND ok = 0 ORDER BY id DESC LIMIT 20').all(siteId()).map((r) => ({ at: r.t, shopId: r.shop_id, action: r.action, summary: r.summary })),
    };
  }

  function onCommand(op) {
    if (op === 'noteTracking' || op === 'enableDemandReplenishment') return;
    const wh = warehouse();
    if (!wh || typeof wh.module === 'function' && !wh.module('woocommerce')) return;
    for (const itemNo of Object.keys(wh.items || {})) queueStock(itemNo);
  }

  const worker = createShopWorker({ store, connector: 'woocommerce', metaTable: 'woo_meta',
    shops, pull, deliver: pushFulfilment, journal, now: clock });
  const start = worker.start;


  return {
    run: worker.run, status, saveShop, mapSku, mappings, pull, pullProducts, takeOrder, acceptWebhook, flushStock, queueStock, pushFulfilment, onCommand, start,
    _setSchedule(fn) { schedule = fn; },
  };
}

module.exports = { createWoo, verifyWebhook, availableQty, suggestItem, withBackoff };
