const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Warehouse } = require('../src/engine');
const { PRESETS, MODULES } = require('../src/presets');
const { Store } = require('../server/store');
const { Printers } = require('../server/print');
const { createServer } = require('../server/index');
const { createAuth } = require('../server/auth');

function wh() {
  const w = new Warehouse({ aisles: [1], bays: 2, levels: 1, positions: [10], outLanes: 1, clock: () => Date.UTC(2026, 9, 8, 8) });
  w.addItem({ itemNo: 'Y1', name: 'Paint', category: 'GEN', palletQty: 10, uom: 'piece' });
  return w;
}

test('every module is on in a warehouse that never chose, and a home preset turns them off with simple screens', () => {
  const w = wh();
  for (const [id] of MODULES) assert.equal(w.module(id), true, id);
  w.applyPreset('home-garage');
  for (const [id] of MODULES) assert.equal(w.module(id), false, id);
  assert.equal(w.moduleList().simple, true);
  const maker = PRESETS.find((p) => p.id === 'small-maker');
  assert.equal(maker.modules.kitting, true);
  assert.equal(maker.modules.trucks, false);
  assert.ok(Object.values(PRESETS.find((p) => p.id === 'chilled-dc').modules).filter((v) => v === true).length >= MODULES.length, 'the full demo keeps everything');
});

test('with trucks off nobody is given a truck job and Auto-Shift plans nothing', () => {
  const w = wh();
  w.addTruck('T1', { position: 'DOCK-IN' });
  w.setModules({ trucks: false });
  w.stockPallet('01-01-0-10', { itemNo: 'Y1', qty: 10, receivedAt: 1 });
  w.addOrder({ id: 'O1', customer: 'Shop', lane: 'OUT-01', lines: [{ itemNo: 'Y1', pallets: 1 }] });
  w.dispatch();
  assert.equal(w.trucks.T1.taskId, null);
  assert.equal(w.planRelocations(), 0);
  w.setModules({ trucks: true });
  w.dispatch();
  assert.ok(w.trucks.T1.taskId, 'switching trucks on hands out the waiting job');
  const job = w.tasks[w.trucks.T1.taskId];
  job.status = 'active';
  assert.throws(() => w.setModules({ trucks: false }), /under way/);
});

test('pick waves off: no waves, by hand or from the queue; billing needs clients', () => {
  const w = wh();
  w.setModules({ waves: false });
  w.addOrder({ id: 'O1', customer: 'Shop', lane: 'OUT-01', lines: [{ itemNo: 'Y1', units: 3 }] });
  assert.throws(() => w.planWave({}), /Pick waves are switched off/);
  assert.equal(w.autoWave(), null);
  assert.throws(() => w.setModules({ clients: false }), /3PL billing needs Clients/);
  w.setModules({ billing: false, clients: false });
  assert.equal(w.module('clients'), false);
  assert.throws(() => w.setModules({ forklifts: false }), /Unknown module forklifts/);
});

test('a module that is off refuses reads and writes, and a manager can switch modules', async () => {
  const site = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'site.json'), 'utf8'));
  const store = new Store({ site });
  const auth = createAuth(store.db);
  auth.ensureDemoUsers();
  const server = createServer({ store, printers: new Printers({}), auth });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = async (username, password) => (await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) })).headers.get('set-cookie').split(';')[0];
  const call = async (method, p, body, cookie) => {
    const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };
  try {
    const admin = await login('admin', 'sorted-admin');
    const office = await login('office', 'sorted-office');
    const picker = await login('picker', 'sorted-picker');
    assert.equal((await call('POST', '/api/setup/modules', { modules: { kitting: false } }, office)).status, 403);
    const set = await call('POST', '/api/setup/modules', { modules: { kitting: false, sites: false, transfers: false } }, admin);
    assert.equal(set.status, 200, set.body.error);
    const listed = await call('GET', '/api/modules', null, picker);
    assert.equal(listed.body.modules.find((m) => m.id === 'kitting').on, false);
    const refused = await call('POST', '/api/val/start', { stationId: 'VAL-01' }, picker);
    assert.equal(refused.status, 403);
    assert.match(refused.body.error, /Kitting is switched off/);
    assert.equal((await call('GET', '/api/val', null, picker)).status, 404, 'a read is not found either');
    assert.equal((await call('POST', '/api/sites', { id: 'NORTH', name: 'North' }, admin)).status, 403);
    const setup = await call('GET', '/api/setup', null, admin);
    assert.equal(setup.body.modules.modules.find((m) => m.id === 'sites').on, false);
    const home = await call('POST', '/api/setup/preset', { id: 'home-garage' }, admin);
    assert.equal(home.body.modules.simple, true);
    store.load();
    assert.equal(store.wh.module('trucks'), false, 'the journal replays the choice');
  } finally {
    await new Promise((r) => server.close(r));
    store.close();
  }
});

test('with no trucks, inbound puts a received pallet away by hand where the system would', () => {
  const w = new Warehouse({ aisles: [1], bays: 2, levels: 2, positions: [10], outLanes: 1, clock: () => Date.UTC(2026, 9, 8, 8) });
  w.addItem({ itemNo: 'Y1', name: 'Paint', category: 'GEN', palletQty: 10 });
  w.setModules({ trucks: false });
  w.addItem({ itemNo: 'C1', name: 'Gravel', category: 'BULK', palletQty: 10 });
  for (const loc of w._racks()) loc.category = 'GEN';
  w.locations['01-02-0-10'].category = 'BULK';
  w._forgetPlaces();
  const p = w.stockPallet('DOCK-IN', { itemNo: 'Y1', qty: 10, receivedAt: 1 });
  const hint = w.putAwaySlot(p.sscc);
  assert.ok(hint.to, 'a slot is suggested');
  assert.equal(w.locations[hint.to].category, 'GEN');
  assert.throws(() => w.putAwayPallet({ sscc: p.sscc, to: '01-02-0-10' }), /not free for this pallet/, 'a garden stock slot is not for paint');
  w.createLocation({ code: 'BIN-1', kind: 'bin' });
  assert.throws(() => w.putAwayPallet({ sscc: p.sscc, to: 'BIN-1' }), /rack or a block lane/);
  w.raiseCheck({ loc: hint.to, note: 'Beam looks bent' });
  assert.throws(() => w.putAwayPallet({ sscc: p.sscc, to: hint.to }), /held for stock check/);
  const out = w.putAwayPallet({ sscc: p.sscc, by: 'ines' });
  assert.notEqual(out.to, hint.to, 'the held slot is not chosen');
  assert.equal(w.pallets[p.sscc].loc, out.to);
  assert.equal(w.movements[0].by, 'ines');
  assert.throws(() => w.putAwayPallet({ sscc: p.sscc }), /already in storage/);
});

test('enabling offers the dependency, disabling keeps the data, and the journal names the user', async () => {
  const site = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'server', 'site.blank.json'), 'utf8'));
  const store = new Store({ site });
  const auth = createAuth(store.db);
  auth.ensureDemoUsers();
  const server = createServer({ store, printers: new Printers({}), auth });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = async (username, password) => (await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) })).headers.get('set-cookie').split(';')[0];
  const call = async (method, p, body, cookie) => {
    const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let parsed; try { parsed = JSON.parse(text); } catch (e) { parsed = text; }
    return { status: res.status, body: parsed };
  };
  try {
    const admin = await login('admin', 'sorted-admin');
    const manager = await login('manager', 'sorted-manager');
    await call('POST', '/api/clients', { id: 'CL-1', name: 'North Shop' }, admin);
    await call('POST', '/api/items', { itemNo: 'SKU1', name: 'Mug', category: 'GEN', palletQty: 10, clientId: 'CL-1' }, admin);
    const tariff = await call('POST', '/api/clients/CL-1/tariff', { storageBasis: 'pallet-day', storageRate: 1, inboundRate: 0, outboundRate: 0, valRate: 0, minimum: 0 }, admin);
    assert.equal(tariff.status, 200, tariff.body.error);
    const refused = await call('POST', '/api/setup/modules', { modules: { clients: false } }, admin);
    assert.equal(refused.status, 409);
    assert.match(refused.body.error, /3PL billing needs Clients/);
    assert.equal(refused.body.offer, 'disable');
    const off = await call('POST', '/api/setup/modules', { modules: { clients: false }, disableDependents: true }, admin);
    assert.equal(off.status, 200, off.body.error);
    assert.equal(off.body.modules.find((m) => m.id === 'billing').on, false);
    assert.equal(off.body.modules.find((m) => m.id === 'returns').on, true);
    assert.equal(store.wh.clients['CL-1'].name, 'North Shop');
    assert.ok(store.wh.clients['CL-1'].tariff, 'the rate card is kept');
    assert.equal((await call('GET', '/api/clients', null, admin)).status, 404);
    assert.equal((await call('GET', '/api/reports/invoice', null, admin)).status, 404);
    const back = await call('POST', '/api/setup/modules', { modules: { billing: true }, enableDependencies: true }, admin);
    assert.equal(back.status, 200, back.body.error);
    assert.equal(store.wh.module('clients'), true);
    assert.equal(store.wh.module('billing'), true);
    assert.equal(store.wh.clients['CL-1'].tariff.storageRate, 1);
    const row = store.journal({ op: 'setModules', limit: 1 })[0];
    assert.equal(row.by, 'admin');
    const roles = await call('GET', '/api/roles', null, admin);
    store.wh.setModules({ billing: false });
    const hidden = await call('GET', '/api/roles', null, admin);
    assert.equal(roles.body.permissions.some((p) => p.id === 'tariff.write'), true);
    assert.equal(hidden.body.permissions.some((p) => p.id === 'tariff.write'), false);
    const officeBefore = auth.catalog().roles.find((r) => r.id === 'office').permissions;
    assert.equal(officeBefore.includes('tariff.write'), true);
    const saved = await call('POST', '/api/roles/office', { permissions: hidden.body.permissions.map((p) => p.id).filter((id) => officeBefore.includes(id)) }, admin);
    assert.equal(saved.status, 200, saved.body.error);
    assert.equal(saved.body.permissions.includes('tariff.write'), true, 'a hidden permission stays on the role');
    assert.equal((await call('POST', '/api/setup/modules', { modules: { kitting: false } }, manager)).status, 200);
    const menu = store.wh.moduleList();
    assert.equal(menu.modules.find((m) => m.id === 'kitting').menu.some((item) => item.id === 'kitting'), true);
    assert.equal(menu.modules.find((m) => m.id === 'kitting').on, false);
    const modes = (await call('GET', '/api/devices/HH-none', null, admin)).body;
    store.exec('addTruck', { id: 'HH1' }, 'admin');
    store.exec('setModules', { modules: { trucks: false } }, 'manager');
    const truck = await call('GET', '/api/devices/HH1', null, admin);
    assert.equal(truck.status, 404);
    assert.equal(store.wh.trucks.HH1.id, 'HH1', 'the truck is still there');
  } finally {
    await new Promise((r) => server.close(r));
    store.close();
  }
});
