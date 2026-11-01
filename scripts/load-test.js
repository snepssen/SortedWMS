#!/usr/bin/env node
/*
 * Load test: build a big made-up warehouse through the same commands the
 * screens use, then time what people wait on. Nothing here is real data.
 *
 *   node scripts/load-test.js            normal size (about 14,000 locations)
 *   node scripts/load-test.js --scale 2  twice as much of everything
 *   node scripts/load-test.js --keep     keep the database file afterwards
 *
 * The database goes to a temporary folder unless SORTED_DB names one.
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { Store } = require('../server/store');
const { Printers } = require('../server/print');
const { createServer } = require('../server/index');
const { createAuth } = require('../server/auth');
const GS1 = require('../src/gs1');

const argv = process.argv.slice(2);
const scale = Number((argv[argv.indexOf('--scale') + 1]) || 1) || 1;
const keep = argv.includes('--keep');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sorted-load-'));
const file = process.env.SORTED_DB || path.join(dir, 'load.db');
const site = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'server', 'site.blank.json'), 'utf8'));

// A seeded random, so two runs build the same warehouse.
let seed = 42;
const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const pick = (list) => list[Math.floor(rand() * list.length)];
const n = (x) => Math.max(1, Math.round(x * scale));

const rows = [];
function time(label, fn, { count = 1 } = {}) {
  const t0 = process.hrtime.bigint();
  const out = fn();
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  rows.push({ label, ms, count });
  return out;
}
async function timeAsync(label, fn, { count = 1 } = {}) {
  const t0 = process.hrtime.bigint();
  const out = await fn();
  rows.push({ label, ms: Number(process.hrtime.bigint() - t0) / 1e6, count });
  return out;
}

function day(offset) {
  return new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
}

async function main() {
  const store = new Store({ file, site });
  const x = (op, args) => store.exec(op, args, 'load');
  const w = () => store.wh;

  x('applyPreset', { id: 'chilled-dc' });
  const halls = n(4);
  time(`locations: ${halls} rack halls + ${n(2)} bin floors`, () => {
    for (let h = 1; h <= halls; h++) x('generateGuided', { answers: { sections: { count: 1, name: `Hall ${h}` }, layouts: [{ type: 'rack', aisles: { count: 10, name: '01' }, bays: { count: 25, name: '01' }, levels: { count: 5, name: 'A' }, positions: { count: 2, name: '1' } }] } });
    for (let m = 1; m <= n(2); m++) x('generateGuided', { answers: { sections: { count: 1, name: `Mezz ${m}` }, layouts: [{ type: 'shelf', aisles: { count: 10, name: 'R1' }, bays: { count: 20, name: 'S1' }, positions: { count: 10, name: 'B1' } }] } });
  });
  const racks = Object.values(w().locations).filter((l) => l.kind === 'rack' && !l.structural).map((l) => l.code);
  const bins = Object.values(w().locations).filter((l) => l.kind === 'bin').map((l) => l.code);

  const itemCount = n(2000);
  const items = [];
  time(`${itemCount} items, one command each`, () => {
    for (let i = 1; i <= itemCount; i++) {
      const itemNo = `I${String(i).padStart(5, '0')}`;
      x('addItem', { itemNo, name: `Made-up item ${i}`, category: pick(['CHILL', 'AMBIENT']), palletQty: 480, uom: 'piece', minShipDays: i % 5 === 0 ? 7 : 0 });
      x('setItemUnits', { itemNo, packs: [{ unit: 'box', per: 12 }] });
      items.push(itemNo);
    }
  }, { count: itemCount * 2 });

  const palletCount = Math.min(n(6000), racks.length);
  const slots = racks.slice().sort(() => rand() - 0.5).slice(0, palletCount);
  time(`${palletCount} pallets, imported 500 at a time`, () => {
    for (let i = 0; i < slots.length; i += 500) {
      x('importStock', { rows: slots.slice(i, i + 500).map((code, k) => {
        const body = String(100000 + i + k).padStart(17, '0');
        return { code, sscc: body + GS1.checkDigit(body), itemNo: pick(items), qty: 480, batch: `L${Math.floor(rand() * 90)}`, expiry: day(10 + Math.floor(rand() * 200)), receivedAt: Date.now() - Math.floor(rand() * 9e9) };
      }) });
    }
  }, { count: Math.ceil(slots.length / 500) });

  const binLines = n(8000);
  time(`${binLines} bin put-aways, one command each`, () => {
    for (let i = 0; i < binLines; i++) x('binPut', { loc: pick(bins), itemNo: pick(items), qty: 1 + Math.floor(rand() * 60), batch: `B${Math.floor(rand() * 30)}`, expiry: day(-5 + Math.floor(rand() * 120)) });
  }, { count: binLines });

  const orderCount = n(2000);
  time(`${orderCount} piece orders of 1-4 lines`, () => {
    for (let i = 1; i <= orderCount; i++) {
      const lines = [...new Set(Array.from({ length: 1 + Math.floor(rand() * 4) }, () => pick(items)))].map((itemNo) => ({ itemNo, units: pick([1, 2, 3, 5, 12, 24, 30]) }));
      x('addOrder', { id: `SO${i}`, customer: `Customer ${i % 150}`, lane: 'OUT-01', lines });
    }
  }, { count: orderCount });

  const importCount = n(1000);
  time(`${importCount} more piece orders as one CSV import`, () => {
    const rows = [];
    for (let i = 1; i <= importCount; i++) {
      for (const itemNo of new Set(Array.from({ length: 1 + Math.floor(rand() * 3) }, () => pick(items)))) rows.push({ orderId: `IM${i}`, customer: `Shop ${i % 90}`, lane: 'OUT-01', itemNo, units: pick([1, 2, 6, 12]) });
    }
    const out = x('importOrders', { rows, planOnce: true });
    if (out.errors.length) throw new Error(out.errors[0]);
  }, { count: importCount });

  // What people wait on, read straight from the engine.
  time('queue: plan every order (waveQueue)', () => w().waveQueue());
  time('availability: every item', () => w().availability());
  time('stock summary', () => w().stockSummary());
  time('bin list (first 200)', () => w().binList({}));
  time('near best-before list', () => w().bestBeforeWatch({ days: 14 }));
  time('search "I0012"', () => w().search('I0012'));

  let waves = 0;
  let tasks = 0;
  const waveCount = n(15);
  time(`${waveCount} pick waves, planned and every task confirmed`, () => {
    for (let k = 0; k < waveCount; k++) {
      let wave;
      try { wave = x('planWave', {}); } catch (e) { break; }
      waves++;
      for (const t of wave.tasks) {
        try { x('confirmWaveTask', { task: t.id }); tasks++; } catch (e) { /* a refused task costs a reload, as on the floor */ }
      }
    }
  });
  rows.push({ label: `  (${waves} waves, ${tasks} tasks confirmed)`, ms: null });
  time('one wave planned on its own', () => { try { x('planWave', {}); } catch (e) { /* queue empty */ } });
  time('a refused command (store reloads the warehouse)', () => { try { x('binTake', { loc: bins[0], itemNo: items[0], qty: 999999 }); } catch (e) { /* expected */ } });

  const journalRows = store.db.prepare('SELECT COUNT(*) AS n FROM journal').get().n;
  const snapBytes = Buffer.byteLength(JSON.stringify(w()));
  time('snapshot: write the whole state', () => store.snapshot());
  time('restart: latest snapshot + journal after it', () => store.load());
  store.db.exec('DELETE FROM snapshots');
  time(`restart from nothing: replay all ${journalRows} journal rows`, () => store.load());
  store.snapshot();

  const auth = createAuth(store.db);
  auth.ensureAdmin({ password: 'load-test-only' });
  const server = createServer({ store, printers: new Printers({}), auth });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const req = (method, p, body, cookie) => new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) } }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, bytes: Buffer.byteLength(text) }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
  try {
    const signed = await req('POST', '/api/login', { username: 'admin', password: 'load-test-only' });
    const cookie = String(signed.headers['set-cookie']).split(';')[0];
    for (const p of ['/api/stock', '/api/items', '/api/orders', '/api/bins', '/api/waves', '/api/waves/tasks?kind=bin', '/api/waves/queue', '/api/best-before', '/api/locations', '/api/movements']) {
      let res;
      await timeAsync(`GET ${p}`, async () => { res = await req('GET', p, null, cookie); });
      const last = rows[rows.length - 1];
      last.label += `  [${res.status}, ${(res.bytes / 1024).toFixed(0)} KB]`;
    }
  } finally {
    await new Promise((r) => server.close(r));
  }

  const counts = { locations: Object.keys(w().locations).length, items: Object.keys(w().items).length, pallets: Object.values(w().pallets).filter((p) => p.status !== 'shipped').length, binLines: Object.values(w().binStock || {}).reduce((s, l) => s + l.length, 0), orders: Object.keys(w().orders).length, journalRows, stateMB: (snapBytes / 1048576).toFixed(1) };
  store.close();
  if (!keep && !process.env.SORTED_DB) fs.rmSync(dir, { recursive: true, force: true });

  console.log(`\nSortedWMS load test, scale ${scale}`);
  console.log(Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(' · '));
  console.log('');
  const width = Math.max(...rows.map((r) => r.label.length));
  for (const r of rows) {
    if (r.ms == null) { console.log(r.label); continue; }
    const each = r.count > 1 ? `  (${(r.ms / r.count).toFixed(2)} ms each)` : '';
    console.log(`${r.label.padEnd(width)}  ${r.ms.toFixed(0).padStart(7)} ms${each}`);
  }
  if (keep || process.env.SORTED_DB) console.log(`\nDatabase kept at ${file}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
