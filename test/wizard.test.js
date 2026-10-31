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
  assert.equal(wh.feature('lotExpiry'), false);
  assert.equal(wh.feature('highValueSecurity'), false);
  assert.equal(wh.shipState(old), 'ok', 'a fresh warehouse does not apply expiry');
  wh.setFeatures({ lotExpiry: true, fefo: true, temperatureZones: true, highValueSecurity: true });
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
    assert.equal(setup.body.setup.preset, 'chilled-dc');
    assert.equal(setup.body.features.temperatureZones, true);
    assert.equal(setup.body.features.lotExpiry, true);
    assert.equal(setup.body.features.fefo, true);
    assert.equal(setup.body.features.highValueSecurity, true);
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

test('the guided wizard reads the naming from what the first one is called', () => {
  const { seriesFromName, tokens } = require('../src/locations');
  const named = (name, count) => {
    const series = seriesFromName(name, count);
    return series.skip ? null : tokens(series);
  };
  assert.equal(named('', 1), null, 'one thing with no name stays out of the code');
  assert.deepEqual(named('', 3), ['1', '2', '3']);
  assert.deepEqual(named('', 12).slice(0, 2), ['01', '02']);
  assert.deepEqual(named('01', 3), ['01', '02', '03']);
  assert.deepEqual(named('7', 3), ['7', '8', '9']);
  assert.deepEqual(named('a', 3), ['A', 'B', 'C']);
  assert.deepEqual(named('R1', 3), ['R1', 'R2', 'R3']);
  assert.deepEqual(named('Shelf 01', 2), ['Shelf01', 'Shelf02']);
  assert.deepEqual(named('Bin', 1), ['Bin']);
  assert.deepEqual(named('Bin', 2), ['Bin1', 'Bin2']);
  assert.deepEqual(named('Floor, Middle, Top', 3), ['Floor', 'Middle', 'Top']);
  assert.throws(() => seriesFromName('Left, Right', 3), /you have 3 but named 2/);
  assert.throws(() => seriesFromName('Top, top', 2), /same/);
  assert.throws(() => seriesFromName('X', 5), /letters run out at Z/);
  assert.throws(() => seriesFromName('#1', 2), /a name is/);
  assert.throws(() => seriesFromName('A', 0), /whole number/);
});

test('guided sections can mix racks and shelves, and a later section copies the one before', () => {
  const { guided } = require('../src/locations');
  const out = guided({
    sections: { count: 3, name: 'North, South, Garage' },
    layouts: [
      { type: 'rack', aisles: { count: 2, name: '01' }, bays: { count: 3, name: '1' }, positions: { count: 2 }, levels: { count: 3, name: 'A' } },
      { type: 'shelf', aisles: { count: 1 }, bays: { count: 2, name: 'Shelf 1' }, positions: { count: 4, name: 'Bin 1' }, levels: { count: 3, name: 'Floor, Middle, Top' } },
    ],
  });
  assert.deepEqual(out.plans.map((p) => [p.section, p.type, p.total]), [['North', 'rack', 36], ['South', 'shelf', 24], ['Garage', 'shelf', 24]]);
  assert.equal(out.plans[0].sampleCode, 'North-01-1-1-A');
  assert.equal(out.plans[0].lastCode, 'North-02-3-2-C');
  assert.equal(out.plans[1].sampleCode, 'South-Shelf1-Bin1-Floor');
  assert.equal(out.plans[1].capacity.maxWeightKg, 25, 'a shelf starts with shelf-sized defaults');
  assert.equal(out.total, 84);
  const home = guided({ sections: { count: 1 }, layouts: [{ type: 'shelf', bays: { count: 3, name: 'Shelf 1' }, levels: { count: 4, name: '1' } }] });
  assert.equal(home.sampleCode, 'Shelf1-1');
  assert.equal(home.total, 12);
  assert.throws(() => guided({ sections: { count: 1 }, layouts: [{ type: 'shelf' }] }), /name at least one thing/);
  assert.throws(() => guided({ sections: { count: 2 }, layouts: [{ type: 'rack', aisles: { count: 3, name: 'Left, Right' } }] }), /Section 1: aisles: you have 3 but named 2/, 'errors name the section');
});

test('guided locations are created through the API as rack slots and shelf bins', async () => {
  const site = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'server', 'site.example.json'), 'utf8'));
  const store = new Store({ site });
  const auth = createAuth(store.db);
  auth.ensureDemoUsers();
  const server = createServer({ store, printers: new Printers({}), auth });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = async (username, password) => (await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) })).headers.get('set-cookie').split(';')[0];
  const call = async (p, body, cookie) => {
    const res = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const answers = {
    sections: { count: 2, name: 'Hall 1' },
    layouts: [
      { type: 'rack', aisles: { count: 1, name: 'A' }, bays: { count: 2, name: '01' }, positions: { count: 1 }, levels: { count: 2, name: '1' } },
      { type: 'shelf', aisles: { count: 1 }, bays: { count: 1, name: 'Wall' }, positions: { count: 3, name: 'Bin 1' }, levels: { count: 2, name: 'Bottom, Top' }, capacity: { maxWeightKg: 5 } },
    ],
  };
  try {
    const admin = await login('admin', 'sorted-admin');
    const operator = await login('operator', 'sorted-operator');
    const preview = await call('/api/locations/guided/preview', { answers }, admin);
    assert.equal(preview.status, 200, preview.body.error);
    assert.equal(preview.body.total, 10);
    assert.deepEqual(preview.body.plans.map((p) => p.sampleCode), ['Hall1-A-01-1', 'Hall2-Wall-Bin1-Bottom']);
    assert.equal((await call('/api/locations/guided', { answers }, operator)).status, 403);
    const made = await call('/api/locations/guided', { answers }, admin);
    assert.equal(made.status, 200, made.body.error);
    assert.equal(made.body.created, 10);
    const slot = store.wh.locations['Hall1-A-01-1'];
    assert.equal(slot.kind, 'rack');
    assert.equal(slot.structural, false, 'a rack position holds a pallet');
    const bin = store.wh.locations['Hall2-Wall-Bin3-Top'];
    assert.equal(bin.kind, 'bin');
    assert.equal(bin.storageType, 'shelf');
    assert.equal(bin.capacity.maxWeightKg, 5);
    assert.deepEqual(store.wh.setup.guided, answers, 'the wizard opens where it left off');
    const again = await call('/api/locations/guided', { answers }, admin);
    assert.equal(again.body.created, 0);
    assert.equal(again.body.skipped, 10);
    const bad = await call('/api/locations/guided', { answers: { sections: { count: 1 }, layouts: [{ type: 'rack', levels: { count: 3, name: 'Top, Bottom' } }] } }, admin);
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /you have 3 but named 2/);
  } finally {
    await new Promise((r) => server.close(r));
    store.close();
  }
});
