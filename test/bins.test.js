const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Warehouse } = require('../src/engine');
const { Store } = require('../server/store');
const { Printers } = require('../server/print');
const { createServer } = require('../server/index');
const { createAuth } = require('../server/auth');

function wh() {
  const w = new Warehouse({ aisles: [1], bays: 2, levels: 1, positions: [10], outLanes: 1, clock: () => Date.UTC(2026, 9, 8, 8) });
  w.addItem({ itemNo: 'M3', name: 'M3 screw', category: 'YOG', palletQty: 1, uom: 'piece' });
  w.addItem({ itemNo: 'M4', name: 'M4 screw', category: 'YOG', palletQty: 1, uom: 'piece' });
  w.addItem({ itemNo: 'LED', name: 'Red LED', category: 'YOG', palletQty: 1, uom: 'piece' });
  w.setItemUnits('M3', { packs: [{ unit: 'box', per: 100, barcode: '871000000003' }, { unit: 'case', per: 1000 }], unitWeightKg: 0.001 });
  w.generateGuided({ sections: { count: 1 }, layouts: [{ type: 'shelf', bays: { count: 2, name: 'Shelf 1' }, positions: { count: 3, name: 'Bin 1' } }] });
  return w;
}

test('packs convert to the base unit, and a pack barcode puts in a whole pack', () => {
  const w = wh();
  assert.equal(w.items.M3.uom, 'piece');
  assert.deepEqual(w.items.M3.packs.map((p) => [p.unit, p.per]), [['box', 100], ['case', 1000]]);
  assert.equal(w.toBaseUnits('M3', 2, 'case'), 2000);
  assert.equal(w.toBaseUnits('M3', 7), 7);
  assert.throws(() => w.toBaseUnits('M3', 1, 'pallet'), /no unit pallet\. Use piece, box, case/);
  assert.throws(() => w.setItemUnits('M4', { packs: [{ unit: 'box', per: 1 }] }), /2 or more/);
  assert.throws(() => w.setItemUnits('M4', { packs: [{ unit: 'box', per: 50, barcode: '871000000003' }] }), /already M3 box/);
  w.binPut({ loc: 'shelf1-bin1', code: '871000000003', qty: 2 });
  w.binPut({ loc: 'Shelf1-Bin1', itemNo: 'M3', qty: 35 });
  const bin = w.binContents('Shelf1-Bin1');
  assert.equal(bin.lines[0].qty, 235);
  assert.equal(bin.lines[0].packs, '2 box + 35 piece');
  assert.equal(bin.weightKg, 0.235);
});

test('a bin holds a mix of parts unless it is set to one item', () => {
  const w = wh();
  w.binPut({ loc: 'Shelf1-Bin1', itemNo: 'M3', qty: 10 });
  w.binPut({ loc: 'Shelf1-Bin1', itemNo: 'M4', qty: 5 });
  assert.equal(w.binContents('Shelf1-Bin1').lines.length, 2);
  assert.throws(() => w.setBinMode({ code: 'Shelf1-Bin1', mixed: false }), /more than one item/);
  w.setBinMode({ code: 'Shelf1-Bin2', mixed: false });
  w.binPut({ loc: 'Shelf1-Bin2', itemNo: 'LED', qty: 50 });
  assert.throws(() => w.binPut({ loc: 'Shelf1-Bin2', itemNo: 'M3', qty: 1 }), /one item only and holds LED/);
  assert.throws(() => w.binPut({ loc: 'DOCK-IN', itemNo: 'M3', qty: 1 }), /not a bin or shelf/);
});

test('the shelf weight limit refuses a put before anything changes', () => {
  const w = wh();
  assert.equal(w.locations['Shelf1-Bin1'].capacity.maxWeightKg, 25);
  w.binPut({ loc: 'Shelf1-Bin1', itemNo: 'M3', qty: 20, unit: 'case' });
  assert.throws(() => w.binPut({ loc: 'Shelf1-Bin1', itemNo: 'M3', qty: 6, unit: 'case' }), /weight limit is 25 kg \(that would be 26 kg\)/);
  assert.equal(w.binContents('Shelf1-Bin1').lines[0].qty, 20000);
});

test('picking for an order takes the earliest expiry and stages the pick for packing', () => {
  const w = wh();
  w.setFeatures({ lotExpiry: true, fefo: true });
  w.binPut({ loc: 'Shelf1-Bin1', itemNo: 'LED', qty: 30, batch: 'L2', expiry: '2027-06-01' });
  w.binPut({ loc: 'Shelf1-Bin1', itemNo: 'LED', qty: 10, batch: 'L1', expiry: '2027-01-01' });
  const order = w.addOrder({ id: 'SO1', customer: 'Maker', lane: 'OUT-01', lines: [{ itemNo: 'LED', units: 15 }] });
  assert.throws(() => w.binTake({ loc: 'Shelf1-Bin1', itemNo: 'LED', qty: 16, orderId: 'SO1' }), /only needs 15/);
  const out = w.binTake({ loc: 'Shelf1-Bin1', itemNo: 'LED', qty: 15, orderId: 'SO1', by: 'ana' });
  assert.deepEqual(out.taken.map((t) => [t.batch, t.qty]), [['L1', 10], ['L2', 5]]);
  assert.equal(order.lines[0].picked, 15);
  assert.equal(order.status, 'ready');
  assert.equal(w.binsFor('LED').total, 25);
  const carton = w.openCarton({ orderId: 'SO1' });
  w.packIntoCarton({ carton: carton.id, code: 'shelf1-bin1', qty: 10 });
  w.packIntoCarton({ carton: carton.id, code: 'Shelf1-Bin1', qty: 5 });
  assert.equal(carton.packed.reduce((s, p) => s + p.qty, 0), 15);
  assert.throws(() => w.binTake({ loc: 'Shelf1-Bin1', itemNo: 'LED', qty: 26 }), /has 25 piece of LED, not 26/);
});

test('a move keeps the lot, and a refused destination leaves the source alone', () => {
  const w = wh();
  w.setFeatures({ lotExpiry: true });
  w.binPut({ loc: 'Shelf1-Bin1', itemNo: 'LED', qty: 8, batch: 'B7', expiry: '2027-03-01' });
  w.setBinMode({ code: 'Shelf2-Bin1', mixed: false });
  w.binPut({ loc: 'Shelf2-Bin1', itemNo: 'M4', qty: 1 });
  assert.throws(() => w.binMove({ from: 'Shelf1-Bin1', to: 'Shelf2-Bin1', itemNo: 'LED', qty: 3 }), /one item only/);
  assert.equal(w.binContents('Shelf1-Bin1').lines[0].qty, 8);
  w.binMove({ from: 'Shelf1-Bin1', to: 'Shelf1-Bin3', itemNo: 'LED', qty: 3, by: 'ana' });
  assert.deepEqual(w.binContents('Shelf1-Bin3').lines.map((l) => [l.qty, l.batch, l.expiry]), [[3, 'B7', '2027-03-01']]);
  assert.equal(w.movements[0].event, 'moved');
  assert.equal(w.movements[0].to, 'Shelf1-Bin3');
});

test('a bin count corrects the quantity and keeps an adjustment', () => {
  const w = wh();
  w.binPut({ loc: 'Shelf1-Bin1', itemNo: 'M3', qty: 3, unit: 'box' });
  const less = w.binCount({ loc: 'Shelf1-Bin1', itemNo: 'M3', counted: 280, by: 'ana' });
  assert.deepEqual([less.before, less.after, less.difference], [300, 280, -20]);
  assert.equal(w.adjustments[0].loc, 'Shelf1-Bin1');
  const found = w.binCount({ loc: 'Shelf1-Bin2', itemNo: 'M4', counted: 4, reason: 'found' });
  assert.equal(found.after, 4);
  w.binCount({ loc: 'Shelf1-Bin2', itemNo: 'M4', counted: 0 });
  assert.equal(w.binContents('Shelf1-Bin2').lines.length, 0);
  assert.throws(() => w.binCount({ loc: 'Shelf1-Bin1', itemNo: 'M3', counted: 1, reason: 'lunch' }), /Reason is one of/);
});

test('loose stock counts in availability, low stock, pick faces and delete guards', () => {
  const w = wh();
  w.updateItem('LED', { reorderPoint: 20 });
  w.binPut({ loc: 'Shelf1-Bin1', itemNo: 'LED', qty: 18 });
  const row = w.availability().find((r) => r.itemNo === 'LED');
  assert.equal(row.onHand, 18);
  assert.equal(row.available, 18);
  assert.equal(row.low, true);
  w.setPickFace({ code: 'Shelf1-Bin1', itemNo: 'LED', min: 5, max: 40 });
  assert.equal(w._faceQty(w.locations['Shelf1-Bin1']), 18);
  assert.throws(() => w.deleteLocation('Shelf1-Bin1'), /not empty/);
  assert.throws(() => w.removeItem('LED'), /in a bin/);
  const where = w.binsFor('LED');
  assert.deepEqual(where.bins.map((b) => [b.loc, b.qty]), [['Shelf1-Bin1', 18]]);
});

test('bin stock goes through the API, the journal and a restart', async () => {
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
    const inbound = await login('inbound', 'sorted-inbound');
    const picker = await login('picker', 'sorted-picker');
    const stock = await login('stock', 'sorted-stock');
    const item = Object.keys(store.wh.items)[0];
    assert.equal((await call('POST', '/api/locations/guided', { answers: { sections: { count: 1, name: 'Wall' }, layouts: [{ type: 'shelf', positions: { count: 2, name: 'Bin 1' } }] } }, admin)).status, 200);
    const units = await call('POST', `/api/items/${item}/units`, { base: 'piece', packs: [{ unit: 'box', per: 6 }] }, admin);
    assert.equal(units.status, 200, units.body.error);
    assert.equal((await call('POST', '/api/bins/put', { loc: 'Wall-Bin1', itemNo: item, qty: 2, unit: 'box' }, picker)).status, 403, 'putting away is inbound');
    const put = await call('POST', '/api/bins/put', { loc: 'Wall-Bin1', itemNo: item, qty: 2, unit: 'box' }, inbound);
    assert.equal(put.status, 200, put.body.error);
    assert.equal(put.body.qty, 12);
    assert.equal((await call('POST', '/api/bins/move', { from: 'Wall-Bin1', to: 'Wall-Bin2', itemNo: item, qty: 5 }, picker)).status, 403, 'moving stock is stock control');
    const moved = await call('POST', '/api/bins/move', { from: 'Wall-Bin1', to: 'Wall-Bin2', itemNo: item, qty: 5 }, stock);
    assert.equal(moved.status, 200, moved.body.error);
    const where = await call('GET', `/api/bins?item=${item}`, null, picker);
    assert.deepEqual(where.body.bins.map((b) => [b.loc, b.qty]).sort(), [['Wall-Bin1', 7], ['Wall-Bin2', 5]]);
    const bad = await call('POST', '/api/bins/take', { loc: 'Wall-Bin2', itemNo: item, qty: 9 }, picker);
    assert.equal(bad.status, 400);
    assert.equal(store.wh.binContents('Wall-Bin2').lines[0].qty, 5, 'a refused take changes nothing');
    store.load();
    assert.equal(store.wh.binContents('Wall-Bin1').lines[0].qty, 7, 'replaying the journal gives the same bins');
    assert.equal(store.wh.items[item].packs[0].per, 6);
  } finally {
    await new Promise((r) => server.close(r));
    store.close();
  }
});
