const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Warehouse } = require('../src/engine');
const { Store } = require('../server/store');
const { createAuth } = require('../server/auth');
const { permissionFor } = require('../server/permissions');

function wh() {
  const w = new Warehouse({ aisles: [1], bays: 2, levels: 1, positions: [10], outLanes: 1, clock: () => Date.UTC(2026, 9, 8, 8) });
  w.setFeatures({ lotExpiry: true, fefo: true });
  w.addClient({ id: 'CL-1', name: 'North Shop' });
  w.addItem({ itemNo: 'SKU1', name: 'Mug', category: 'YOG', palletQty: 10, clientId: 'CL-1', lengthMm: 1000, widthMm: 800, heightMm: 500 });
  w.createLocation({ code: 'MEZZ-A1', kind: 'mezzanine', name: 'Mezzanine' });
  return w;
}

test('a mixed order dispatches once, with one note and a load scan for every holder', () => {
  const w = wh();
  const pallet = w.stockPallet('01-01-0-10', { itemNo: 'SKU1', batch: 'B', expiry: '2027-01-01', qty: 10 });
  w.addOrder({ id: 'MIX', customer: 'North Shop', lane: 'OUT-01', clientId: 'CL-1', lines: [{ itemNo: 'SKU1', pallets: 1 }, { itemNo: 'SKU1', units: 2 }] });
  w.transferPallet(pallet.sscc, 'OUT-01', { by: 'mina' });
  w.pallets[pallet.sscc].checked = true;
  w.issueSeries({ series: 'ST', itemNo: 'SKU1', qty: 2, loc: 'MEZZ-A1' });
  w.pickHolder({ id: 'ST0000001', orderId: 'MIX', qty: 2 });
  const carton = w.openCarton({ orderId: 'MIX' });
  w.packIntoCarton({ carton: carton.id, code: 'ST0000001', qty: 2 });
  w.closeCarton({ carton: carton.id, lengthMm: 300, widthMm: 200, heightMm: 150, weightKg: 1 });
  const staged = w.stageShipment({ orderId: 'MIX', truck: 'HH01', by: 'olivia' });
  assert.equal(staged.status, 'staged');
  assert.equal(staged.holders.length, 2);
  assert.throws(() => w.dispatchShipment({ orderId: 'MIX' }), /every pallet and carton/);
  w.scanShipment({ orderId: 'MIX', code: pallet.sscc, by: 'olivia' });
  assert.equal(w.orders.MIX.shipment.status, 'staged');
  assert.throws(() => w.scanShipment({ orderId: 'MIX', code: pallet.sscc }), /already confirmed/);
  w.scanShipment({ orderId: 'MIX', code: carton.id, by: 'olivia' });
  assert.equal(w.orders.MIX.shipment.status, 'loaded');
  const note = w.deliveryNote('MIX');
  assert.match(note, /Delivery note MIX/);
  assert.match(note, /Load manifest/);
  assert.match(note, new RegExp(pallet.sscc));
  assert.match(note, /OUT0000001/);
  assert.match(note, /HH01/);
  w.dispatchShipment({ orderId: 'MIX', by: 'olivia' });
  assert.equal(w.orders.MIX.shipment.status, 'dispatched');
  assert.equal(w.orders.MIX.status, 'shipped');
  assert.equal(w.shipments.length, 1);
  assert.equal(w.shipments[0].pallets.length, 1);
  assert.equal(w.shipments[0].cartons.length, 1);
  assert.equal(w.pallets[pallet.sscc].status, 'shipped');
});

test('unit replenishment splits the source plate and a pallet face still moves the whole pallet', () => {
  const w = wh();
  const source = w.stockPallet('01-01-0-10', { itemNo: 'SKU1', batch: 'B', expiry: '2027-01-01', qty: 20 });
  w.issueSeries({ series: 'ST', itemNo: 'SKU1', qty: 1, loc: 'MEZZ-A1' });
  w.setPickFace({ code: 'MEZZ-A1', itemNo: 'SKU1', min: 1, max: 5, trigger: 1, mode: 'units' });
  const task = w.planReplenishment()[0];
  assert.equal(task.splitQty, 4);
  w._remove(source);
  const truck = { id: 'RT1', load: source.sscc, stats: { jobs: 0, moves: 0, moveInputs: 0 } };
  const done = w.applySplitDrop(truck, task);
  assert.equal(source.qty, 16);
  assert.equal(source.loc, '01-01-0-10');
  assert.equal(done.holder.contents[0].qty, 4);
  assert.equal(done.holder.loc, 'MEZZ-A1');
  assert.equal(w._faceQty(w.locations['MEZZ-A1']), 5);

  w.setPickFace({ code: '01-02-0-10', itemNo: 'SKU1', min: 0, max: 20, trigger: 0, mode: 'pallet' });
  const whole = w.planReplenishment().find((t) => t.to === '01-02-0-10');
  assert.ok(whole);
  assert.equal(whole.splitQty, null);
});

test('a refused transfer returns the original plate and a received transfer does not mint one on the source', () => {
  const source = wh();
  const dest = wh();
  const pallet = source.stockPallet('DOCK-IN', { itemNo: 'SKU1', batch: 'T', expiry: '2027-06-01', qty: 4 });
  const before = source.holderSeries.ST.next;
  const sent = source.shipTransfer({ id: 'TR1', itemNo: 'SKU1', qty: 4, toSite: 'NORTH', fromSite: 'MAIN' });
  assert.equal(pallet.loc, 'IN-TRANSIT');
  assert.equal(pallet.status, 'available');
  source.cancelSiteTransfer({ id: 'TR1' });
  assert.equal(pallet.loc, 'DOCK-IN');
  assert.equal(source.holderSeries.ST.next, before);
  source.shipTransfer({ id: 'TR2', itemNo: 'SKU1', qty: 4, toSite: 'NORTH', fromSite: 'MAIN' });
  const got = dest.receiveSiteTransfer(source.siteTransfers.TR2);
  source.completeSiteTransfer({ id: 'TR2' });
  assert.equal(got.holder.series, 'ST');
  assert.equal(pallet.status, 'shipped');
  assert.equal(source.holderSeries.ST.next, before);
  assert.equal(sent.sscc, pallet.sscc);
});

test('a tariff invoice covers storage, handling, kitting and the monthly minimum', () => {
  const w = wh();
  w.setTariff('CL-1', { storageBasis: 'pallet-day', storageRate: 2, inboundBasis: 'pallet', inboundRate: 3, outboundBasis: 'carton', outboundRate: 4, valRate: 0.5, minimum: 100 });
  const pallet = w.stockPallet('01-01-0-10', { itemNo: 'SKU1', batch: 'B', expiry: '2027-01-01', qty: 10, clientId: 'CL-1' });
  pallet.receivedAt = w.now() - 2 * 86400000;
  w.recordMovement({ sscc: pallet.sscc, holder: 'ST1', from: 'DOCK-IN', to: '01-01-0-10', qty: 1, event: 'kitted', by: 'omar' });
  w.holders.ST1 = { id: 'ST1', clientId: 'CL-1', contents: [] };
  const inv = w.invoice({ clientId: 'CL-1' });
  assert.ok(inv.palletDays >= 1.9 && inv.palletDays <= 2.1);
  assert.equal(inv.lines.find((l) => l.code === 'val').qty, 1);
  assert.equal(inv.total, 100);
  const html = w.invoiceHtml({ clientId: 'CL-1' });
  assert.match(html, /Invoice CL-1/);
  assert.match(html, /Total 100/);
  assert.throws(() => w.setTariff('CL-1', { storageBasis: 'hour' }), /pallet-day/);
});

test('every mutating API route names a permission, and a backup restores the journal', () => {
  const api = fs.readFileSync(path.join(__dirname, '..', 'server', 'api.js'), 'utf8');
  const routes = [...api.matchAll(/on\('([A-Z]+)', '([^']+)'/g)];
  assert.ok(routes.length > 40);
  for (const [, method, pattern] of routes) {
    const sample = pattern.replace(/:(\w+)/g, 'x');
    const access = permissionFor(method, sample);
    if (method !== 'GET' && method !== 'HEAD') assert.equal(access.public, false, `${method} ${pattern} is public`);
    assert.ok(access.permission, `${method} ${pattern} has no permission`);
  }
  assert.equal(permissionFor('POST', '/api/backup').permission, 'settings.write');
  assert.equal(permissionFor('POST', '/api/orders/MIX/shipment/scan').permission, 'outbound.write');
  assert.equal(permissionFor('GET', '/api/orders/MIX/delivery-note').permission, 'orders.read');

  const site = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'server', 'site.example.json'), 'utf8'));
  const store = new Store({ site });
  const auth = createAuth(store.db);
  auth.ensureAdmin({ username: 'admin', password: 'sorted-admin', displayName: 'Administrator' });
  const before = store.journal().length;
  store.exec('setConfig', { patch: { aisleCap: 2 } }, 'admin');
  assert.ok(store.journal().length > before, 'the mutation is in the audit journal');
  const dump = store.exportBackup();
  store.exec('setConfig', { patch: { aisleCap: 3 } }, 'admin');
  assert.equal(store.wh.config.aisleCap, 3);
  const restored = store.importBackup(dump);
  assert.equal(restored.journal, dump.journal.length);
  assert.equal(store.wh.config.aisleCap, 2);
  assert.throws(() => store.importBackup({ version: 2, journal: [] }), /version 1/);
  store.close();
});

test('plate numbers stay seven digits unless a series changes its padding', () => {
  const w = wh();
  assert.equal(w.holderSeries.PAL.pad, 7);
  assert.equal(w.allocatePlate('PAL').id, 'PAL0000001');
  w.setHolderSeries({ OUT: { pad: 4 } });
  assert.equal(w.allocatePlate('OUT').id, 'OUT0001');
});
