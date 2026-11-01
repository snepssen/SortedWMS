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
  const w = new Warehouse({ aisles: [1], bays: 2, levels: 2, positions: [10], outLanes: 1, clock: () => Date.UTC(2026, 10, 2, 9) });
  w.addItem({ itemNo: 'DRILL', name: 'Cordless drill', category: 'YOG', palletQty: 40, uom: 'piece' });
  w.addItem({ itemNo: 'BIT', name: 'Drill bit', category: 'YOG', palletQty: 500, uom: 'piece' });
  w.setItemSerials('DRILL', true);
  w.generateGuided({ sections: { count: 1, name: 'Tools' }, layouts: [{ type: 'shelf', positions: { count: 3, name: 'Bin 1' } }] });
  return w;
}

/** Pick, pack and dispatch a piece order from Tools-Bin1. */
function ship(w, id, lines, serials = {}) {
  w.addOrder({ id, customer: 'Builder Bob', lane: 'OUT-01', lines: lines.map(([itemNo, units]) => ({ itemNo, units })) });
  for (const [itemNo, units] of lines) w.binTake({ loc: 'Tools-Bin1', itemNo, qty: units, orderId: id, serials: serials[itemNo] || null });
  const box = w.openCarton({ orderId: id });
  for (const [, units] of lines) w.packIntoCarton({ carton: box.id, code: 'Tools-Bin1', qty: units });
  w.closeCarton({ carton: box.id, lengthMm: 400, widthMm: 300, heightMm: 200, weightKg: 5 });
  w.dispatchCartons({ orderId: id });
}

test('a return is booked against a shipped order, never for more than went out', () => {
  const w = wh();
  w.binPut({ loc: 'Tools-Bin1', itemNo: 'BIT', qty: 50 });
  w.addOrder({ id: 'SO0', customer: 'Builder Bob', lane: 'OUT-01', lines: [{ itemNo: 'BIT', units: 1 }] });
  assert.throws(() => w.receiveReturn({ orderId: 'SO0', itemNo: 'BIT', qty: 1 }), /has not shipped yet/);
  ship(w, 'SO1', [['BIT', 10]]);
  assert.throws(() => w.receiveReturn({ orderId: 'SO1', itemNo: 'DRILL', qty: 1 }), /DRILL was not on order SO1/);
  assert.throws(() => w.receiveReturn({ orderId: 'SO1', itemNo: 'BIT', qty: 11 }), /only 10 BIT that can come back/);
  const rma = w.receiveReturn({ orderId: 'SO1', itemNo: 'BIT', qty: 6, reason: 'Ordered too many' });
  assert.equal(rma.id, 'RMA-1', 'numbered when no id is given');
  assert.equal(rma.loc, 'RETURNS', 'a return location is made the first time');
  assert.equal(w.locations.RETURNS.role, 'return');
  assert.throws(() => w.receiveReturn({ orderId: 'SO1', itemNo: 'BIT', qty: 5 }), /only 4 BIT/);
  w.receiveReturn({ id: 'R-B', orderId: 'SO1', itemNo: 'BIT', qty: 4 });
  assert.throws(() => w.receiveReturn({ orderId: 'SO1', itemNo: 'BIT', qty: 1 }), /Every BIT on order SO1 has come back already/);
  assert.throws(() => w.receiveReturn({ id: 'R-B', orderId: 'SO1', itemNo: 'BIT', qty: 1 }), /already exists/);
  assert.deepEqual(w.returnable('SO1').lines.map((l) => [l.itemNo, l.shipped, l.returned, l.left]), [['BIT', 10, 10, 0]]);
});

test('grading a few at a time: restocked stock can be picked again, held stock waits on a plate, and the report shows it', () => {
  const w = wh();
  w.binPut({ loc: 'Tools-Bin1', itemNo: 'BIT', qty: 20 });
  ship(w, 'SO2', [['BIT', 20]]);
  const rma = w.receiveReturn({ orderId: 'SO2', lines: [{ itemNo: 'BIT', qty: 5 }] });
  w.gradeReturn({ id: rma.id, grade: 'restock', qty: 3, to: 'Tools-Bin2' });
  assert.equal(w.returns[rma.id].status, 'received', 'two still wait');
  assert.equal(w.binContents('Tools-Bin2').lines[0].qty, 3);
  w.gradeReturn({ id: rma.id, grade: 'hold', qty: 2 });
  const back = w.returns[rma.id];
  assert.equal(back.status, 'held');
  assert.equal(w.holders[back.holderId].loc, 'QUARANTINE', 'held at a quarantine location made the first time');
  assert.throws(() => w.gradeReturn({ id: rma.id, grade: 'restock', qty: 3, to: 'Tools-Bin2' }), /Only 2 BIT on hold/);
  w.gradeReturn({ id: rma.id, grade: 'scrap', qty: 1 });
  w.gradeReturn({ id: rma.id, grade: 'restock', to: 'Tools-Bin2' });
  assert.equal(back.status, 'done');
  assert.deepEqual([back.lines[0].restocked, back.lines[0].held, back.lines[0].scrapped], [4, 0, 1]);
  assert.equal(w.holders[back.holderId].status, 'retired', 'the empty hold plate is retired');
  assert.throws(() => w.gradeReturn({ id: rma.id, grade: 'scrap' }), /No BIT on return .* is on hold/);

  w.addOrder({ id: 'SO3', customer: 'Builder Bob', lane: 'OUT-01', lines: [{ itemNo: 'BIT', units: 4 }] });
  const wave = w.planWave({});
  assert.deepEqual(wave.tasks.map((t) => [t.loc, t.qty]), [['Tools-Bin2', 4]], 'a wave picks the restocked bits');

  const net = w.stockChanges({}).rows.filter((r) => r.reason.startsWith('return')).map((r) => [r.reason, r.change]);
  assert.deepEqual(net, [['returned', 3], ['returned (held)', 2], ['return scrapped', -1], ['return released', 1], ['return released', -1]]);
});

test('a return with two items grades each by name', () => {
  const w = wh();
  w.binPut({ loc: 'Tools-Bin1', itemNo: 'BIT', qty: 9 });
  w.binPut({ loc: 'Tools-Bin1', itemNo: 'DRILL', qty: 1, serials: ['D-1'] });
  ship(w, 'SO4', [['BIT', 9], ['DRILL', 1]], { DRILL: ['D-1'] });
  const rma = w.receiveReturn({ orderId: 'SO4', lines: [{ itemNo: 'BIT', qty: 2 }, { itemNo: 'DRILL', qty: 1, serials: ['d-1'] }] });
  assert.throws(() => w.gradeReturn({ id: rma.id, grade: 'scrap' }), /2 items still to grade: say which/);
  w.gradeReturn({ id: rma.id, itemNo: 'BIT', grade: 'scrap' });
  w.gradeReturn({ id: rma.id, itemNo: 'DRILL', grade: 'restock', to: 'Tools-Bin3' });
  assert.equal(w.returns[rma.id].status, 'done');
  assert.equal(w.returnList({ orderId: 'SO4' })[0].lines[1].waiting, 0);
});

test('traced items come back by the serials that left on the order, and go wherever they are graded', () => {
  const w = wh();
  const sns = ['D-1', 'D-2', 'D-3', 'D-4'];
  w.binPut({ loc: 'Tools-Bin1', itemNo: 'DRILL', qty: 4, serials: sns });
  w.binPut({ loc: 'Tools-Bin3', itemNo: 'DRILL', qty: 1, serials: ['D-9'] });
  ship(w, 'SO5', [['DRILL', 4]], { DRILL: sns });
  assert.deepEqual(w.returnable('SO5').lines[0].serials, sns);
  assert.throws(() => w.receiveReturn({ orderId: 'SO5', itemNo: 'DRILL', qty: 2, serials: ['D-1'] }), /scan 2 serial numbers, not 1/);
  assert.throws(() => w.receiveReturn({ orderId: 'SO5', itemNo: 'DRILL', qty: 1, serials: ['D-9'] }), /D-9 did not go out on order SO5/);
  const rma = w.receiveReturn({ orderId: 'SO5', itemNo: 'DRILL', qty: 3, serials: ['D-1', 'D-2', 'D-3'] });
  assert.equal(w.serialTrace('D-2').status, 'returned');
  assert.throws(() => w.receiveReturn({ orderId: 'SO5', itemNo: 'DRILL', qty: 1, serials: ['D-1'] }), /D-1 has come back already/);
  assert.throws(() => w.gradeReturn({ id: rma.id, grade: 'restock', qty: 1, to: 'Tools-Bin2' }), /Scan which 1 of the 3 DRILL serials/);
  assert.throws(() => w.gradeReturn({ id: rma.id, grade: 'restock', qty: 1, to: 'Tools-Bin2', serials: ['D-4'] }), /D-4 is not waiting on this return/);
  w.gradeReturn({ id: rma.id, grade: 'restock', qty: 1, to: 'Tools-Bin2', serials: ['D-1'] });
  assert.deepEqual([w.serialTrace('D-1').status, w.serialTrace('D-1').loc], ['in', 'Tools-Bin2']);
  w.gradeReturn({ id: rma.id, grade: 'hold', qty: 2, serials: ['D-2', 'D-3'] });
  assert.equal(w.serialTrace('D-3').loc, 'QUARANTINE');
  w.gradeReturn({ id: rma.id, grade: 'scrap', qty: 1, serials: ['D-3'] });
  w.gradeReturn({ id: rma.id, grade: 'restock', to: 'Tools-Bin2' });
  assert.equal(w.serialTrace('D-3').status, 'scrapped');
  assert.deepEqual(w.serialsIn({ loc: 'Tools-Bin2' }).map((s) => s.sn), ['D-1', 'D-2']);
  w.addOrder({ id: 'SO6', customer: 'Site office', lane: 'OUT-01', lines: [{ itemNo: 'DRILL', units: 1 }] });
  w.binTake({ loc: 'Tools-Bin2', itemNo: 'DRILL', qty: 1, orderId: 'SO6', serials: ['D-2'] });
  assert.equal(w.serialTrace('D-2').orderId, 'SO6', 'a restocked serial goes out again');
});

test('a whole pallet that left without serials can come back with them; untraced items take none', () => {
  const w = wh();
  const p = w.stockPallet('01-01-0-10', { itemNo: 'DRILL', qty: 40, receivedAt: 1 });
  w.addOrder({ id: 'SO7', customer: 'Depot', lane: 'OUT-01', lines: [{ itemNo: 'DRILL', pallets: 1 }] });
  w.orders.SO7.status = 'shipped';
  w.pallets[p.sscc].status = 'shipped';
  const rma = w.receiveReturn({ orderId: 'SO7', itemNo: 'DRILL', qty: 2, serials: ['X-1', 'X-2'] });
  w.gradeReturn({ id: rma.id, grade: 'restock', to: '01-02-0-10' });
  const back = Object.values(w.pallets).find((q) => q.loc === '01-02-0-10');
  assert.equal(back.qty, 2, 'restocked into a rack slot as a pallet');
  assert.equal(w.serialTrace('X-1').loc, '01-02-0-10');
  assert.throws(() => w.receiveReturn({ orderId: 'SO7', itemNo: 'DRILL', qty: 1, serials: ['X-1'] }), /already in stock/);
});

test('a return booked before lines existed still reads and grades', () => {
  const w = wh();
  w.binPut({ loc: 'Tools-Bin1', itemNo: 'BIT', qty: 5 });
  ship(w, 'SO8', [['BIT', 5]]);
  w.returns = { OLD: { id: 'OLD', orderId: 'SO8', itemNo: 'BIT', qty: 2, loc: 'RETURNS', status: 'received', history: [] } };
  w.createLocation({ code: 'RETURNS', kind: 'virtual', role: 'return', name: 'Returns' });
  w.gradeReturn({ id: 'OLD', grade: 'restock', to: 'Tools-Bin2' });
  assert.equal(w.returns.OLD.status, 'done');
  assert.equal(w.returns.OLD.lines[0].restocked, 2);
});

test('returns over the API: inbound books and grades, a picker cannot, and the journal replays it', async () => {
  const site = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'server', 'site.blank.json'), 'utf8'));
  const store = new Store({ site });
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
    store.exec('applyPreset', { id: 'home-garage' }, 'test');
    store.exec('generateGuided', { answers: { sections: { count: 1, name: 'Wall' }, layouts: [{ type: 'shelf', positions: { count: 3, name: 'Bin 1' } }] } }, 'test');
    store.exec('addItem', { itemNo: 'CAM', name: 'Camera', category: 'HOME', palletQty: 1, uom: 'piece' }, 'test');
    store.exec('setItemSerials', { itemNo: 'CAM', on: true }, 'test');
    store.exec('binPut', { loc: 'Wall-Bin1', itemNo: 'CAM', qty: 3, serials: ['C-1', 'C-2', 'C-3'] }, 'test');
    store.exec('addOrder', { id: 'W1', customer: 'Ana', lane: 'OUT-01', lines: [{ itemNo: 'CAM', units: 3 }] }, 'test');
    store.exec('binTake', { loc: 'Wall-Bin1', itemNo: 'CAM', qty: 3, orderId: 'W1', serials: ['C-1', 'C-2', 'C-3'] }, 'test');
    const box = store.exec('openCarton', { orderId: 'W1' }, 'test');
    store.exec('packIntoCarton', { carton: box.id, code: 'Wall-Bin1', qty: 1, serials: ['C-3'] }, 'test');
    assert.equal(store.wh.serialTrace('C-3').carton, box.id, 'the pack command keeps the serials scanned');
    store.exec('packIntoCarton', { carton: box.id, code: 'Wall-Bin1', qty: 2 }, 'test');
    store.exec('closeCarton', { carton: box.id, lengthMm: 300, widthMm: 200, heightMm: 100, weightKg: 2 }, 'test');
    store.exec('dispatchCartons', { orderId: 'W1' }, 'test');

    const inbound = await login('inbound', 'sorted-inbound');
    const picker = await login('picker', 'sorted-picker');
    const can = await call('GET', '/api/orders/W1/returnable', null, inbound);
    assert.deepEqual(can.body.lines[0].serials, ['C-1', 'C-2', 'C-3']);
    assert.equal((await call('POST', '/api/returns', { orderId: 'W1', itemNo: 'CAM', qty: 1, serials: ['C-2'] }, picker)).status, 403);
    const made = await call('POST', '/api/returns', { orderId: 'W1', lines: [{ itemNo: 'CAM', qty: 2, serials: ['C-1', 'C-2'] }], reason: 'Faulty' }, inbound);
    assert.equal(made.status, 200, made.body.error);
    const graded = await call('POST', `/api/returns/${made.body.id}/grade`, { grade: 'restock', qty: 1, serials: ['C-2'], to: 'Wall-Bin2' }, inbound);
    assert.equal(graded.status, 200, graded.body.error);
    const list = await call('GET', '/api/returns?status=received', null, inbound);
    assert.deepEqual(list.body.map((r) => [r.id, r.reason, r.lines[0].waiting]), [[made.body.id, 'Faulty', 1]]);
    store.load();
    assert.equal(store.wh.returns[made.body.id].lines[0].restocked, 1, 'the journal replays the return');
    assert.equal(store.wh.serialTrace('C-2').loc, 'Wall-Bin2');
    assert.equal(store.wh.serialTrace('C-1').status, 'returned');
  } finally {
    await new Promise((r) => server.close(r));
    store.close();
  }
});
