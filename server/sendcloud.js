/*
 * Sendcloud parcels and labels, on top of a packed shipment.
 * No packages: Node https and crypto. Keys stay in a file beside the
 * database and are never returned. See docs/connectors/SENDCLOUD.md.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const { createHmac, timingSafeEqual } = require('node:crypto');

function verifyWebhook(raw, header, secret) {
  if (!secret || !header) return false;
  const digest = createHmac('sha256', secret).update(raw, 'utf8').digest('hex');
  const a = Buffer.from(digest);
  const b = Buffer.from(String(header).trim().toLowerCase());
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function pickRule(rules, { clientId, country, weightKg }) {
  const fits = rules.filter((r) => {
    if (Number(weightKg) < r.min_kg || Number(weightKg) > r.max_kg) return false;
    if (r.country && r.country !== country) return false;
    if (r.client_id && r.client_id !== clientId) return false;
    return true;
  });
  fits.sort((a, b) => score(b) - score(a) || a.min_kg - b.min_kg);
  return fits[0] || null;
}

function score(rule) {
  return (rule.client_id ? 4 : 0) + (rule.country ? 2 : 0);
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
  const err = new Error('Sendcloud asked us to slow down');
  err.response = last;
  throw err;
}

function httpRequest({ method, url, headers, body, timeoutMs = 20000 }) {
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
    req.on('timeout', () => { req.destroy(); reject(new Error('Sendcloud did not answer in time')); });
    req.on('error', (err) => reject(new Error(err.message || 'Sendcloud connection failed')));
    if (body) req.write(body);
    req.end();
  });
}

function createSendcloud({ store, secretsFile = undefined, labelsDir = undefined, transport = null, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = () => {}, now = null } = {}) {
  if (!store || !store.db) throw new Error('Sendcloud needs the warehouse database');
  const clock = typeof now === 'function' ? now : () => Date.now();
  const beside = store.file && store.file !== ':memory:' ? path.dirname(store.file) : null;
  const secretsPath = secretsFile === undefined ? (beside ? path.join(beside, 'sendcloud-secrets.json') : null) : secretsFile;
  const pdfDir = labelsDir === undefined ? (beside ? path.join(beside, 'sendcloud-labels') : null) : labelsDir;
  let memorySecrets = {};

  function siteId() { return store.siteId || 'MAIN'; }
  function warehouse() { return store.warehouse(siteId()); }
  function loadSecrets() {
    if (!secretsPath) return { ...memorySecrets };
    if (!fs.existsSync(secretsPath)) return {};
    try { return JSON.parse(fs.readFileSync(secretsPath, 'utf8')); } catch (e) { return {}; }
  }
  function writeSecrets(data) {
    if (!secretsPath) { memorySecrets = { ...data }; return; }
    fs.mkdirSync(path.dirname(secretsPath), { recursive: true });
    const tmp = `${secretsPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
    fs.renameSync(tmp, secretsPath);
    try { fs.chmodSync(secretsPath, 0o600); } catch (e) { /* mode is best-effort */ }
  }
  function redact(text) {
    let out = String(text || '');
    const sec = loadSecrets();
    for (const value of [sec.publicKey, sec.secretKey, sec.webhookSecret]) {
      if (value && String(value).length >= 4) out = out.split(String(value)).join('***');
    }
    return out;
  }
  function journal(ok, action, summary) {
    const safe = redact(summary);
    store.db.prepare('INSERT INTO sendcloud_log (site, t, ok, action, summary) VALUES (?, ?, ?, ?, ?)').run(siteId(), clock(), ok ? 1 : 0, action, safe);
    if (!ok) raise(safe);
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

  function accountRow() {
    return store.db.prepare('SELECT * FROM sendcloud_account WHERE site = ?').get(siteId()) || null;
  }

  function saveAccount(input = {}) {
    const name = String(input.senderName || '').trim().slice(0, 80);
    const address = String(input.senderAddress || '').trim().slice(0, 120);
    const city = String(input.senderCity || '').trim().slice(0, 80);
    const postal = String(input.senderPostal || '').trim().slice(0, 20);
    const country = String(input.senderCountry || '').trim().toUpperCase();
    if (country && !/^[A-Z]{2}$/.test(country)) throw new Error('The sender country is two letters');
    const prev = loadSecrets();
    const publicKey = String(input.publicKey || '') || prev.publicKey;
    const secretKey = String(input.secretKey || '') || prev.secretKey;
    const webhookSecret = String(input.webhookSecret || '') || prev.webhookSecret;
    if (!publicKey || !secretKey) throw new Error('A Sendcloud public key and secret key are required');
    writeSecrets({ publicKey, secretKey, webhookSecret: webhookSecret || null });
    store.db.prepare(`INSERT INTO sendcloud_account (site, sender_name, sender_address, sender_city, sender_postal, sender_country)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(site) DO UPDATE SET sender_name = excluded.sender_name, sender_address = excluded.sender_address,
        sender_city = excluded.sender_city, sender_postal = excluded.sender_postal, sender_country = excluded.sender_country`)
      .run(siteId(), name, address, city, postal, country);
    return publicAccount();
  }

  function publicAccount() {
    const row = accountRow();
    const sec = loadSecrets();
    return {
      senderName: row ? row.sender_name : '',
      senderAddress: row ? row.sender_address : '',
      senderCity: row ? row.sender_city : '',
      senderPostal: row ? row.sender_postal : '',
      senderCountry: row ? row.sender_country : '',
      publicKeySet: Boolean(sec.publicKey),
      secretKeySet: Boolean(sec.secretKey),
      webhookSecretSet: Boolean(sec.webhookSecret),
    };
  }

  function saveRule(input = {}) {
    const clientId = input.clientId ? String(input.clientId).trim().toUpperCase() : '';
    const country = input.country ? String(input.country).trim().toUpperCase() : '';
    if (country && !/^[A-Z]{2}$/.test(country)) throw new Error('The country is two letters, or blank for any');
    const min = Number(input.minKg);
    const max = Number(input.maxKg);
    if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max < min) throw new Error('The weight range is in kilograms, from low to high');
    const method = String(input.methodId || '').trim();
    if (!/^\d{1,12}$/.test(method)) throw new Error('The Sendcloud shipping method is a number');
    const carrier = String(input.carrier || '').trim().slice(0, 40);
    const service = String(input.service || '').trim().slice(0, 40);
    if (!carrier) throw new Error('A carrier name is required');
    const id = store.db.prepare(`INSERT INTO sendcloud_rules (site, client_id, country, min_kg, max_kg, method_id, carrier, service)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(siteId(), clientId, country, min, max, method, carrier, service).lastInsertRowid;
    return { id: Number(id), clientId: clientId || null, country: country || null, minKg: min, maxKg: max, methodId: method, carrier, service };
  }

  function rules() {
    return store.db.prepare('SELECT * FROM sendcloud_rules WHERE site = ? ORDER BY id').all(siteId()).map((r) => ({
      id: r.id, clientId: r.client_id || null, country: r.country || null, minKg: r.min_kg, maxKg: r.max_kg,
      methodId: r.method_id, carrier: r.carrier, service: r.service,
    }));
  }

  function cartonsOf(order) {
    return Object.values(warehouse().holders || {}).filter((h) => h.orderId === order.id && h.series === 'OUT' && h.cartonStatus && h.cartonStatus !== 'open' && (h.packed || []).length);
  }

  function measure(boxes) {
    const weightKg = boxes.reduce((s, b) => s + (Number(b.weightKg) || 0), 0);
    const lengthMm = Math.max(...boxes.map((b) => Number(b.lengthMm) || 0));
    const widthMm = Math.max(...boxes.map((b) => Number(b.widthMm) || 0));
    const heightMm = boxes.reduce((s, b) => s + (Number(b.heightMm) || 0), 0);
    return { weightKg, lengthCm: Math.max(1, Math.round(lengthMm / 10)), widthCm: Math.max(1, Math.round(widthMm / 10)), heightCm: Math.max(1, Math.round(heightMm / 10)) };
  }

  function addressOf(input, fallbackName) {
    const name = String(input.name || fallbackName || '').trim();
    const address = String(input.address || '').trim();
    const city = String(input.city || '').trim();
    const postal = String(input.postalCode || input.postal || '').trim();
    const country = String(input.country || '').trim().toUpperCase();
    const house = String(input.houseNumber || '').trim();
    if (!name || !address || !city || !postal || !/^[A-Z]{2}$/.test(country)) throw new Error('A label needs a name, street, city, postcode and a two-letter country');
    return { name, address, house_number: house, city, postal_code: postal, country };
  }

  async function call(pathName, { method = 'GET', json = null, binary = false } = {}) {
    const sec = loadSecrets();
    if (!sec.publicKey || !sec.secretKey) throw new Error('Save the Sendcloud keys first');
    const url = pathName.startsWith('http') ? pathName : `https://panel.sendcloud.sc/api/v2${pathName}`;
    const headers = { authorization: `Basic ${Buffer.from(`${sec.publicKey}:${sec.secretKey}`).toString('base64')}`, accept: binary ? 'application/pdf' : 'application/json' };
    let body = null;
    if (json) { body = Buffer.from(JSON.stringify(json)); headers['content-type'] = 'application/json'; }
    const run = () => (transport || httpRequest)({ method, url, headers, body });
    const res = await withBackoff(run, { sleep, onWait: (wait) => journal(false, 'rate-limit', `Waiting ${wait} ms`) });
    if (res.status < 200 || res.status >= 300) throw new Error(`Sendcloud answered HTTP ${res.status}`);
    if (binary) return Buffer.isBuffer(res.body) ? res.body : Buffer.from(res.body || '');
    const text = Buffer.isBuffer(res.body) ? res.body.toString('utf8') : String(res.body || '');
    return text ? JSON.parse(text) : {};
  }

  function trackingStub(order, tracking, carrier) {
    const wh = warehouse();
    const zpl = ['^XA', '^CI28', '^PW812^LL406', '^FO40,40^A0N,40,40^FDSENDCLOUD^FS', `^FO40,100^A0N,36,36^FD${String(order.id).replace(/[\^~]/g, ' ')}^FS`, `^FO40,160^A0N,32,32^FD${String(carrier || '').replace(/[\^~]/g, ' ')}^FS`, `^FO40,220^A0N,36,36^FD${String(tracking || '').replace(/[\^~]/g, ' ')}^FS`, '^XZ'].join('\n');
    wh.printQueue = wh.printQueue || [];
    wh._seq = wh._seq || { label: 0 };
    const id = ++wh._seq.label;
    wh.printQueue.unshift({ id, printer: 'LP-OUT-01', at: clock(), label: { kind: 'sendcloud', orderId: order.id, tracking }, zpl });
    if (wh.printQueue.length > 50) wh.printQueue.length = 50;
    return id;
  }

  async function storePdf(parcelId, url) {
    const bytes = await call(url, { binary: true });
    if (!pdfDir) return { bytes: bytes.length, file: null };
    fs.mkdirSync(pdfDir, { recursive: true });
    const file = path.join(pdfDir, `${parcelId}.pdf`);
    fs.writeFileSync(file, bytes);
    return { bytes: bytes.length, file };
  }

  async function createParcel(input = {}) {
    const order = warehouse().orders[String(input.orderId || '')];
    if (!order) throw new Error(`Unknown order ${input.orderId}`);
    const existing = store.db.prepare('SELECT * FROM sendcloud_parcels WHERE site = ? AND order_id = ? AND return_id IS NULL ORDER BY id DESC LIMIT 1').get(siteId(), order.id);
    if (existing && existing.tracking) {
      return { status: 'exists', orderId: order.id, tracking: existing.tracking, trackingUrl: existing.tracking_url, file: existing.pdf_path, carrier: existing.carrier };
    }
    const boxes = cartonsOf(order);
    if (!boxes.length) throw new Error('Pack the order first');
    const size = measure(boxes);
    const to = addressOf(input, order.customer);
    const rule = pickRule(store.db.prepare('SELECT * FROM sendcloud_rules WHERE site = ?').all(siteId()), {
      clientId: order.clientId || null, country: to.country, weightKg: size.weightKg,
    });
    if (!rule) throw new Error(`No shipping rule for ${to.country} at ${size.weightKg} kg`);
    try {
      const created = await call('/parcels', {
        method: 'POST',
        json: {
          parcel: {
            name: to.name, address: to.address, house_number: to.house_number, city: to.city, postal_code: to.postal_code, country: to.country,
            weight: size.weightKg.toFixed(3), length: String(size.lengthCm), width: String(size.widthCm), height: String(size.heightCm),
            order_number: order.id, request_label: true, shipment: { id: Number(rule.method_id) },
          },
        },
      });
      const parcel = created.parcel || created;
      const tracking = parcel.tracking_number || '';
      const trackingUrl = parcel.tracking_url || '';
      const labelUrl = parcel.label && (parcel.label.label_printer || parcel.label.normal_printer);
      const pdf = labelUrl ? await storePdf(parcel.id || order.id, labelUrl) : { file: null, bytes: 0 };
      const printId = trackingStub(order, tracking, rule.carrier);
      store.exec('noteTracking', { orderId: order.id, tracking, trackingUrl, carrier: rule.carrier }, 'sendcloud');
      store.db.prepare(`INSERT INTO sendcloud_parcels (site, order_id, return_id, external_id, carrier, service, tracking, tracking_url, pdf_path, status, print_id, t)
        VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(siteId(), order.id, String(parcel.id || ''), rule.carrier, rule.service, tracking, trackingUrl, pdf.file, 'created', printId, clock());
      journal(true, 'label', `${order.id} ${rule.carrier} ${tracking}`);
      return { status: 'created', orderId: order.id, tracking, trackingUrl, carrier: rule.carrier, service: rule.service, file: pdf.file, weightKg: size.weightKg, lengthCm: size.lengthCm, widthCm: size.widthCm, heightCm: size.heightCm };
    } catch (e) {
      journal(false, 'label', e.message);
      throw new Error(redact(e.message));
    }
  }

  async function createReturnLabel(input = {}) {
    const wh = warehouse();
    if (typeof wh.module === 'function' && !wh.module('returns')) throw new Error('Returns are switched off');
    const rma = wh.returns && wh.returns[String(input.returnId || '')];
    if (!rma) throw new Error('Unknown return');
    const account = accountRow();
    if (!account || !account.sender_address || !account.sender_country) throw new Error('Save the warehouse address that returns come back to');
    const from = addressOf(input, rma.customer);
    const rule = pickRule(store.db.prepare('SELECT * FROM sendcloud_rules WHERE site = ?').all(siteId()), {
      clientId: rma.clientId || null, country: from.country, weightKg: Number(input.weightKg) || 1,
    });
    if (!rule) throw new Error(`No shipping rule for a return from ${from.country}`);
    const created = await call('/parcels', {
      method: 'POST',
      json: {
        parcel: {
          name: account.sender_name, address: account.sender_address, city: account.sender_city, postal_code: account.sender_postal, country: account.sender_country,
          from_name: from.name, from_address_1: from.address, from_house_number: from.house_number, from_city: from.city, from_postal_code: from.postal_code, from_country: from.country,
          weight: (Number(input.weightKg) || 1).toFixed(3), order_number: rma.id, request_label: true, is_return: true, shipment: { id: Number(rule.method_id) },
        },
      },
    });
    const parcel = created.parcel || created;
    const labelUrl = parcel.label && (parcel.label.label_printer || parcel.label.normal_printer);
    const pdf = labelUrl ? await storePdf(`return-${parcel.id || rma.id}`, labelUrl) : { file: null };
    store.db.prepare(`INSERT INTO sendcloud_parcels (site, order_id, return_id, external_id, carrier, service, tracking, tracking_url, pdf_path, status, print_id, t)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`).run(siteId(), rma.orderId, rma.id, String(parcel.id || ''), rule.carrier, rule.service, parcel.tracking_number || '', parcel.tracking_url || '', pdf.file, 'return', clock());
    journal(true, 'return', `${rma.id} ${parcel.tracking_number || ''}`);
    return { status: 'created', returnId: rma.id, tracking: parcel.tracking_number || '', file: pdf.file, carrier: rule.carrier };
  }

  function acceptWebhook(raw, header) {
    const body = JSON.parse(raw);
    const parcel = body.parcel || body;
    const row = store.db.prepare('SELECT site FROM sendcloud_parcels WHERE external_id = ? ORDER BY id DESC LIMIT 1').get(String(parcel.id || ''));
    return store._withSite(row?.site || 'MAIN', () => acceptWebhookHere(raw, header));
  }

  function acceptWebhookHere(raw, header) {
    if (!warehouse().module('sendcloud')) throw new Error('Sendcloud is switched off');
    const sec = loadSecrets();
    if (!verifyWebhook(raw, header, sec.webhookSecret)) {
      journal(false, 'webhook', 'Signature did not match');
      const err = new Error('Sendcloud signature did not match');
      err.status = 401;
      throw err;
    }
    const body = JSON.parse(raw);
    const parcel = body.parcel || body;
    const external = String(parcel.id || '');
    const status = (parcel.status && (parcel.status.message || parcel.status.id)) || body.action || 'updated';
    const row = store.db.prepare('SELECT id, status, order_id FROM sendcloud_parcels WHERE external_id = ? ORDER BY id DESC LIMIT 1').get(external);
    if (row && row.status === String(status)) return { status: 'duplicate', id: row.id };
    if (row) store.db.prepare('UPDATE sendcloud_parcels SET status = ? WHERE id = ?').run(String(status), row.id);
    journal(true, 'webhook', `${external} ${status}`);
    return { status: row ? 'updated' : 'noted', externalId: external, message: String(status) };
  }

  function status() {
    return {
      account: publicAccount(),
      rules: rules(),
      parcels: store.db.prepare('SELECT order_id, return_id, carrier, service, tracking, tracking_url, status, t FROM sendcloud_parcels WHERE site = ? ORDER BY id DESC LIMIT 20').all(siteId()).map((r) => ({
        orderId: r.order_id, returnId: r.return_id, carrier: r.carrier, service: r.service, tracking: r.tracking, trackingUrl: r.tracking_url, status: r.status, at: r.t,
      })),
      errors: store.db.prepare('SELECT t, action, summary FROM sendcloud_log WHERE site = ? AND ok = 0 ORDER BY id DESC LIMIT 20').all(siteId()).map((r) => ({ at: r.t, action: r.action, summary: r.summary })),
    };
  }

  function start() {
    return () => {};
  }

  return { status, saveAccount, saveRule, rules, createParcel, createReturnLabel, acceptWebhook, pickRule, start, measure, cartonsOf };
}

module.exports = { createSendcloud, verifyWebhook, withBackoff, pickRule };
