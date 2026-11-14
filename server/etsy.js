/*
 * Etsy Open API v3, on top of the existing intake and message log.
 * OAuth is PKCE: the browser comes back to this WMS. No packages.
 * Credentials stay in a file beside the database and are never returned.
 * See docs/connectors/ETSY.md.
 */
'use strict';

const { createShopWorker } = require('./shop-worker');
const { shopPages } = require('./shop-pages');

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const { createHash, createHmac, randomBytes, timingSafeEqual } = require('node:crypto');

const SCOPES = 'transactions_r transactions_w listings_r listings_w';

function verifyWebhook(raw, header, secret) {
  if (!secret || !header) return false;
  const digest = createHmac('sha256', secret).update(raw, 'utf8').digest('hex');
  const a = Buffer.from(digest);
  const b = Buffer.from(String(header).trim().toLowerCase());
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
  if (row.sku && /^\d{8,14}$/.test(String(row.sku))) return String(row.sku);
  return '';
}

function redirectUri(input) {
  let url;
  try { url = new URL(String(input || '').trim()); } catch (e) { url = null; }
  const local = url && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
  if (!url || url.username || url.password || url.search || url.hash || !url.pathname.endsWith('/api/etsy/callback')) {
    throw new Error('The redirect address must end with /api/etsy/callback');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw new Error('The redirect address must be https, or http on localhost');
  return url.origin + url.pathname;
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
  const err = new Error('Etsy asked us to slow down');
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
    req.on('timeout', () => { req.destroy(); reject(new Error('Etsy did not answer in time')); });
    req.on('error', (err) => reject(new Error(err.message || 'Etsy connection failed')));
    if (body) req.write(body);
    req.end();
  });
}

function createEtsy({ store, secretsFile = undefined, transport = null, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), debounceMs = 2000, log = () => {}, now = null } = {}) {
  if (!store || !store.db) throw new Error('Etsy needs the warehouse database');
  const clock = typeof now === 'function' ? now : () => Date.now();
  const secretsPath = secretsFile === undefined
    ? (store.file && store.file !== ':memory:' ? path.join(path.dirname(store.file), 'etsy-secrets.json') : null)
    : secretsFile;
  let memorySecrets = { shops: {}, pending: {} };
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
    if (!secretsPath) return { shops: { ...(memorySecrets.shops || {}) }, pending: { ...(memorySecrets.pending || {}) } };
    if (!fs.existsSync(secretsPath)) return { shops: {}, pending: {} };
    try {
      const parsed = JSON.parse(fs.readFileSync(secretsPath, 'utf8'));
      return { shops: parsed.shops || {}, pending: parsed.pending || {} };
    } catch (e) { return { shops: {}, pending: {} }; }
  }
  function writeSecrets(data) {
    const clean = { shops: data.shops || {}, pending: data.pending || {} };
    if (!secretsPath) { memorySecrets = clean; return; }
    fs.mkdirSync(path.dirname(secretsPath), { recursive: true });
    const tmp = `${secretsPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(clean), { mode: 0o600 });
    fs.renameSync(tmp, secretsPath);
    try { fs.chmodSync(secretsPath, 0o600); } catch (e) { /* mode is best-effort */ }
  }
  function redact(text) {
    let out = String(text || '');
    const secrets = loadSecrets();
    for (const row of Object.values(secrets.shops || {})) {
      for (const value of [row.keystring, row.sharedSecret, row.webhookSecret, row.accessToken, row.refreshToken]) {
        if (value && String(value).length >= 4) out = out.split(String(value)).join('***');
      }
    }
    for (const row of Object.values(secrets.pending || {})) {
      if (row.verifier && String(row.verifier).length >= 4) out = out.split(String(row.verifier)).join('***');
    }
    return out;
  }
  function journal(shopId, ok, action, summary) {
    const safe = redact(summary);
    const prev = shopId ? store.db.prepare('SELECT ok FROM etsy_log WHERE shop_id = ? ORDER BY id DESC LIMIT 1').get(shopId) : null;
    store.db.prepare('INSERT INTO etsy_log (site, shop_id, t, ok, action, summary) VALUES (?, ?, ?, ?, ?, ?)').run(siteId(), shopId, clock(), ok ? 1 : 0, action, safe);
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
  function shops() { return store.db.prepare('SELECT * FROM etsy_shops WHERE site = ? ORDER BY id').all(siteId()); }
  function shopOrThrow(id) {
    const row = store.db.prepare('SELECT * FROM etsy_shops WHERE id = ? AND site = ?').get(id, siteId());
    if (!row) throw new Error('Unknown Etsy shop');
    return row;
  }
  function secretOf(id) { return (loadSecrets().shops || {})[id] || {}; }
  function publicShop(row) {
    const sec = secretOf(row.id);
    const last = store.db.prepare('SELECT t, ok, action, summary FROM etsy_log WHERE shop_id = ? ORDER BY id DESC LIMIT 1').get(row.id);
    return {
      id: row.id, name: row.name, shopId: row.etsy_shop_id, redirectUri: row.redirect_uri,
      clientId: row.client_id || null, buffer: row.buffer, pollMinutes: row.poll_minutes, active: Boolean(row.active),
      keySet: Boolean(sec.keystring), secretSet: Boolean(sec.sharedSecret), webhookSecretSet: Boolean(sec.webhookSecret),
      connected: Boolean(sec.accessToken),
      last: last ? { at: last.t, ok: Boolean(last.ok), action: last.action, summary: last.summary } : null,
    };
  }

  function saveShop(input = {}) {
    const id = String(input.id || '').trim().toLowerCase();
    const existingSite = store.db.prepare('SELECT site FROM etsy_shops WHERE id = ?').get(id);
    if (existingSite && existingSite.site !== siteId()) throw new Error('That shop ID belongs to another warehouse');
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(id)) throw new Error('A shop id uses lowercase letters, digits or hyphens');
    const etsyShopId = String(input.etsyShopId || input.shopId || '').trim();
    if (!/^\d{1,20}$/.test(etsyShopId)) throw new Error('The Etsy shop id is the number from the shop URL');
    const back = redirectUri(input.redirectUri);
    const name = String(input.name || `Shop ${etsyShopId}`).trim().slice(0, 80);
    const clientId = input.clientId ? String(input.clientId).trim().toUpperCase() : null;
    const buffer = Number(input.buffer == null ? 0 : input.buffer);
    if (!Number.isInteger(buffer) || buffer < 0 || buffer > 100000) throw new Error('The stock buffer is a whole number from 0');
    const poll = Number(input.pollMinutes == null ? 15 : input.pollMinutes);
    if (!Number.isInteger(poll) || poll < 1 || poll > 1440) throw new Error('Polling is a whole number of minutes');
    const secrets = loadSecrets();
    const prev = secrets.shops[id] || {};
    const keystring = String(input.keystring || '') || prev.keystring;
    const sharedSecret = String(input.sharedSecret || '') || prev.sharedSecret;
    const webhookSecret = String(input.webhookSecret || '') || prev.webhookSecret || null;
    if (!keystring || !sharedSecret) throw new Error('An Etsy keystring and shared secret are required');
    secrets.shops[id] = {
      keystring, sharedSecret, webhookSecret,
      accessToken: prev.accessToken || null, refreshToken: prev.refreshToken || null, expiresAt: prev.expiresAt || 0,
    };
    store.db.prepare(`INSERT INTO etsy_shops (id, site, client_id, name, etsy_shop_id, redirect_uri, buffer, poll_minutes, active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, etsy_shop_id = excluded.etsy_shop_id, redirect_uri = excluded.redirect_uri,
        client_id = excluded.client_id, buffer = excluded.buffer, poll_minutes = excluded.poll_minutes`).run(
      id, siteId(), clientId, name, etsyShopId, back, buffer, poll,
    );
    writeSecrets(secrets);
    return publicShop(shopOrThrow(id));
  }

  function beginConnect(shopId) {
    const shop = shopOrThrow(shopId);
    const sec = secretOf(shop.id);
    if (!sec.keystring) throw new Error('Save the Etsy keystring first');
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const state = randomBytes(24).toString('base64url');
    const secrets = loadSecrets();
    secrets.pending[state] = { shopId: shop.id, verifier, created: clock() };
    for (const [key, row] of Object.entries(secrets.pending)) {
      if (clock() - row.created > 15 * 60 * 1000) delete secrets.pending[key];
    }
    writeSecrets(secrets);
    const url = new URL('https://www.etsy.com/oauth/connect');
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', sec.keystring);
    url.searchParams.set('redirect_uri', shop.redirect_uri);
    url.searchParams.set('scope', SCOPES);
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    return { url: url.toString() };
  }

  async function finishConnect(args = {}) {
    const pending = loadSecrets().pending[String(args.state || '')];
    const shop = pending && store.db.prepare('SELECT site FROM etsy_shops WHERE id = ?').get(pending.shopId);
    if (!shop) throw new Error('That Etsy sign-in has expired. Start it again.');
    return store._withSite(shop.site, () => finishConnectHere(args));
  }

  async function finishConnectHere({ code, state } = {}) {
    const secrets = loadSecrets();
    const pending = secrets.pending[String(state || '')];
    if (!pending || clock() - pending.created > 15 * 60 * 1000) throw new Error('That Etsy sign-in has expired. Start it again.');
    const shop = shopOrThrow(pending.shopId);
    const sec = secrets.shops[shop.id] || {};
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: sec.keystring,
      redirect_uri: shop.redirect_uri,
      code: String(code || ''),
      code_verifier: pending.verifier,
    }).toString();
    const res = await (transport || httpRequest)({
      method: 'POST', url: 'https://api.etsy.com/v3/public/oauth/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: Buffer.from(body),
    });
    delete secrets.pending[String(state)];
    if (res.status < 200 || res.status >= 300) {
      writeSecrets(secrets);
      journal(shop.id, false, 'oauth', `Etsy answered HTTP ${res.status}`);
      throw new Error('Etsy did not accept the sign-in');
    }
    const token = JSON.parse(Buffer.isBuffer(res.body) ? res.body.toString('utf8') : String(res.body || '{}'));
    secrets.shops[shop.id] = {
      ...sec,
      accessToken: token.access_token,
      refreshToken: token.refresh_token || sec.refreshToken || null,
      expiresAt: clock() + (Number(token.expires_in) || 3600) * 1000,
    };
    writeSecrets(secrets);
    journal(shop.id, true, 'oauth', 'Connected');
    return { shopId: shop.id, connected: true };
  }

  function mapSku(shopId, sku, itemNo, extra = {}) {
    shopOrThrow(shopId);
    if (!warehouse().items[itemNo]) throw new Error(`Unknown item ${itemNo}`);
    const key = String(sku || '').trim();
    if (!key) throw new Error('A shop SKU is required');
    store.db.prepare(`INSERT INTO etsy_map (shop_id, sku, item_no, listing_id, product_id) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(shop_id, sku) DO UPDATE SET item_no = excluded.item_no, listing_id = excluded.listing_id, product_id = excluded.product_id`)
      .run(shopId, key, itemNo, extra.listingId ? String(extra.listingId) : null, extra.productId ? String(extra.productId) : null);
    return { shopId, sku: key, itemNo };
  }

  function itemFor(shopId, sku, barcode) {
    const mapped = store.db.prepare('SELECT item_no FROM etsy_map WHERE shop_id = ? AND sku = ?').get(shopId, sku);
    if (mapped) return mapped;
    const guessed = suggestItem(warehouse(), sku, barcode);
    return guessed ? { item_no: guessed, guessed: true } : null;
  }

  function orderDoc(shop, receipt) {
    const lines = (receipt.transactions || []).map((line, i) => {
      const sku = line.sku || '';
      const hit = itemFor(shop.id, sku, barcodeOf(line));
      if (!hit) throw new Error(`Line ${i + 1}: no item for SKU ${sku || '(blank)'}`);
      return { itemNo: hit.item_no, units: Number(line.quantity) || 0 };
    });
    return {
      type: 'order',
      ref: `etsy-${shop.id}-${receipt.receipt_id}`.slice(0, 60),
      customer: String(receipt.name || 'Etsy buyer').slice(0, 80),
      clientId: shop.client_id || null,
      lines,
    };
  }

  function wanted(receipt) {
    return Boolean(receipt && receipt.was_paid && !receipt.was_shipped && receipt.status !== 'Canceled');
  }

  function takeOrder(shop, receipt) {
    if (!wanted(receipt)) return { status: 'skipped', id: receipt && receipt.receipt_id };
    const doc = orderDoc(shop, receipt);
    const result = store.exec('intake', { doc }, 'etsy');
    store.db.prepare('INSERT INTO etsy_link (shop_id, external_id, ref, order_id) VALUES (?, ?, ?, ?) ON CONFLICT(shop_id, external_id) DO UPDATE SET order_id = excluded.order_id')
      .run(shop.id, String(receipt.receipt_id), doc.ref, result.id);
    return result;
  }

  async function refresh(shop) {
    const secrets = loadSecrets();
    const sec = secrets.shops[shop.id] || {};
    if (!sec.refreshToken) throw new Error('Connect the Etsy shop again');
    const body = new URLSearchParams({ grant_type: 'refresh_token', client_id: sec.keystring, refresh_token: sec.refreshToken }).toString();
    const res = await (transport || httpRequest)({
      method: 'POST', url: 'https://api.etsy.com/v3/public/oauth/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: Buffer.from(body),
    });
    if (res.status < 200 || res.status >= 300) throw new Error(`Etsy answered HTTP ${res.status}`);
    const token = JSON.parse(Buffer.isBuffer(res.body) ? res.body.toString('utf8') : '{}');
    secrets.shops[shop.id] = { ...sec, accessToken: token.access_token, refreshToken: token.refresh_token || sec.refreshToken, expiresAt: clock() + (Number(token.expires_in) || 3600) * 1000 };
    writeSecrets(secrets);
  }

  async function callShop(shop, pathName, { method = 'GET', json = null, form = null, response = false } = {}) {
    let sec = secretOf(shop.id);
    if (!sec.accessToken) throw new Error('Connect the Etsy shop first');
    if (sec.expiresAt && sec.expiresAt < clock() + 60000) {
      await refresh(shop);
      sec = secretOf(shop.id);
    }
    const url = pathName.startsWith('http') ? pathName : `https://openapi.etsy.com/v3/application${pathName}`;
    const headers = {
      'x-api-key': `${sec.keystring}:${sec.sharedSecret}`,
      authorization: `Bearer ${sec.accessToken}`,
      accept: 'application/json',
    };
    let body = null;
    if (json) { body = Buffer.from(JSON.stringify(json)); headers['content-type'] = 'application/json'; }
    if (form) { body = Buffer.from(new URLSearchParams(form).toString()); headers['content-type'] = 'application/x-www-form-urlencoded'; }
    const run = () => (transport || httpRequest)({ method, url, headers, body });
    const res = await withBackoff(run, { sleep, onWait: (wait) => journal(shop.id, false, 'rate-limit', `Waiting ${wait} ms`) });
    if (res.status < 200 || res.status >= 300) throw new Error(`Etsy answered HTTP ${res.status}`);
    const text = Buffer.isBuffer(res.body) ? res.body.toString('utf8') : String(res.body || '');
    const data = text ? JSON.parse(text) : {};
    return response ? { data, headers: res.headers } : data;
  }

  async function pull(shopId) {
    const shop = shopOrThrow(shopId);
    try {
      let created = 0; let duplicate = 0; let skipped = 0;
      for await (const receipts of shopPages({
        load: (path) => callShop(shop, path, { response: true }), path: `/shops/${shop.etsy_shop_id}/receipts?was_paid=true&was_shipped=false&limit=50`,
        rows: (data) => data.results || [], mode: 'offset',
      })) for (const receipt of receipts) {
        const result = takeOrder(shop, receipt);
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
    let n = 0;
    const stmt = store.db.prepare(`INSERT INTO etsy_catalog (shop_id, sku, title, barcode, listing_id, product_id) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(shop_id, sku) DO UPDATE SET title = excluded.title, barcode = excluded.barcode, listing_id = excluded.listing_id, product_id = excluded.product_id`);
    for await (const listings of shopPages({
      load: (path) => callShop(shop, path, { response: true }), path: `/shops/${shop.etsy_shop_id}/listings/active?limit=50`,
      rows: (data) => data.results || [], mode: 'offset',
    })) for (const listing of listings) {
      let products = (listing.inventory && listing.inventory.products) || listing.products || [];
      if (!products.length) {
        const inv = await callShop(shop, `/listings/${listing.listing_id}/inventory`);
        products = inv.products || [];
      }
      const rows = products.length ? products : (listing.skus || []).map((sku) => ({ sku }));
      for (const product of rows) {
        const sku = product.sku || '';
        if (!sku) continue;
        const barcode = barcodeOf(product);
        stmt.run(shop.id, sku, listing.title || product.title || '', barcode, String(listing.listing_id), product.product_id ? String(product.product_id) : null);
        const guess = suggestItem(warehouse(), sku, barcode);
        if (guess && !store.db.prepare('SELECT sku FROM etsy_map WHERE shop_id = ? AND sku = ?').get(shop.id, sku)) {
          mapSku(shop.id, sku, guess, { listingId: listing.listing_id, productId: product.product_id });
        }
        n++;
      }
    }
    journal(shop.id, true, 'catalog', `Read ${n} SKUs`);
    return n;
  }

  function mappings(shopId) {
    shopOrThrow(shopId);
    const catalog = store.db.prepare('SELECT sku, title, barcode, listing_id, product_id FROM etsy_catalog WHERE shop_id = ? ORDER BY sku').all(shopId);
    const maps = Object.fromEntries(store.db.prepare('SELECT sku, item_no FROM etsy_map WHERE shop_id = ?').all(shopId).map((r) => [r.sku, r.item_no]));
    return catalog.map((row) => ({
      sku: row.sku, title: row.title, barcode: row.barcode, listingId: row.listing_id, productId: row.product_id,
      itemNo: maps[row.sku] || null,
      suggestion: maps[row.sku] ? null : suggestItem(warehouse(), row.sku, row.barcode),
    }));
  }

  function queueStock(itemNo) {
    if (!warehouse().items[itemNo]) return;
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
      const byListing = new Map();
      for (const itemNo of items) {
        const qty = availableQty(warehouse(), itemNo, shop.buffer);
        const prev = store.db.prepare('SELECT qty FROM etsy_stock WHERE shop_id = ? AND item_no = ?').get(shop.id, itemNo);
        if (prev && prev.qty === qty) continue;
        const maps = store.db.prepare('SELECT sku, listing_id, product_id FROM etsy_map WHERE shop_id = ? AND item_no = ? AND listing_id IS NOT NULL').all(shop.id, itemNo);
        for (const map of maps) {
          if (!byListing.has(map.listing_id)) byListing.set(map.listing_id, []);
          byListing.get(map.listing_id).push({ itemNo, qty, sku: map.sku, product_id: map.product_id ? Number(map.product_id) : undefined, offerings: [{ quantity: qty, is_enabled: true }] });
        }
      }
      for (const [listingId, products] of byListing) {
        await callShop(shop, `/listings/${listingId}/inventory`, { method: 'PUT', json: { products: products.map(({ sku, product_id, offerings }) => ({ sku, product_id, offerings })) } });
        for (const row of products) {
          store.db.prepare('INSERT INTO etsy_stock (shop_id, item_no, qty, pushed_at) VALUES (?, ?, ?, ?) ON CONFLICT(shop_id, item_no) DO UPDATE SET qty = excluded.qty, pushed_at = excluded.pushed_at').run(shop.id, row.itemNo, row.qty, clock());
          journal(shop.id, true, 'stock', `${row.itemNo} available ${row.qty}`);
        }
      }
    }
  }

  async function pushFulfilment(message) {
    const data = message.data || {};
    const order = warehouse().orders && warehouse().orders[data.orderId];
    const ref = (order && order.ref) || data.ref || '';
    const link = store.db.prepare('SELECT shop_id, external_id FROM etsy_link WHERE ref = ?').get(ref);
    if (!link) return null;
    const shop = shopOrThrow(link.shop_id);
    const tracking = (order && order.tracking) || data.tracking || '';
    const carrier = (order && order.carrierName) || data.carrier || '';
    if (!tracking) return null;
    await callShop(shop, `/shops/${shop.etsy_shop_id}/receipts/${link.external_id}/tracking`, {
      method: 'POST', form: { tracking_code: tracking, carrier_name: carrier, send_bcc: 'false' },
    });
    return journal(shop.id, true, 'fulfil', `${data.orderId} tracking ${tracking}`);
  }

  function acceptWebhook(shopId, raw, header) {
    const shop = store.db.prepare('SELECT site FROM etsy_shops WHERE id = ?').get(String(shopId));
    if (!shop) throw new Error('Unknown shop');
    return store._withSite(shop.site, () => {
      if (!warehouse().module('etsy')) throw new Error('The shop connector is switched off');
      return acceptWebhookHere(shopId, raw, header);
    });
  }

  function acceptWebhookHere(shopId, raw, header) {
    const shop = shopOrThrow(shopId);
    const sec = secretOf(shop.id);
    if (!verifyWebhook(raw, header, sec.webhookSecret)) {
      journal(shop.id, false, 'webhook', 'Signature did not match');
      const err = new Error('Etsy signature did not match');
      err.status = 401;
      throw err;
    }
    const receipt = JSON.parse(raw);
    const result = takeOrder(shop, receipt.receipt || receipt);
    journal(shop.id, true, 'webhook', `${result.status} ${receipt.receipt_id || (receipt.receipt && receipt.receipt.receipt_id) || ''}`);
    return result;
  }

  function status() {
    return {
      shops: shops().map(publicShop),
      errors: store.db.prepare('SELECT t, shop_id, action, summary FROM etsy_log WHERE site = ? AND ok = 0 ORDER BY id DESC LIMIT 20').all(siteId()).map((r) => ({ at: r.t, shopId: r.shop_id, action: r.action, summary: r.summary })),
    };
  }

  function onCommand(op) {
    if (op === 'noteTracking' || op === 'enableDemandReplenishment') return;
    const wh = warehouse();
    if (!wh || typeof wh.module === 'function' && !wh.module('etsy')) return;
    for (const itemNo of Object.keys(wh.items || {})) queueStock(itemNo);
  }

  const worker = createShopWorker({ store, connector: 'etsy', metaTable: 'etsy_meta',
    shops, pull, deliver: pushFulfilment, journal, now: clock });
  const start = worker.start;


  return {
    run: worker.run, status, saveShop, mapSku, mappings, pull, pullProducts, takeOrder, acceptWebhook, flushStock, queueStock, pushFulfilment, onCommand, start, beginConnect, finishConnect,
    _setSchedule(fn) { schedule = fn; },
  };
}

module.exports = { createEtsy, verifyWebhook, availableQty, suggestItem, withBackoff };
