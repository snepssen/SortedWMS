const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Store } = require('../server/store');
const { createApi } = require('../server/api');

const site = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'server', 'site.blank.json'), 'utf8'));

function world() {
  const store = new Store({ site });
  store.exec('setModules', { bom: true, kitting: true, lots: true, serials: true }, 'admin');
  store.exec('setFeatures', { lotExpiry: true, fefo: true }, 'office');
  store.exec('addClient', { id: 'CL-A', name: 'North' }, 'office');
  store.exec('addClient', { id: 'CL-B', name: 'South' }, 'office');
  store.exec('addItem', { itemNo: 'BASE', name: 'Base', category: 'GEN', clientId: 'CL-A', palletQty: 1 }, 'office');
  store.exec('addItem', { itemNo: 'PLUG', name: 'Plug', category: 'GEN', clientId: 'CL-A', palletQty: 1 }, 'office');
  store.exec('addItem', { itemNo: 'OTHER', name: 'Other', category: 'GEN', clientId: 'CL-B', palletQty: 1 }, 'office');
  store.exec('addItem', { itemNo: 'KIT', name: 'Kit', category: 'GEN', clientId: 'CL-A', palletQty: 1 }, 'office');
  store.exec('createLocation', { code: 'BIN-1', kind: 'bin', name: 'Bin' }, 'office');
  return store;
}

test('a bill of materials stays with its client, and a build consumes earliest expiry then produces the kit', () => {
  const store = world();
  assert.throws(() => store.exec('setBom', { itemNo: 'KIT', lines: [{ itemNo: 'OTHER', qty: 1 }] }, 'office'), /another client/);
  store.exec('setBom', { itemNo: 'KIT', lines: [{ itemNo: 'BASE', qty: 1 }, { itemNo: 'PLUG', qty: 2 }] }, 'office');
  store.exec('binPut', { loc: 'BIN-1', itemNo: 'BASE', qty: 1, batch: 'B2', expiry: '2027-06-01' }, 'office');
  store.exec('binPut', { loc: 'BIN-1', itemNo: 'BASE', qty: 1, batch: 'B1', expiry: '2026-12-01' }, 'office');
  store.exec('binPut', { loc: 'BIN-1', itemNo: 'PLUG', qty: 2, batch: 'P', expiry: '2027-01-01' }, 'office');
  const built = store.exec('buildKit', { itemNo: 'KIT', qty: 1, loc: 'BIN-1' }, 'office');
  assert.equal(built.qty, 1);
  const used = built.consumed.find((row) => row.itemNo === 'BASE');
  assert.equal(used.batch, 'B1');
  const left = store.wh.binStock['BIN-1'].find((row) => row.itemNo === 'BASE');
  assert.equal(left.batch, 'B2');
  const kit = store.wh.binStock['BIN-1'].find((row) => row.itemNo === 'KIT');
  assert.equal(kit.qty, 1);
  assert.equal(kit.batch, 'B1');
  store.exec('setModules', { bom: false }, 'admin');
  assert.equal(store.wh.boms.KIT.lines.length, 2);
  const api = createApi({ store, printers: { flush() {} } });
  const denied = api.handle('POST', '/api/boms', { itemNo: 'KIT', lines: [{ itemNo: 'PLUG', qty: 1 }] }, 'office');
  assert.equal(denied.status, 403);
  assert.equal(api.handle('GET', '/api/boms', {}, 'office').status, 404);
  store.close();
});

test('serials are required only while that module is on, and a VAL task produces the kit', () => {
  const store = world();
  store.exec('setItemSerials', { itemNo: 'PLUG', on: true }, 'office');
  store.exec('setItemSerials', { itemNo: 'KIT', on: true }, 'office');
  store.exec('setBom', { itemNo: 'KIT', lines: [{ itemNo: 'PLUG', qty: 1 }] }, 'office');
  store.exec('binPut', { loc: 'BIN-1', itemNo: 'PLUG', qty: 1, serials: ['SN1'] }, 'office');
  assert.throws(() => store.exec('buildKit', { itemNo: 'KIT', qty: 1, loc: 'BIN-1' }, 'office'), /serial/i);
  store.exec('binPut', { loc: 'BIN-1', itemNo: 'PLUG', qty: 1, serials: ['SN2'] }, 'office');
  const built = store.exec('buildKit', { itemNo: 'KIT', qty: 1, loc: 'BIN-1', serials: { PLUG: ['SN2'], KIT: ['KIT1'] } }, 'office');
  assert.equal(built.consumed[0].qty, 1);
  assert.equal(store.wh.serials.KIT1.status, 'in');
  store.exec('setModules', { serials: false }, 'admin');
  store.exec('addItem', { itemNo: 'CORD', name: 'Cord', category: 'GEN', clientId: 'CL-A', palletQty: 1 }, 'office');
  store.exec('setBom', { itemNo: 'KIT', lines: [{ itemNo: 'CORD', qty: 1 }] }, 'office');
  store.wh.setItemSerials('KIT', false);
  store.exec('binPut', { loc: 'BIN-1', itemNo: 'CORD', qty: 1 }, 'office');
  const plain = store.exec('buildKit', { itemNo: 'KIT', qty: 1, loc: 'BIN-1' }, 'office');
  assert.equal(plain.qty, 1);
  store.exec('setModules', { bom: true, kitting: true, serials: true, lots: true }, 'admin');
  store.wh.addKit({ id: 'KIT-1', name: 'Kit', output: 'KIT', base: { itemNo: 'BASE', qty: 1 }, components: [{ itemNo: 'PLUG', qty: 1 }] });
  store.wh.addValStation({ id: 'VAL-1', name: 'Bench', kitId: 'KIT-1' });
  store.wh.issueSeries({ series: 'ST', itemNo: 'BASE', qty: 1, loc: 'BIN-1', batch: 'LB', expiry: '2027-02-01' });
  store.wh.issueSeries({ series: 'ST', itemNo: 'PLUG', qty: 1, loc: 'BIN-1' });
  store.exec('setBom', { itemNo: 'KIT', lines: [{ itemNo: 'BASE', qty: 1 }, { itemNo: 'PLUG', qty: 1 }] }, 'office');
  store.wh.startVal({ stationId: 'VAL-1' });
  const plates = Object.values(store.wh.holders).filter((h) => h.series === 'ST');
  for (const plate of plates) store.wh.scanVal({ stationId: 'VAL-1', code: plate.id });
  const made = store.wh.binStock['KIT-OUT'].find((row) => row.itemNo === 'KIT');
  assert.equal(made.qty >= 1, true);
  assert.equal(made.batch, 'LB');
  store.close();
});

function station(store, units = 1) {
  store.exec('setBom', { itemNo: 'KIT', lines: [{ itemNo: 'BASE', qty: 1 }] });
  store.wh.addKit({ id: 'KIT-1', name: 'Kit', output: 'KIT', base: { itemNo: 'BASE', qty: 1 }, components: [{ itemNo: 'PLUG', qty: 1 }] });
  store.wh.addValStation({ id: 'VAL-1', name: 'Bench', kitId: 'KIT-1' });
  const plate = store.wh.issueSeries({ series: 'ST', itemNo: 'BASE', qty: units, loc: 'BIN-1', batch: 'LOT1', expiry: '2027-02-01' });
  return plate.holder;
}

test('a BOM station rejects item-only scans without consuming stock or producing a kit', () => {
  const store = world();
  try {
    const plate = station(store);
    store.wh.startVal({ stationId: 'VAL-1' });
    assert.throws(() => store.wh.scanVal({ stationId: 'VAL-1', code: 'BASE' }), /license plate/);
    assert.equal(plate.contents[0].qty, 1);
    assert.equal(store.wh.binStock?.['KIT-OUT'], undefined);
    store.wh.scanVal({ stationId: 'VAL-1', code: plate.id });
    assert.equal(plate.contents[0].qty, 0);
    assert.equal(store.wh.binStock['KIT-OUT'][0].qty, 1);
  } finally { store.close(); }
});

test('multi-unit work orders preserve each completed kit lot before resetting the scans', () => {
  const store = world();
  try {
    const plate = station(store, 2);
    store.wh.addWorkOrder({ id: 'WO1', kitId: 'KIT-1', qty: 2 });
    store.wh.startVal({ stationId: 'VAL-1', workOrderId: 'WO1' });
    store.wh.scanVal({ stationId: 'VAL-1', code: plate.id });
    assert.equal(store.wh.binStock['KIT-OUT'][0].batch, 'LOT1');
    store.wh.scanVal({ stationId: 'VAL-1', code: plate.id });
    assert.equal(store.wh.binStock['KIT-OUT'][0].qty, 2);
    assert.equal(store.wh.workOrders.WO1.built, 2);
    assert.equal(plate.contents[0].qty, 0);
  } finally { store.close(); }
});

test('customer kit work orders stage a finished unit once', () => {
  const store = world();
  try {
    const plate = station(store);
    store.wh.addOrder({ id: 'SO1', customer: 'North', clientId: 'CL-A', lane: 'OUT-01', lines: [{ itemNo: 'KIT', units: 1 }] });
    store.wh.addWorkOrder({ id: 'WO1', kitId: 'KIT-1', qty: 1, orderId: 'SO1' });
    store.wh.startVal({ stationId: 'VAL-1', workOrderId: 'WO1' });
    store.wh.scanVal({ stationId: 'VAL-1', code: plate.id });
    assert.equal(store.wh.orders.SO1.staged.length, 1);
    assert.equal(store.wh.orders.SO1.staged[0].batch, 'LOT1');
    assert.equal(store.wh.binStock?.['KIT-OUT'], undefined);
  } finally { store.close(); }
});

test('duplicate BOM component lines combine into the full required quantity', () => {
  const store = world();
  try {
    store.wh.setBom({ itemNo: 'KIT', lines: [{ itemNo: 'BASE', qty: 1 }, { itemNo: 'BASE', qty: 2 }] });
    assert.deepEqual(store.wh.boms.KIT.lines, [{ itemNo: 'BASE', qty: 3 }]);
  } finally { store.close(); }
});
