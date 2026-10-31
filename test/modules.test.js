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
  w.addItem({ itemNo: 'Y1', name: 'Yoghurt', category: 'YOG', palletQty: 10, uom: 'piece' });
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

test('a module that is off refuses its changes over the API, reads still answer, and only an administrator switches', async () => {
  const site = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'server', 'site.example.json'), 'utf8'));
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
    const set = await call('POST', '/api/setup/modules', { modules: { kitting: false, sites: false } }, admin);
    assert.equal(set.status, 200, set.body.error);
    const listed = await call('GET', '/api/modules', null, picker);
    assert.equal(listed.body.modules.find((m) => m.id === 'kitting').on, false);
    const refused = await call('POST', '/api/val/start', { stationId: 'VAL-01' }, picker);
    assert.equal(refused.status, 409);
    assert.match(refused.body.error, /Kitting is switched off/);
    assert.equal((await call('GET', '/api/val', null, picker)).status, 200, 'reads still answer');
    assert.equal((await call('POST', '/api/sites', { id: 'NORTH', name: 'North' }, admin)).status, 409);
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
