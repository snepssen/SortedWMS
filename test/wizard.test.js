const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { expand, EXAMPLES } = require('../src/locations');
const { PRESETS } = require('../src/presets');
const { Warehouse } = require('../src/engine');
const { Store } = require('../server/store');
const { Printers } = require('../server/print');
const { createServer } = require('../server/index');
const { createAuth } = require('../server/auth');

test('the three numbering examples and a skipped-level home plan', () => {
  for (const ex of Object.values(EXAMPLES)) {
    const built = expand(ex.plan);
    assert.equal(built.sampleCode, ex.illustrates, ex.id);
  }
  const wide = expand({
    separator: '-',
    levels: [
      { key: 'cell', scheme: 'number', from: 1, to: 2, pad: 2 },
      { key: 'aisle', scheme: 'number', from: 1, to: 2, pad: 2 },
      { key: 'bay', skip: true },
      { key: 'position', skip: true },
      { key: 'height', scheme: 'letter', from: 'A', to: 'B' },
    ],
  });
  assert.equal(wide.total, 8);
  assert.deepEqual(wide.sample.slice(0, 2), ['01-01-A', '01-01-B']);
  assert.throws(() => expand({ separator: '-', levels: [{ key: 'bay', scheme: 'number', from: 1, to: 80, pad: 0 }, { key: 'height', scheme: 'number', from: 1, to: 80, pad: 0 }] }), /more than 5000/);
  assert.throws(() => expand({ separator: '-', levels: [] }), /at least one level/);
});

test('presets turn category features on or off without being dairy-only', () => {
  const ids = PRESETS.map((p) => p.id);
  assert.deepEqual(ids, ['chilled-dc', 'high-value', 'home-garage', 'small-maker']);
  const home = PRESETS.find((p) => p.id === 'home-garage');
  assert.equal(home.features.temperatureZones, false);
  assert.equal(home.features.lotExpiry, false);
  assert.equal(home.features.highValueSecurity, false);
  const chilled = PRESETS.find((p) => p.id === 'chilled-dc');
  assert.equal(chilled.features.fefo, true);
  assert.ok(chilled.categories.FROZEN);
  const secure = PRESETS.find((p) => p.id === 'high-value');
  assert.equal(secure.features.highValueSecurity, true);
  assert.equal(secure.features.temperatureZones, false);
});

test('feature flags gate expiry, FEFO and high-value plates', () => {
  const wh = new Warehouse({ aisles: [1], bays: 1, levels: 1, positions: [10], clock: () => Date.UTC(2026, 9, 8) });
  wh.addItem({ itemNo: 'Y1', name: 'Yoghurt', category: 'YOG', palletQty: 10, minShipDays: 10 });
  const old = wh.stockPallet('DOCK-IN', { itemNo: 'Y1', batch: 'A', expiry: '2020-01-01', receivedAt: 1 });
  const fresh = wh.stockPallet('01-01-0-10', { itemNo: 'Y1', batch: 'B', expiry: '2027-06-01', receivedAt: 2 });
  assert.equal(wh.shipState(old), 'expired');
  assert.equal(wh._fefo('Y1')[0].sscc, fresh.sscc);
  wh.setFeatures({ lotExpiry: false, fefo: false, temperatureZones: false, highValueSecurity: false });
  assert.equal(wh.shipState(old), 'ok');
  assert.throws(() => wh.recordTemperature(fresh.sscc, 4, 2, 6, 'spot check'), /Temperature zones are not enabled/);
  assert.throws(() => wh.issuePlates({ sscc: fresh.sscc }), /High-value license plates are not enabled/);
  wh.setFeatures({ lotExpiry: true, fefo: true, highValueSecurity: true, temperatureZones: true });
  assert.equal(wh.shipState(old), 'expired');
});

test('the setup wizard is admin-only and can be run again', async () => {
  const site = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'server', 'site.example.json'), 'utf8'));
  const store = new Store({ site });
  const auth = createAuth(store.db);
  auth.ensureDemoUsers();
  const server = createServer({ store, printers: new Printers({}), auth });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body, cookie) => {
    const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let parsed; try { parsed = JSON.parse(text); } catch (e) { parsed = text; }
    return { status: res.status, body: parsed };
  };
  const sign = async (username, password) => {
    const res = await call('POST', '/api/login', { username, password });
    return (res.headers ? null : (await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) })).headers.get('set-cookie').split(';')[0]);
  };
  try {
    const opRes = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'operator', password: 'sorted-operator' }) });
    const operator = opRes.headers.get('set-cookie').split(';')[0];
    const adminRes = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'sorted-admin' }) });
    const admin = adminRes.headers.get('set-cookie').split(';')[0];
    assert.equal((await call('GET', '/api/setup', null, operator)).status, 403);
    const page = await fetch(base + '/setup');
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Setup wizard/);
    const setup = await call('GET', '/api/setup', null, admin);
    assert.equal(setup.status, 200);
    assert.equal(setup.body.examples.find((ex) => ex.id === 'words').preview.sampleCode, 'Garage-Left-Shelf3-Box2-Top');
    const applied = await call('POST', '/api/setup/preset', { id: 'home-garage' }, admin);
    assert.equal(applied.body.features.highValueSecurity, false);
    const preview = await call('POST', '/api/locations/preview', { plan: EXAMPLES.home.plan }, admin);
    assert.equal(preview.body.sampleCode, 'Shelf-Top');
    const generated = await call('POST', '/api/locations/generate', { plan: EXAMPLES.home.plan, kind: 'bin' }, admin);
    assert.equal(generated.body.created, 1);
    assert.equal(store.wh.locations['Shelf-Top'].kind, 'bin');
    const again = await call('POST', '/api/locations/generate', { plan: EXAMPLES.home.plan, kind: 'bin' }, admin);
    assert.equal(again.body.created, 0);
    assert.equal(again.body.skipped, 1);
    assert.equal(store.wh.locations.CONSO00.role, 'consolidation');
    const virtual = await call('POST', '/api/locations', { code: 'packbench', kind: 'virtual', role: 'staging', name: 'Packing bench' }, admin);
    assert.equal(virtual.status, 200, virtual.body && virtual.body.error);
    assert.equal(store.wh.locations.PACKBENCH.role, 'staging');
    assert.equal((await call('POST', '/api/setup/features', { features: { fefo: true, lotExpiry: false } }, admin)).status, 400);
    assert.equal((await call('POST', '/api/setup/complete', {}, admin)).body.completed, true);
    assert.equal((await call('POST', '/api/locations/generate', { plan: EXAMPLES.numbers.plan }, operator)).status, 403);
  } finally {
    await new Promise((r) => server.close(r));
    store.close();
  }
});
