const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Warehouse } = require('../src/engine');
const { Store } = require('../server/store');
const { Printers } = require('../server/print');
const { createServer } = require('../server/index');
const { createAuth } = require('../server/auth');
const { loadSample } = require('../server/samples');

function wh() {
  const w = new Warehouse({ aisles: [1], bays: 2, levels: 2, positions: [10], outLanes: 1, clock: () => Date.UTC(2026, 10, 1, 8) });
  w.addItem({ itemNo: 'DRILL', name: 'Cordless drill', category: 'GEN', palletQty: 40, uom: 'piece' });
  w.addItem({ itemNo: 'BIT', name: 'Drill bit', category: 'GEN', palletQty: 1, uom: 'piece' });
  w.setItemUnits('DRILL', { packs: [{ unit: 'case', per: 4 }] });
  w.setItemSerials('DRILL', true);
  w.generateGuided({ sections: { count: 1, name: 'Tools' }, layouts: [{ type: 'shelf', positions: { count: 3, name: 'Bin 1' } }] });
  return w;
}

test('serials in: optional, one per piece, never twice in stock; untraced items take none', () => {
  const w = wh();
  w.binPut({ loc: 'Tools-Bin1', itemNo: 'DRILL', qty: 2, serials: 'd-001 d-002' });
  assert.deepEqual(w.serialsIn({ loc: 'Tools-Bin1' }).map((s) => s.sn), ['D-001', 'D-002']);
  w.binPut({ loc: 'Tools-Bin2', itemNo: 'DRILL', qty: 1 });
  assert.throws(() => w.binPut({ loc: 'Tools-Bin2', itemNo: 'DRILL', qty: 2, serials: ['D-003'] }), /scan 2 serial numbers, not 1/);
  assert.throws(() => w.binPut({ loc: 'Tools-Bin2', itemNo: 'DRILL', qty: 2, serials: ['D-004', 'd-004'] }), /scanned twice/);
  assert.throws(() => w.binPut({ loc: 'Tools-Bin2', itemNo: 'DRILL', qty: 1, serials: ['D-001'] }), /already in stock at Tools-Bin1/);
  assert.throws(() => w.binPut({ loc: 'Tools-Bin3', itemNo: 'BIT', qty: 1, serials: ['B-1'] }), /BIT is not traced by serial number/);
});

test('picking a traced item scans one serial per piece from that bin; a serial first seen at the pick is recorded there', () => {
  const w = wh();
  w.binPut({ loc: 'Tools-Bin1', itemNo: 'DRILL', qty: 2, serials: ['D-001', 'D-002'] });
  w.binPut({ loc: 'Tools-Bin2', itemNo: 'DRILL', qty: 3 });
  w.addOrder({ id: 'SO1', customer: 'Builder Bob', lane: 'OUT-01', lines: [{ itemNo: 'DRILL', units: 3 }] });
  assert.throws(() => w.binTake({ loc: 'Tools-Bin1', itemNo: 'DRILL', qty: 1, orderId: 'SO1' }), /scan 1 serial number, not 0/);
  assert.throws(() => w.binTake({ loc: 'Tools-Bin2', itemNo: 'DRILL', qty: 1, orderId: 'SO1', serials: ['D-001'] }), /booked at Tools-Bin1, not Tools-Bin2/);
  w.binTake({ loc: 'Tools-Bin1', itemNo: 'DRILL', qty: 1, orderId: 'SO1', serials: ['D-002'] });
  w.binTake({ loc: 'Tools-Bin2', itemNo: 'DRILL', qty: 2, orderId: 'SO1', serials: ['X-777', 'X-778'] });
  assert.equal(w.binContents('Tools-Bin1').lines[0].qty, 1);
  assert.throws(() => w.binTake({ loc: 'Tools-Bin1', itemNo: 'DRILL', qty: 1, serials: ['D-002'] }), /D-002 is picked \(order SO1\)/);
  const trace = w.serialTrace('x-777');
  assert.deepEqual([trace.status, trace.orderId, trace.customer, trace.history[0].note], ['picked', 'SO1', 'Builder Bob', 'from Tools-Bin2']);
  const carton = w.openCarton({ orderId: 'SO1' });
  assert.throws(() => w.packIntoCarton({ carton: carton.id, code: 'Tools-Bin1', qty: 1 }), /3 serials of DRILL picked for SO1 are not packed yet: scan the 1/);
  assert.throws(() => w.packIntoCarton({ carton: carton.id, code: 'Tools-Bin1', qty: 1, serials: ['D-001'] }), /D-001 was not picked for order SO1/);
  w.packIntoCarton({ carton: carton.id, code: 'Tools-Bin1', qty: 1, serials: ['d-002'] });
  w.packIntoCarton({ carton: carton.id, code: 'Tools-Bin2', qty: 2 });
  assert.deepEqual(carton.packed.map((p) => p.serials), [['D-002'], ['X-777', 'X-778']], 'the two left went in without a scan');
  assert.equal(w.serialTrace('X-778').carton, carton.id);
  const { slip } = w.closeCarton({ carton: carton.id, lengthMm: 400, widthMm: 300, heightMm: 200, weightKg: 6 });
  assert.match(slip.zpl, /\^FDSN X-777, X-778\^FS/);
  assert.match(w.packingSlipHtml(carton.id), /X-777, X-778/);
  w.dispatchCartons({ orderId: 'SO1' });
  assert.equal(w.serialTrace('D-002').status, 'shipped');
  assert.throws(() => w.serialTrace('NOPE-1'), /not known/);
});

test('moving a traced item carries its serials; a count by serials finds what moved and what is missing', () => {
  const w = wh();
  w.binPut({ loc: 'Tools-Bin1', itemNo: 'DRILL', qty: 3, serials: ['D-001', 'D-002', 'D-003'] });
  assert.throws(() => w.binMove({ from: 'Tools-Bin1', to: 'Tools-Bin2', itemNo: 'DRILL', qty: 1 }), /scan 1 serial number/);
  w.binMove({ from: 'Tools-Bin1', to: 'Tools-Bin2', itemNo: 'DRILL', qty: 1, serials: ['D-003'] });
  assert.equal(w.serialTrace('D-003').loc, 'Tools-Bin2');
  // D-002 has gone; D-003 was put back without telling anyone.
  const r = w.binCount({ loc: 'Tools-Bin1', itemNo: 'DRILL', serials: ['D-001', 'D-003'] });
  assert.deepEqual([r.before, r.after], [2, 2]);
  assert.deepEqual(r.serials.missing, ['D-002']);
  assert.deepEqual(r.serials.moved, ['D-003']);
  assert.equal(w.serialTrace('D-002').status, 'missing');
  assert.equal(w.serialTrace('D-003').loc, 'Tools-Bin1');
  assert.throws(() => w.binCount({ loc: 'Tools-Bin1', itemNo: 'DRILL', counted: 5, serials: ['D-001'] }), /1 serials scanned, but the count says 5/);
  assert.throws(() => w.binCount({ loc: 'Tools-Bin1', itemNo: 'DRILL' }), /Scan the serial numbers in the bin, or enter the count/);
  assert.throws(() => w.binCount({ loc: 'Tools-Bin2', itemNo: 'BIT', counted: '' }), /Enter the count/);
  assert.equal(w.binCount({ loc: 'Tools-Bin1', itemNo: 'DRILL', counted: 0, serials: [] }).serials.missing.length, 2, 'not here: every serial booked there is missing');
});

test('a box pick from a pallet of a traced item records its serials; a correction and a rename keep the register right', () => {
  const w = wh();
  for (const l of w._racks()) l.category = 'GEN';
  w.stockPallet('01-01-1-10', { itemNo: 'DRILL', qty: 40, receivedAt: 1 });
  w.addOrder({ id: 'SO2', customer: 'Shop', lane: 'OUT-01', lines: [{ itemNo: 'DRILL', units: 4 }] });
  const wave = w.planWave({ orders: ['SO2'] });
  assert.equal(wave.tasks[0].kind, 'case');
  assert.throws(() => w.confirmWaveTask({ task: wave.tasks[0].id }), /scan 4 serial numbers/);
  w.confirmWaveTask({ task: wave.tasks[0].id, serials: ['P-1', 'P-2', 'P-3', 'P-4'] });
  assert.equal(w.serialTrace('P-4').orderId, 'SO2');
  w.binPut({ loc: 'Tools-Bin3', itemNo: 'DRILL', qty: 1, serials: ['D-009'] });
  w.renameLocations({ pairs: [{ from: 'Tools-Bin3', to: 'T3' }] });
  assert.equal(w.serialTrace('D-009').loc, 'T3');
  w.correctItem({ target: 'T3', itemNo: 'BIT', qty: 1 });
  assert.equal(w.serialTrace('D-009').status, 'removed');
});

test('serials over the API: an office user marks the item, the picker scans, and anyone with stock access traces', async () => {
  const site = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'server', 'site.blank.json'), 'utf8'));
  const store = new Store({ site });
  loadSample(store, '3pl');
  const auth = createAuth(store.db);
  auth.ensureDemoUsers();
  const server = createServer({ store, printers: new Printers({}), auth });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = async (u, p) => (await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) })).headers.get('set-cookie').split(';')[0];
  const call = async (method, p, body, cookie) => {
    const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };
  try {
    const office = await login('office', 'sorted-office');
    const picker = await login('picker', 'sorted-picker');
    assert.equal((await call('POST', '/api/items/PHONE-X/serials', { on: true }, picker)).status, 403);
    assert.equal((await call('POST', '/api/items/PHONE-X/serials', { on: true }, office)).body.serialized, true);
    const took = await call('POST', '/api/bins/take', { loc: 'Mezz-Shelf1-Bin3', itemNo: 'PHONE-X', qty: 2, orderId: 'N-5001', serials: ['IMEI-1', 'IMEI-2'] }, picker);
    assert.equal(took.status, 200, took.body.error);
    const trace = await call('GET', '/api/serials/imei-2', null, picker);
    assert.deepEqual([trace.body.status, trace.body.orderId, trace.body.customer], ['picked', 'N-5001', 'Gadget shop']);
    store.load();
    assert.equal(store.wh.serialTrace('IMEI-1').orderId, 'N-5001', 'the journal replays the serials');
  } finally {
    await new Promise((r) => server.close(r));
    store.close();
  }
});

test('an order over two cartons: scan which serials go in each; the delivery note and the slips list them', () => {
  const w = wh();
  const sns = Array.from({ length: 12 }, (_, i) => `SN-ABCDEF-${String(i + 1).padStart(3, '0')}`);
  w.binPut({ loc: 'Tools-Bin1', itemNo: 'DRILL', qty: 12, serials: sns });
  w.addOrder({ id: 'SO3', customer: 'Site office', lane: 'OUT-01', lines: [{ itemNo: 'DRILL', units: 12 }] });
  w.binTake({ loc: 'Tools-Bin1', itemNo: 'DRILL', qty: 12, orderId: 'SO3', serials: sns });
  const a = w.openCarton({ orderId: 'SO3' });
  w.packIntoCarton({ carton: a.id, code: 'Tools-Bin1', qty: 8, serials: sns.slice(0, 8) });
  assert.throws(() => w.packIntoCarton({ carton: a.id, code: 'Tools-Bin1', qty: 1, serials: [sns[0]] }), /already in carton/);
  const { slip } = w.closeCarton({ carton: a.id, lengthMm: 600, widthMm: 400, heightMm: 300, weightKg: 14 });
  assert.ok((slip.zpl.match(/\^FDSN /g) || []).length >= 2, 'eight long serials wrap over more than one row');
  const b = w.openCarton({ orderId: 'SO3' });
  w.packIntoCarton({ carton: b.id, code: 'Tools-Bin1', qty: 4 });
  assert.deepEqual(b.packed[0].serials, sns.slice(8));
  w.closeCarton({ carton: b.id, lengthMm: 400, widthMm: 300, heightMm: 300, weightKg: 7 });
  w.stageShipment({ orderId: 'SO3' });
  const note = w.deliveryNote('SO3');
  assert.match(note, /<h2>Serial numbers<\/h2>/);
  assert.match(note, new RegExp(`${a.id}</td><td>DRILL</td><td[^>]*>${sns[0]}, `));
  assert.match(note, new RegExp(`${b.id}</td><td>DRILL</td><td[^>]*>${sns[8]}, ${sns[9]}, ${sns[10]}, ${sns[11]}<`));
  assert.deepEqual(w.serialsForOrder('SO3').filter((s) => s.carton === b.id).map((s) => s.sn), sns.slice(8));
});
