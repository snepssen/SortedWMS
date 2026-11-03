const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const GS1 = require('../src/gs1');
const Site = require('../server/site');
const Demo = require('../src/demo');
const Intake = require('../src/intake');
const { createApi } = require('../server/api');
const { COMMANDS } = require('../server/commands');
const { watchInbox } = require('../server/inbox');

function warehouse() {
  let t = Demo.morning(Date.UTC(2026, 10, 2, 9));
  const wh = Site.buildWarehouse(Demo.SITE, () => t);
  const rows = [];
  const store = {
    get wh() { return wh; },
    now: () => t,
    exec: (op, args, by) => { rows.push({ t, op, args: JSON.parse(JSON.stringify(args)), by }); return COMMANDS[op](wh, args, by); },
    journal: () => [],
  };
  Demo.seed((op, args) => store.exec(op, args, 'demo'), t, () => wh);
  const api = createApi({ store, printers: { flush() {} } });
  return { wh, store, api, rows, tick: (ms) => { t += ms; } };
}

const order = (ref, extra = {}) => ({ type: 'order', ref, customer: 'Harbour Hardware', clientId: 'CL-FIX', lines: [{ itemNo: 'F3001', units: 6 }], ...extra });

test('intake: an order from another system, once however often it is sent, with its ref on the messages', () => {
  const { wh } = warehouse();
  const first = wh.intake(order('WEB-1001', { lines: [{ gtin: Demo.ITEMS.find((i) => i.itemNo === 'F3002').gtin, units: 12 }] }));
  assert.equal(first.status, 'created');
  assert.equal(first.id, 'WEB-1001', 'the ref is the order number when it can be');
  const o = wh.orders['WEB-1001'];
  assert.equal(o.ref, 'WEB-1001');
  assert.deepEqual(o.lines.map((l) => [l.itemNo, l.units]), [['F3002', 12]], 'an item found by its GTIN');
  assert.match(o.lane, /^OUT-0\d$/, 'no lane given: the least busy one');
  const again = wh.intake(order('WEB-1001', { lines: [{ gtin: Demo.ITEMS.find((i) => i.itemNo === 'F3002').gtin, units: 12 }] }));
  assert.deepEqual(again, { status: 'duplicate', type: 'order', ref: 'WEB-1001', id: 'WEB-1001' });
  assert.equal(Object.values(wh.orders).filter((x) => x.ref === 'WEB-1001').length, 1);
  assert.throws(() => wh.intake(order('WEB-1001', { lines: [{ itemNo: 'F3002', units: 99 }] })), /sent before with other content/);
  assert.throws(() => wh.intake(order('WEB-1002', { lines: [{ itemNo: 'NOPE', units: 1 }] })), /Line 1: unknown item NOPE/);
  assert.equal(wh.orders['WEB-1002'], undefined, 'a refused document books nothing');
  assert.throws(() => wh.intake({ type: 'invoice', ref: 'X' }), /order or an asn/);
  assert.throws(() => wh.intake({ type: 'order', customer: 'A', lines: [] }), /reference/);
  // The same ref from another client is another document.
  const other = wh.intake(order('WEB-1001', { clientId: 'CL-VOLT', lines: [{ itemNo: 'T4002', units: 3 }] }));
  assert.equal(other.id, 'CL-VOLT-WEB-1001');
});

test('intake: an ASN books a delivery with its pallet list; a pallet scan then receives it, and the receipt carries the ref', () => {
  const { wh } = warehouse();
  const sscc = [GS1.makeSscc(7, '0614141', 1), GS1.makeSscc(7, '0614141', 2)];
  const doc = { type: 'asn', ref: 'ASN-55', supplier: 'Brightwall factory', clientId: 'CL-PAINT', pallets: [
    { sscc: sscc[0], itemNo: 'W1001', qty: 60, batch: 'B7', expiry: '2028-01-31' },
    { sscc: `(00)${sscc[1]}`, gtin: Demo.ITEMS.find((i) => i.itemNo === 'W1002').gtin, batch: 'B8', expiry: '2028-02-28' },
  ] };
  const r = wh.intake(doc);
  assert.equal(r.status, 'created');
  const d = wh.deliveries[r.id];
  assert.equal(d.category, 'GEN', 'the category of its pallets');
  assert.equal(d.list[sscc[1]].qty, 60, 'no quantity given: a full pallet');
  assert.equal(d.ref, 'ASN-55');
  assert.equal(wh.intake(doc).status, 'duplicate');
  assert.throws(() => wh.intake({ ...doc, ref: 'ASN-56', pallets: [doc.pallets[0], { sscc: GS1.makeSscc(7, '0614141', 3), itemNo: 'G2001' }] }), /2 categories/);
  assert.throws(() => wh.intake({ ...doc, ref: 'ASN-57', pallets: [{ sscc: '123', itemNo: 'W1001' }] }), /18 digits/);
  // Received with one scan per pallet; the message says which ASN it was.
  const truck = Object.keys(wh.trucks).find((id) => (wh.trucks[id].categories || []).includes('GEN'));
  let guard = 0;
  while (wh.deliveries[r.id].status === 'open' && guard++ < 50) {
    const tk = Object.values(wh.trucks).find((t) => t.taskId && wh.tasks[t.taskId].deliveryId === r.id);
    if (!tk) { wh.setTruckMode(truck, 'auto'); wh.dispatch(); for (const t of Object.values(wh.trucks)) if (t.taskId && wh.tasks[t.taskId].type !== 'RECEIVE') wh.tasks[t.taskId].status = 'done', t.taskId = null; wh.dispatch(); continue; }
    const next = sscc.find((s) => !wh.deliveries[r.id].received.includes(s));
    wh.scan(tk.id, `00${next}`);
  }
  assert.equal(wh.deliveries[r.id].status, 'received');
  const msg = wh.messageLog({ type: 'delivery.received', limit: 1000 }).messages.find((m) => m.data.deliveryId === r.id);
  assert.equal(msg.data.ref, 'ASN-55');
  assert.deepEqual(msg.data.pallets.map((p) => p.batch), ['B7', 'B8']);
});

test('intake from CSV: quoted fields, comma or semicolon, rows with the same ref make one document', () => {
  const docs = Intake.fromCsv('order', 'Ref;Customer;Client;Item;Units\nWEB-7;"Corner Builders; yard";CL-FIX;F3001;6\nWEB-7;"Corner Builders; yard";CL-FIX;F3002;24\nWEB-8;Bayview Homes;CL-FIX;F3003;4\n');
  assert.equal(docs.length, 2);
  assert.equal(docs[0].customer, 'Corner Builders; yard');
  assert.deepEqual(docs[0].lines.map((l) => [l.itemNo, l.units]), [['F3001', '6'], ['F3002', '24']]);
  const asn = Intake.fromCsv('asn', `ref,supplier,client,sscc,item,qty,batch,expiry,serials\nA1,Voltline import,CL-VOLT,${GS1.makeSscc(7, '0614141', 9)},T4001,2,L9,,"SN-1 SN-2"\n`);
  assert.equal(asn[0].pallets[0].serials, 'SN-1 SN-2');
  assert.throws(() => Intake.fromCsv('order', 'customer,item\nX,F3001\n'), /no ref/);
  assert.throws(() => Intake.fromCsv('invoice', 'a\n1'), /order or asn/);
});

test('POST /api/inbox: a batch taken document by document, a client key held to its own client, and replay gives the same', () => {
  const { wh, api, rows } = warehouse();
  const r = api.handle('POST', '/api/inbox', { documents: [order('WEB-1'), order('WEB-2', { lines: [{ itemNo: 'NOPE', units: 1 }] }), order('WEB-1')] }, 'key:shop');
  assert.equal(r.status, 200);
  assert.equal(r.body.taken, 2);
  assert.equal(r.body.refused, 1);
  assert.deepEqual(r.body.results.map((x) => x.status), ['created', 'refused', 'duplicate']);
  const csv = api.handle('POST', '/api/inbox', { type: 'order', csv: 'ref,customer,client,item,units\nWEB-3,Bayview Homes,CL-FIX,F3001,2\n' }, 'key:shop');
  assert.equal(csv.body.results[0].status, 'created');
  const conflict = api.handle('POST', '/api/inbox', order('WEB-1', { customer: 'Somebody else' }), 'key:shop');
  assert.equal(conflict.status, 409);
  // A client's key: that client's documents only.
  const actor = { role: 'client', clientId: 'CL-PAINT' };
  const own = api.handle('POST', '/api/inbox', { type: 'order', ref: 'P-1', customer: 'Harbour Hardware', lines: [{ itemNo: 'W1001', pallets: 1 }] }, 'key:paint', null, actor);
  assert.equal(own.body.status, 'created');
  assert.equal(wh.orders['P-1'].clientId, 'CL-PAINT', 'the client is the key’s');
  const theirs = api.handle('POST', '/api/inbox', order('P-2'), 'key:paint', null, actor);
  assert.equal(theirs.status, 400);
  assert.match(theirs.body.error, /another client/);
  let rt = rows[0].t;
  const again = Site.buildWarehouse(Demo.SITE, () => rt);
  for (const row of rows) { rt = row.t; try { COMMANDS[row.op](again, row.args, row.by); } catch (e) { /* refused live too */ } }
  assert.equal(JSON.stringify(again.orders), JSON.stringify(wh.orders));
  assert.equal(JSON.stringify(again.intakeRefs), JSON.stringify(wh.intakeRefs));
});

test('the drop folder: files taken in, moved to done or failed with what became of each document', () => {
  const { wh, api } = warehouse();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sorted-inbox-'));
  let now = Date.now() + 10000;
  const quiet = { warn() {}, error() {} };
  const box = watchInbox({ dir, api, every: 0, now: () => now, log: quiet });
  fs.writeFileSync(path.join(dir, 'orders-1102.csv'), 'ref,customer,client,item,units\nFD-1,Bayview Homes,CL-FIX,F3001,2\n');
  fs.writeFileSync(path.join(dir, 'web.json'), JSON.stringify([order('FD-2'), order('FD-3', { lines: [{ itemNo: 'NOPE', units: 1 }] })]));
  fs.writeFileSync(path.join(dir, 'notes.csv'), 'ref\nx\n');
  fs.writeFileSync(path.join(dir, 'readme.txt'), 'left alone');
  const out = box.poll();
  assert.equal(out['orders-1102.csv'].ok, true);
  assert.equal(out['web.json'].ok, false, 'one refused document sends the file to failed/');
  assert.match(out['notes.csv'].error, /starts with orders or asn/);
  assert.ok(wh.orders['FD-1'] && wh.orders['FD-2'] && !wh.orders['FD-3']);
  const done = fs.readdirSync(path.join(dir, 'done'));
  const failed = fs.readdirSync(path.join(dir, 'failed'));
  assert.ok(done.some((f) => f.endsWith('orders-1102.csv')) && done.some((f) => f.endsWith('orders-1102.csv.result.json')));
  assert.equal(failed.filter((f) => f.endsWith('.result.json')).length, 2);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['done', 'failed', 'readme.txt']);
  // Fixed and dropped again: what went in before answers duplicate.
  fs.writeFileSync(path.join(dir, 'web.json'), JSON.stringify([order('FD-2'), order('FD-3')]));
  const again = box.poll();
  assert.deepEqual(again['web.json'].results.map((x) => x.status), ['duplicate', 'created']);
  // A file still being written waits.
  fs.writeFileSync(path.join(dir, 'late.json'), JSON.stringify(order('FD-4')));
  now = Date.now();
  assert.deepEqual(box.poll(), {});
  fs.rmSync(dir, { recursive: true, force: true });
});
