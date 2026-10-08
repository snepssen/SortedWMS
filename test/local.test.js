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
