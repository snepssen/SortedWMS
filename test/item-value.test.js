const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Warehouse } = require('../src/engine');
const GS1 = require('../src/gs1');
const { COMMANDS } = require('../server/commands');
const { fromCsv } = require('../src/intake');
const { Store } = require('../server/store');
const { Printers } = require('../server/print');
const { createServer } = require('../server/index');
const { createAuth } = require('../server/auth');

function wh() {
  const w = new Warehouse({ aisles: [1], bays: 2, levels: 1, positions: [10], outLanes: 1, clock: () => Date.UTC(2026, 10, 5, 8) });
  w.addClient({ id: 'CL-1', name: 'North' });
  return w;
}

test('an item keeps its value in the warehouse currency, from the form, an import and an ASN', () => {
  const w = wh();
  assert.equal(w.currency(), 'EUR');
  w.setCurrency('usd');
  assert.equal(w.currency(), 'USD');
  assert.throws(() => w.setCurrency('dollars'), /three-letter/);
  const item = w.addItem({ itemNo: 'SAW', name: 'Saw', category: 'GEN', palletQty: 10, value: '12.50' });
  assert.equal(item.value, 12.5);
  assert.throws(() => w.addItem({ itemNo: 'BAD', name: 'Bad', category: 'GEN', palletQty: 1, value: -1 }), /0 or more/);
  w.updateItem('SAW', { value: 15 });
  assert.equal(w.items.SAW.value, 15);
  w.updateItem('SAW', { value: '' });
  assert.equal(w.items.SAW.value, null);

  COMMANDS.importItems(w, { rows: [
    { itemNo: 'NAIL', name: 'Nail', category: 'GEN', palletQty: 100, value: 0.02 },
    { itemNo: 'SAW', value: 18 },
  ] });
  assert.equal(w.items.NAIL.value, 0.02);
  assert.equal(w.items.SAW.value, 18);

  w.addItem({ itemNo: 'BOX', name: 'Box', category: 'GEN', palletQty: 20, clientId: 'CL-1' });
  const sscc = GS1.makeSscc('0', '0614141', 1);
  const csv = `ref,supplier,sscc,item,qty,value\nASN1,Mill,${sscc},BOX,20,4.5\n`;
  const [doc] = fromCsv('asn', csv);
  w.intake(doc);
  assert.equal(w.items.BOX.value, 4.5);
});

test('ABC by value uses the stored amount, and the stock-value report prices what is on hand', () => {
  const w = wh();
  w.setCurrency('EUR');
  w.addItem({ itemNo: 'FAST', name: 'Fast', category: 'GEN', palletQty: 10, value: 1 });
  w.addItem({ itemNo: 'SLOW', name: 'Slow', category: 'GEN', palletQty: 10, value: 5000 });
  w.createLocation({ code: 'BIN-A', kind: 'bin', name: 'Bin A' });
  w.createLocation({ code: 'BIN-B', kind: 'bin', name: 'Bin B' });
  for (let i = 0; i < 9; i++) w.recordMovement({ from: 'BIN-A', to: 'ORDER-1', qty: 10, event: 'picked', by: 'picker', note: 'FAST' });
  w.recordMovement({ from: 'BIN-B', to: 'ORDER-1', qty: 1, event: 'picked', by: 'picker', note: 'SLOW' });
  w.setAbc({ basis: 'value' });
  const classes = w.abcClasses();
  assert.equal(classes.items.SLOW.class, 'A');
  assert.equal(classes.items.FAST.class, 'C');

  w.binPut({ loc: 'BIN-A', itemNo: 'FAST', qty: 4 });
  w.stockPallet('01-01-0-10', { itemNo: 'SLOW', qty: 2, batch: 'L', expiry: '2027-01-01' });
  const report = w.stockValueReport();
  assert.equal(report.currency, 'EUR');
  const slow = report.rows.find((r) => r.itemNo === 'SLOW');
  const fast = report.rows.find((r) => r.itemNo === 'FAST');
  assert.equal(slow.unitValue, 5000);
  assert.equal(slow.value, 10000);
  assert.equal(fast.value, 4);
  assert.equal(report.total, 10004);
  w.setModules({ 'item-value': false });
  assert.throws(() => w.stockValueReport(), /switched off/);
  w.setAbc({ basis: 'value' });
  assert.equal(w.abcClasses().items.SLOW.class, 'C', 'value is ignored while the module is off');
});

test('high-value warehouses hide the amount from a role without the permission', async () => {
  const site = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'site.json'), 'utf8'));
  const store = new Store({ site, now: () => Date.UTC(2026, 10, 5, 8) });
  store.exec('addItem', { itemNo: 'GEM', name: 'Gem', category: 'GEN', palletQty: 1, value: 800 });
  store.wh.stockPallet('31-01-0-10', { itemNo: 'GEM', qty: 1, batch: 'A', expiry: '2027-06-01' });
  store.exec('setFeatures', { features: { highValueSecurity: true } });
  store.exec('setCurrency', { currency: 'EUR' });
  const auth = createAuth(store.db);
  auth.ensureDemoUsers();
  auth.setRolePermissions('office', auth.permissionsFor('office').filter((id) => id !== 'items.value'), 'test');
  const server = createServer({ store, printers: new Printers({}), auth });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = async (username, password) => (await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) })).headers.get('set-cookie').split(';')[0];
  const call = async (method, p, body, cookie) => {
    const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });
    const type = res.headers.get('content-type') || '';
    const payload = type.includes('json') ? await res.json() : await res.text();
    return { status: res.status, body: payload };
  };
  try {
    const manager = await login('manager', 'sorted-manager');
    const office = await login('office', 'sorted-office');
    const seen = await call('GET', '/api/items', null, manager);
    assert.equal(seen.body.find((i) => i.itemNo === 'GEM').value, 800);
    const hidden = await call('GET', '/api/items', null, office);
    assert.equal(Object.hasOwn(hidden.body.find((i) => i.itemNo === 'GEM'), 'value'), false);
    const refused = await call('POST', '/api/items/GEM', { value: 1 }, office);
    assert.equal(refused.status, 403);
    const report = await call('GET', '/api/reports/stock-value', null, office);
    assert.equal(report.status, 403);
    const priced = await call('GET', '/api/reports/stock-value.csv', null, manager);
    assert.equal(priced.status, 200);
    assert.match(priced.body, /GEM/);
    assert.match(priced.body, /unit value/);
    const session = await call('GET', '/api/session', null, office);
    assert.equal(session.body.itemValue, false);
    assert.equal(session.body.currency, 'EUR');
  } finally {
    server.close();
    store.close();
  }
});
