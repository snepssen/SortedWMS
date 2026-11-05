const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const registry = require('../modules/registry');
const { Store } = require('../server/store');

const CORE = ['abc', 'billing', 'bins', 'camera', 'clients', 'connections', 'demo', 'food', 'item-value', 'kitting', 'lots', 'quarantine', 'reports', 'return-move', 'returns', 'serials', 'sites', 'stations', 'terminal', 'transfers', 'trucks', 'waves'];

test('core modules declare the manifest fields and the presets agree with the original seven', () => {
  const list = registry.modules();
  assert.deepEqual(list.map((mod) => mod.id), CORE);
  for (const mod of list) {
    assert.ok(mod.name && mod.description, mod.id);
    assert.equal(mod.version, 1, mod.id);
    assert.ok(Array.isArray(mod.dependencies) && Array.isArray(mod.conflicts), mod.id);
    assert.ok(Array.isArray(mod.routes) && Array.isArray(mod.menu), mod.id);
    assert.ok(mod.upgrades && mod.upgrades[0].id, mod.id);
  }
  const billing = registry.get('billing');
  assert.deepEqual(billing.dependencies, ['clients']);
  assert.equal(billing.name, '3PL billing');
  assert.deepEqual(registry.get('transfers').dependencies, ['sites']);
  const home = registry.presetModules('home-garage');
  for (const id of ['trucks', 'waves', 'kitting', 'stations', 'clients', 'billing', 'sites']) assert.equal(home[id], false, id);
  assert.equal(home.bins, true);
  assert.equal(home.camera, true);
  const chilled = registry.presetModules('chilled-dc');
  for (const id of CORE) {
    if (registry.get(id).defaultOn === false) {
      assert.equal(chilled[id], false, id);
      continue;
    }
    assert.equal(chilled[id], true, id);
  }
  const maker = registry.presetModules('small-maker');
  assert.equal(maker.kitting, true);
  assert.equal(maker.trucks, false);
  const described = registry.describe(null);
  assert.equal(described.find((mod) => mod.id === 'returns').label, 'Returns');
  assert.equal(described.find((mod) => mod.id === 'returns').on, true);
});

test('dependency resolution enables, refuses, and reports conflicts', () => {
  const manifests = [
    { id: 'clients', name: 'Clients', dependencies: [], conflicts: [] },
    { id: 'billing', name: '3PL billing', dependencies: ['clients'], conflicts: [] },
    { id: 'paper', name: 'Paper pick lists', dependencies: [], conflicts: ['scanner'] },
    { id: 'scanner', name: 'Scanner', dependencies: [], conflicts: [] },
  ];
  const quiet = { paper: false };
  assert.throws(() => registry.resolveChange(manifests, quiet, { forklifts: false }), /Unknown module forklifts/);
  assert.throws(() => registry.resolveChange(manifests, { ...quiet, billing: true }, { clients: false }), (err) => {
    assert.match(err.message, /3PL billing needs Clients/);
    assert.deepEqual(err.needs, ['clients']);
    assert.equal(err.offer, 'disable');
    return true;
  });
  const enabled = registry.resolveChange(manifests, { ...quiet, clients: false, billing: false }, { billing: true }, { enableDependencies: true });
  assert.equal(enabled.billing, true);
  assert.equal(enabled.clients, true);
  assert.throws(() => registry.resolveChange(manifests, { ...quiet, clients: false, billing: false }, { billing: true }), /3PL billing needs Clients/);
  const disabled = registry.resolveChange(manifests, quiet, { clients: false }, { disableDependents: true });
  assert.equal(disabled.clients, false);
  assert.equal(disabled.billing, false);
  assert.throws(() => registry.resolveChange(manifests, { paper: true, scanner: true }, {}), /Paper pick lists conflicts with Scanner/);
});

test('the longer route wins, reads and writes are refused when the module is off, and permissions hide', () => {
  assert.equal(registry.routeModule('POST', '/api/clients/CL-1/tariff'), 'billing');
  assert.equal(registry.routeModule('POST', '/api/clients'), 'clients');
  assert.equal(registry.routeModule('POST', '/api/sites/transfer'), 'transfers');
  assert.equal(registry.routeModule('GET', '/api/sites'), 'sites');
  assert.equal(registry.routeModule('GET', '/api/items'), null);
  const wh = { module: (id) => id !== 'kitting' && id !== 'billing' };
  const read = registry.denial(wh, 'GET', '/api/val');
  assert.equal(read.status, 404);
  assert.match(read.body.error, /Kitting is switched off/);
  const write = registry.denial(wh, 'POST', '/api/clients/CL-1/tariff');
  assert.equal(write.status, 403);
  assert.equal(write.body.module, 'billing');
  assert.equal(registry.denial(wh, 'GET', '/api/bins'), null);
  const hidden = registry.hiddenPermissions(wh);
  assert.equal(hidden.has('tariff.write'), true);
  assert.equal(hidden.has('val.execute'), true);
  assert.equal(hidden.has('clients.read'), false);
});

test('a third-party folder is loaded from disk, and a cycle is refused', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sorted-mod-'));
  fs.writeFileSync(path.join(dir, 'shelf-talkers.js'), `
    module.exports = {
      id: 'shelf-talkers', name: 'Shelf talkers', description: 'Cards on a bay.', version: 1,
      dependencies: [], conflicts: [], routes: [], menu: [], upgrades: [],
    };
  `);
  try {
    registry.useDirectory(dir);
    assert.ok(registry.modules().some((mod) => mod.id === 'shelf-talkers'));
    fs.writeFileSync(path.join(dir, 'broken.js'), 'module.exports = { name: "No id" };');
    assert.throws(() => registry.modules(), /missing id/);
  } finally {
    registry.useDirectory(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(registry.get('shelf-talkers'), null);
  const dropA = registry.register({
    id: 'cycle-a', name: 'A', description: 'A', version: 1, dependencies: ['cycle-b'], conflicts: [], upgrades: [],
  });
  const dropB = registry.register({
    id: 'cycle-b', name: 'B', description: 'B', version: 1, dependencies: ['cycle-a'], conflicts: [], upgrades: [],
  });
  try {
    assert.throws(() => registry.modules(), /Module cycle/);
  } finally {
    dropA();
    dropB();
  }
  assert.equal(registry.modules().some((mod) => mod.id === 'cycle-a'), false);
});

test('module upgrade steps run on start and a second open does nothing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sorted-mod-db-'));
  const file = path.join(dir, 'live.db');
  const site = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'server', 'site.blank.json'), 'utf8'));
  const store = new Store({ file, site });
  try {
    const rows = store.db.prepare('SELECT module FROM module_settings ORDER BY module').all().map((row) => row.module);
    assert.deepEqual(rows, CORE);
    assert.match(store.upgradeLines.join('\n'), /billing 1 billing-kept/);
    store.close();
    const again = new Store({ file, site });
    assert.match(again.upgradeLines.join('\n'), /nothing pending/);
    assert.equal(again.db.prepare('SELECT COUNT(*) AS n FROM module_settings').get().n, CORE.length);
    again.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
