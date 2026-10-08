// The GitHub Pages build runs the WMS in the browser: load the same files the
// pages load, as plain scripts with browser globals, and use the API.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const FILES = ['src/gs1.js', 'src/labels.js', 'src/engine.js', 'server/commands.js', 'server/site.js', 'server/seed.js', 'server/api.js', 'server/local.js'];

function browser(storage = new Map()) {
  const timers = [];
  const win = {
    localStorage: { getItem: (k) => (storage.has(k) ? storage.get(k) : null), setItem: (k, v) => storage.set(k, String(v)), removeItem: (k) => storage.delete(k) },
    document: { currentScript: null },
    fetch: async () => ({ json: async () => JSON.parse(fs.readFileSync(path.join(ROOT, 'server', 'site.example.json'), 'utf8')) }),
    addEventListener: () => {},
    setInterval: (fn) => timers.push(fn),
    console, URL, JSON, Date, Math,
  };
  win.self = win;
  const ctx = vm.createContext(win);
  for (const f of FILES) vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
  return { win, storage };
}

test('the WMS runs in the browser and two pages share one journal', async () => {
  const a = browser();
  const L = a.win.SortedLocal;
  const devs = (await L.fetch('GET', '/api/devices')).body;
  assert.deepStrictEqual(devs.filter((d) => d.kind === 'truck').map((d) => d.id), ['HH01', 'HH02', 'HH03', 'HH04']);

  const job = (await L.fetch('GET', '/api/devices/HH01')).body.instruction;
  assert.strictEqual(job.kind, 'pickup');
  assert.strictEqual((await L.fetch('POST', '/api/devices/HH01/scan', { code: job.pallet.sscc }, { operator: 'HH01' })).status, 200);
  const preview = (await L.fetch('GET', '/api/template/preview?from=AA&to=AB&category=PRO')).body;
  assert.strictEqual(preview.locations, 300);
  assert.strictEqual((await L.fetch('GET', '/api/devices/NOPE')).status, 404);

  // A second page on the same browser storage replays to the same state.
  const b = browser(a.storage);
  const viewA = (await L.fetch('GET', '/api/devices/HH01')).body;
  const viewB = (await b.win.SortedLocal.fetch('GET', '/api/devices/HH01')).body;
  assert.strictEqual(viewB.instruction.kind, 'drop');
  assert.deepStrictEqual(viewB, viewA);
  assert.strictEqual((await b.win.SortedLocal.fetch('GET', '/api/journal?by=HH01')).body.length, 1);
});

test('browser loading scans survive a second page and enforce verified departure', async () => {
  const a = browser(), L = a.win.SortedLocal;
  const post = async (path, body) => {
    const r = await L.fetch('POST', path, body, { operator: 'loading-test' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    return r.body;
  };
  for (let round = 0; round < 12; round++) {
    if ((await L.fetch('GET', '/api/orders')).body.find((o) => o.id === '4501').status === 'ready') break;
    for (const d of (await L.fetch('GET', '/api/devices')).body) {
      const i = d.instruction;
      if (i.task && i.task.orderId === '4501') await post(`/api/devices/${d.id}/scan`, { code: ['pickup', 'check-pallet'].includes(i.kind) ? i.pallet.sscc : i.target });
    }
  }
  await post('/api/orders/4501/loading', { trailer: 'BROWSER-7', inspectionPolicy: { min: 2, max: 6, validMinutes: 60 } });
  const report = (await L.fetch('GET', '/api/orders/4501/loading')).body;
  assert.strictEqual((await L.fetch('POST', '/api/orders/4501/loading/scan', { device: 'LOAD-01', code: report.pallets[0].sscc })).status, 400);
  const check = { temperature: 4, refrigerationOn: true, clean: true, dry: true, odorFree: true, damageFree: true, reason: 'Browser inspection' };
  await post('/api/orders/4501/loading/inspection', { ...check, clean: false });
  const heldPage = browser(a.storage).win.SortedLocal;
  assert.strictEqual((await heldPage.fetch('GET', '/api/orders/4501/loading')).body.trailerReadiness.status, 'held');
  assert.strictEqual((await heldPage.fetch('POST', '/api/orders/4501/loading/release', { reason: 'Too soon' })).status, 400);
  await post('/api/orders/4501/loading/inspection', check);
  assert.strictEqual((await heldPage.fetch('GET', '/api/orders/4501/loading')).body.trailerReadiness.status, 'held');
  await post('/api/orders/4501/loading/release', { reason: 'Cleaned, inspected and approved' });
  await post('/api/orders/4501/loading/scan', { device: 'LOAD-01', code: report.pallets[0].sscc });
  const b = browser(a.storage), B = b.win.SortedLocal;
  const restored = (await B.fetch('GET', '/api/orders/4501/loading')).body;
  assert.strictEqual(restored.loading.pending['LOAD-01'].sscc, report.pallets[0].sscc);
  assert.strictEqual((await B.fetch('POST', '/api/orders/4501/loading/scan', { device: 'LOAD-01', code: restored.loading.location })).status, 200);
  assert.strictEqual((await L.fetch('GET', '/api/orders/4501/loading')).body.loaded, 1);
  assert.strictEqual((await L.fetch('POST', '/api/orders/4501/ship', { seal: 'S7' })).status, 400);
  await post('/api/orders/4501/loading/scan', { device: 'LOAD-01', code: report.pallets[1].sscc });
  await post('/api/orders/4501/loading/scan', { device: 'LOAD-01', code: restored.loading.location });
  await post('/api/orders/4501/ship', { seal: 'S7' });
  const final = (await B.fetch('GET', '/api/orders/4501/loading')).body;
  assert.strictEqual(final.status, 'shipped');
  assert.strictEqual(final.loading.seal, 'S7');
});
