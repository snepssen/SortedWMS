const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Warehouse } = require('../src/engine');
const { Store } = require('../server/store');
const { createAuth } = require('../server/auth');
const { createServer } = require('../server/index');
const { Printers } = require('../server/print');
const { permissionFor, DEFAULTS } = require('../server/permissions');

const site = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'server', 'site.example.json'), 'utf8'));

function wh() {
  const w = new Warehouse({ aisles: [1], bays: 1, levels: 1, positions: [10], outLanes: 1 });
  w.addItem({ itemNo: 'SKU1', name: 'Box', category: 'YOG', palletQty: 1, weightKg: 5, lengthMm: 400, widthMm: 300, heightMm: 200 });
  return w;
}

test('a profile bulk-creates a range and put-away refuses or warns when capacity is exceeded', () => {
  const w = wh();
  assert.ok(w.locationProfilesView().some((p) => p.id === 'frozen' && p.storageType === 'rack'));
  assert.ok(w.locationProfilesView().some((p) => p.id === 'home' && p.storageType === 'shelf'));
  const custom = w.saveLocationProfile({ name: 'Cage', storageType: 'shelf', temperature: 'ambient', security: 'high', autoSort: 'nearest', label: 'Cage', maxUnits: 1, maxWeightKg: 20, capacityMode: 'refuse' });
  assert.equal(custom.id, 'cage');
  const made = w.bulkLocations({ profileId: 'cage', aisleFrom: '01', aisleTo: '02', bayFrom: '01', bayTo: '01', heightFrom: 'A', heightTo: 'B' });
  assert.equal(made.created, 4);
  const loc = w.locations['SH-01-01-A'];
  assert.equal(loc.storageType, 'shelf');
  assert.equal(loc.capacity.maxUnits, 1);
  w.stockPallet('SH-01-01-A', { itemNo: 'SKU1', batch: 'B', expiry: '2027-01-01', qty: 1 });
  assert.throws(() => w.stockPallet('SH-01-01-A', { itemNo: 'SKU1', batch: 'C', expiry: '2027-01-01', qty: 1 }), /holds 1/);

  w.saveLocationProfile({ name: 'Soft shelf', storageType: 'shelf', maxUnits: 1, capacityMode: 'warn' });
  w.bulkLocations({ profileId: 'soft-shelf', aisleFrom: '03', aisleTo: '03', bayFrom: '01', bayTo: '01', heightFrom: 'A', heightTo: 'A' });
  w.stockPallet('SH-03-01-A', { itemNo: 'SKU1', batch: 'B', expiry: '2027-01-01', qty: 1 });
  w.stockPallet('SH-03-01-A', { itemNo: 'SKU1', batch: 'C', expiry: '2027-01-01', qty: 1 });
  assert.match(w.events[0].text, /Warning: SH-03-01-A holds 1/);

  w.bulkLocations({ profileId: 'frozen', aisleFrom: '09', aisleTo: '09', bayFrom: '01', bayTo: '01', heightFrom: 'A', heightTo: 'A' });
  const heavy = w.addItem({ itemNo: 'HEAVY', name: 'Heavy', category: 'YOG', palletQty: 1, weightKg: 5000, lengthMm: 400, widthMm: 300, heightMm: 200 });
  assert.throws(() => w.stockPallet('09-01-A-01', { itemNo: heavy.itemNo, batch: 'H', expiry: '2027-01-01', qty: 1 }), /does not fit/);
  w.saveLocationProfile({ name: 'Lane', storageType: 'block', stackHeight: 2, footprintLengthMm: 1200, footprintWidthMm: 800, capacityMode: 'refuse' });
  w.bulkLocations({ profileId: 'lane', aisleFrom: '04', aisleTo: '04', bayFrom: '01', bayTo: '01', heightFrom: 'A', heightTo: 'A' });
  assert.equal(w.locations['BLK-04-01-A'].capacity.stackHeight, 2);
  w.addItem({ itemNo: 'WIDE', name: 'Wide', category: 'YOG', palletQty: 1, lengthMm: 2000, widthMm: 2000, heightMm: 100, weightKg: 1 });
  assert.throws(() => w.stockPallet('BLK-04-01-A', { itemNo: 'WIDE', batch: 'W', expiry: '2027-01-01', qty: 1 }), /footprint/);
});

test('only the technical role edits location profiles', async () => {
  assert.equal(permissionFor('POST', '/api/location-profiles').permission, 'technical.write');
  assert.equal(permissionFor('POST', '/api/locations/bulk').permission, 'technical.write');
  assert.equal(DEFAULTS.technician.includes('technical.write'), true);
  assert.equal(DEFAULTS.office.includes('technical.write'), false);
  const store = new Store({ site });
  const auth = createAuth(store.db);
  auth.ensureDemoUsers();
  const server = createServer({ store, printers: new Printers({}), auth });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body, headers = {}) => {
    const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch (e) { parsed = text; }
    return { status: res.status, body: parsed, headers: res.headers };
  };
  const sign = async (username, password) => {
    const res = await call('POST', '/api/login', { username, password });
    return ((res.headers.getSetCookie && res.headers.getSetCookie()[0]) || res.headers.get('set-cookie') || '').split(';')[0];
  };
  try {
    const office = await sign('office', 'sorted-office');
    assert.equal((await call('POST', '/api/location-profiles', { name: 'Nope', storageType: 'shelf', maxUnits: 1 }, { cookie: office })).status, 403);
    const tech = await sign('tech', 'sorted-tech');
    const saved = await call('POST', '/api/location-profiles', { name: 'Secure cage', storageType: 'rack', temperature: 'ambient', security: 'high', autoSort: 'secure', label: 'Secure', positionsPerLevel: 1, heightMm: 1500, widthMm: 900, maxWeightKg: 400 }, { cookie: tech });
    assert.equal(saved.status, 200, saved.body && saved.body.error);
    assert.equal(saved.body.id, 'secure-cage');
    const bulk = await call('POST', '/api/locations/bulk', { profileId: 'secure-cage', aisleFrom: '01', aisleTo: '01', bayFrom: '01', bayTo: '02', heightFrom: 'A', heightTo: 'A' }, { cookie: tech });
    assert.equal(bulk.status, 200, bulk.body && bulk.body.error);
    assert.equal(bulk.body.created, 2);
    assert.ok(store.journal({ op: 'saveLocationProfile' }).some((r) => r.by === 'tech'));
    assert.match(store.wh.events[0].text, /created by tech/);
  } finally {
    await new Promise((r) => server.close(r));
    store.close();
  }
});
