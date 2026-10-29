const test = require('node:test');
const assert = require('node:assert/strict');
const GS1 = require('../src/gs1');
const Labels = require('../src/labels');
const { Warehouse } = require('../src/engine');
const { COMMANDS } = require('../server/commands');

function wh() {
  const w = new Warehouse({ aisles: [1], bays: 2, levels: 2, positions: [10], outLanes: 1, clock: () => Date.UTC(2026, 9, 8, 6) });
  w.setFeatures({ temperatureZones: true, lotExpiry: true, fefo: true });
  w.addClient({ id: 'CL-DAIRY', name: 'Dairy Co', email: 'dairy@example.test' });
  w.addItem({
    itemNo: 'Y1', gtin: GS1.makeGtin13('20000', 1), name: 'Yoghurt', category: 'YOG', palletQty: 10, clientId: 'CL-DAIRY',
    uom: 'case', lengthMm: 800, widthMm: 600, heightMm: 400, weightKg: 100,
  });
  w.addItem({ itemNo: 'Y2', gtin: GS1.makeGtin13('20000', 2), name: 'Quark', category: 'YOG', palletQty: 10, clientId: 'CL-DAIRY', lengthMm: 800, widthMm: 600, heightMm: 900, weightKg: 250 });
  return w;
}

test('clients, items and stock stay with the owner', () => {
  const w = wh();
  assert.equal(w.items.Y1.clientId, 'CL-DAIRY');
  assert.equal(w.items.Y1.uom, 'case');
  assert.equal(w.items.Y1.barcodes[0].type, 'GTIN');
  assert.throws(() => w.addItem({ itemNo: 'Z9', name: 'Other', category: 'YOG', palletQty: 1, clientId: 'NOPE' }), /Unknown client/);
  w.archiveClient('CL-DAIRY');
  assert.throws(() => w.addItem({ itemNo: 'Z9', name: 'Other', category: 'YOG', palletQty: 1, clientId: 'CL-DAIRY' }), /archived/);
  w.restoreClient('CL-DAIRY');
  const pallet = w.stockPallet('DOCK-IN', { itemNo: 'Y1', batch: 'L1', expiry: '2027-01-01' });
  assert.equal(pallet.clientId, 'CL-DAIRY');
  assert.equal(w.stockForClient('CL-DAIRY').length, 1);
  w.updateItem('Y1', { name: 'Greek yoghurt', weightKg: 90 });
  assert.equal(w.items.Y1.name, 'Greek yoghurt');
  assert.equal(w.items.Y1.weightKg, 90);
  const spare = w.addItem({ itemNo: 'TEMP', name: 'Temp', category: 'YOG', palletQty: 1, clientId: 'CL-DAIRY' });
  assert.equal(w.removeItem(spare.itemNo).removed, 'TEMP');
  assert.throws(() => w.removeItem('Y1'), /stock history/);
  w.archiveItem('Y2');
  assert.throws(() => w.addOrder({ id: 'O1', customer: 'Shop', lane: 'OUT-01', lines: [{ itemNo: 'Y2', pallets: 1 }] }), /archived/);
});

test('location hierarchy, capacity and fit', () => {
  const w = wh();
  w.createLocation({ code: 'ZONE-CHILL', kind: 'zone', name: 'Chill' });
  w.createLocation({ code: 'AISLE-Z', kind: 'aisle', parent: 'ZONE-CHILL' });
  w.createLocation({ code: 'RACK-Z', kind: 'rack', parent: 'AISLE-Z' });
  w.createLocation({ code: 'LEVEL-A', kind: 'level', parent: 'RACK-Z', level: 'A' });
  const bin = w.createLocation({ code: 'BIN-01', kind: 'bin', parent: 'LEVEL-A', category: 'YOG', heightMm: 500, widthMm: 700, depthMm: 900, maxWeightKg: 120 });
  assert.equal(bin.kind, 'bin');
  assert.equal(w.locations['RACK-Z'].structural, true);
  assert.throws(() => w.stockPallet('RACK-Z', { itemNo: 'Y1', batch: 'L1', expiry: '2027-01-01' }), /cannot hold stock/);
  assert.throws(() => w.stockPallet('BIN-01', { itemNo: 'Y2', batch: 'L2', expiry: '2027-02-01' }), /does not fit/);
  const ok = w.stockPallet('BIN-01', { itemNo: 'Y1', batch: 'L1', expiry: '2027-01-01', qty: 10 });
  assert.equal(ok.loc, 'BIN-01');
  assert.throws(() => w.deleteLocation('BIN-01'), /not empty/);
  w.transferPallet(ok.sscc, 'DOCK-IN', { by: 'test' });
  assert.equal(w.deleteLocation('BIN-01').deleted, 'BIN-01');
  const lane = w.createLocation({ code: 'BL99', kind: 'block', stacks: 2, stackHeight: 3, category: 'YOG' });
  assert.deepEqual(lane.locations, ['BL99-01', 'BL99-02']);
  assert.equal(w.deleteLocation('BL99').deleted, 'BL99');
  assert.equal(w.locations['BL99-01'], undefined);
});

test('holders track what they carry and where they stand', () => {
  const w = wh();
  w.createLocation({ code: 'BIN-01', kind: 'bin', category: 'YOG', heightMm: 2000, widthMm: 1200, depthMm: 1200, maxWeightKg: 500 });
  const tote = w.addHolder({ id: 'H-TOT-01', type: 'tote', loc: 'BIN-01', clientId: 'CL-DAIRY', tareKg: 2 });
  w.loadHolder(tote.id, { itemNo: 'Y1', qty: 2, batch: 'L1', expiry: '2027-01-01' });
  assert.equal(w.holders['H-TOT-01'].loc, 'BIN-01');
  assert.equal(w.holders['H-TOT-01'].contents[0].qty, 2);
  const pallet = w.stockPallet('DOCK-IN', { itemNo: 'Y1', batch: 'L9', expiry: '2027-03-01' });
  const carrier = w.addHolder({ id: 'H-PAL-01', type: 'pallet', clientId: 'CL-DAIRY' });
  w.moveHolder(carrier.id, 'DOCK-IN');
  w.loadHolder(carrier.id, { sscc: pallet.sscc });
  assert.equal(w.pallets[pallet.sscc].holderId, 'H-PAL-01');
  assert.throws(() => w.removeHolder('H-TOT-01'), /not empty/);
  w.unloadHolder('H-TOT-01', { index: 0 });
  assert.equal(w.removeHolder('H-TOT-01').removed, 'H-TOT-01');
});

test('pallet and master labels are ZPL and printable HTML', () => {
  const w = wh();
  const a = w.stockPallet('DOCK-IN', { itemNo: 'Y1', batch: 'L1', expiry: '2027-01-01' });
  const b = w.stockPallet('01-01-0-10', { itemNo: 'Y1', batch: 'L1', expiry: '2027-01-01' });
  const pallet = w.issueLabel({ kind: 'pallet', sscc: a.sscc });
  assert.match(pallet.zpl, /\^XA/);
  assert.match(pallet.zpl, new RegExp(a.sscc));
  assert.match(pallet.zpl, /Client Dairy Co/);
  const master = w.issueLabel({ kind: 'master', children: [a.sscc, b.sscc], title: 'Outbound' });
  assert.match(master.zpl, /MASTER/);
  assert.match(master.zpl, /\(00\)/);
  assert.match(master.zpl, new RegExp(a.sscc));
  assert.equal(w.pallets[a.sscc].masterSscc, master.sscc);
  const doc = w.labelDocument(master.id);
  assert.match(doc.html, /MASTER LABEL/);
  assert.match(doc.html, new RegExp(`\\(00\\) ${master.sscc}`));
  assert.match(doc.html, /Print \/ save as PDF/);
  assert.match(Labels.masterLabel({ sscc: master.sscc, children: [{ sscc: a.sscc, itemNo: 'Y1', qty: 10 }] }), /\^FD>;>800/);
});

test('adjustments need a reason, replenishment is a task, FEFO still ships the earliest expiry', () => {
  const w = wh();
  const early = w.stockPallet('01-01-0-10', { itemNo: 'Y1', batch: 'OLD', expiry: '2026-11-01', qty: 10 });
  const later = w.stockPallet('01-01-1-10', { itemNo: 'Y1', batch: 'NEW', expiry: '2027-02-01', qty: 10 });
  assert.throws(() => w.adjustQuantity(early.sscc, 4, 'because'), /Reason must be one of/);
  const adj = w.adjustQuantity(early.sscc, 4, 'recount', 'office');
  assert.deepEqual([adj.before, adj.after, w.pallets[early.sscc].qty], [10, 4, 4]);
  w.createLocation({ code: 'BIN-01', kind: 'bin', category: 'YOG', heightMm: 2000, widthMm: 2000, depthMm: 2000, maxWeightKg: 500 });
  const task = w.replenish('Y1', 'BIN-01');
  assert.equal(task.reason, 'replenish');
  assert.equal(task.sscc, early.sscc);
  assert.equal(task.to, 'BIN-01');
  const order = w.addOrder({ id: 'O1', customer: 'Shop', lane: 'OUT-01', lines: [{ itemNo: 'Y1', pallets: 1 }], clientId: 'CL-DAIRY' });
  assert.equal(order.clientId, 'CL-DAIRY');
  assert.ok(order.lines[0].allocated.includes(later.sscc) || order.lines[0].allocated.includes(early.sscc));
  w.addDelivery({ id: 'ASN-1', supplier: 'Farm', category: 'YOG', pallets: 1, asn: 'ASN-1', clientId: 'CL-DAIRY', expectedAt: '2026-10-09' });
  assert.equal(w.deliveries['ASN-1'].asn, 'ASN-1');
  assert.equal(COMMANDS.recordPacking(w, { id: 'O1', note: 'Wrapped' }, 'office').note, 'Wrapped');
  assert.ok(w.search('dairy').clients.some((c) => c.id === 'CL-DAIRY'));
  assert.ok(w.search('Y1').items.some((i) => i.itemNo === 'Y1'));
  assert.ok(w.search(early.sscc).pallets.some((p) => p.sscc === early.sscc));
});
