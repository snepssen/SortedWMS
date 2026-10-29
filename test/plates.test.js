const test = require('node:test');
const assert = require('node:assert/strict');
const GS1 = require('../src/gs1');
const { Warehouse } = require('../src/engine');

function wh() {
  const w = new Warehouse({ aisles: [1], bays: 2, levels: 1, positions: [10], outLanes: 1, clock: () => Date.UTC(2026, 9, 8, 8) });
  w.setFeatures({ highValueSecurity: true });
  w._actor = 'mina';
  w.addClient({ id: 'CL-DAIRY', name: 'Dairy Co' });
  w.addItem({ itemNo: 'Y1', gtin: GS1.makeGtin13('20000', 1), name: 'Yoghurt', category: 'YOG', palletQty: 10, clientId: 'CL-DAIRY' });
  w.addItem({ itemNo: 'NB-14', name: 'Laptop 14 inch', category: 'YOG', palletQty: 1, clientId: 'CL-DAIRY' });
  w.addItem({ itemNo: 'PLUG-EU', name: 'EU power plug', category: 'YOG', palletQty: 1, clientId: 'CL-DAIRY' });
  return w;
}

test('license plates are prefixed, padded, and never reused', () => {
  const w = wh();
  const first = w.allocatePlate('PAL');
  const second = w.allocatePlate('PAL');
  assert.equal(first.id, 'PAL0000001');
  assert.equal(second.id, 'PAL0000002');
  w.setHolderSeries({ PAL: { pad: 7 } });
  assert.throws(() => w.setHolderSeries({ PAL: { next: 1 } }), /cannot go backwards/);
  assert.equal(w.allocatePlate('PAL').id, 'PAL0000003');
  assert.equal(w.allocatePlate('MASTER').id, 'MASTER0000001');
  assert.equal(w.allocatePlate('INB').id, 'INB0000001');
});

test('a full pallet receives a PAL under a MASTER, and consolidation keeps the history', () => {
  const w = wh();
  w.createLocation({ code: 'CONSO00', kind: 'virtual', role: 'consolidation', name: 'conso00' });
  const a = w.stockPallet('DOCK-IN', { itemNo: 'Y1', batch: 'A', expiry: '2027-01-01' });
  const b = w.stockPallet('01-01-0-10', { itemNo: 'Y1', batch: 'B', expiry: '2027-02-01' });
  const labelled = w.issuePlates({ sscc: a.sscc, by: 'omar' });
  assert.equal(labelled.pal.id, 'PAL0000001');
  assert.equal(labelled.master.id, 'MASTER0000001');
  assert.equal(labelled.pal.parentId, 'MASTER0000001');
  assert.deepEqual(labelled.master.children, ['PAL0000001']);
  assert.match(labelled.labels[0].zpl, /PAL0000001/);
  assert.match(labelled.labels[0].zpl, new RegExp(a.sscc));
  assert.match(labelled.labels[1].zpl, /MASTER0000001/);
  assert.match(labelled.labels[1].zpl, /PAL under this MASTER/);
  assert.match(labelled.labels[1].zpl, /PAL0000001/);
  w.issuePlates({ sscc: b.sscc, by: 'omar' });
  const consolidated = w.consolidate({ pals: ['PAL0000001', 'PAL0000002'], at: 'CONSO00', by: 'morgan' });
  assert.equal(consolidated.master.id, 'MASTER0000001', 'the earliest MASTER survives');
  assert.equal(w.holders.MASTER0000002.status, 'retired');
  assert.equal(w.holders.MASTER0000002.supersededBy, 'MASTER0000001');
  assert.equal(w.holderSeries.MASTER.next, 3, 'retired numbers are not reused');
  assert.ok(w.movementsFor({ holder: 'MASTER0000002' }).some((m) => m.event === 'retired'));
  assert.deepEqual(consolidated.master.children.sort(), ['PAL0000001', 'PAL0000002']);
  assert.equal(w.holders.PAL0000001.parentId, consolidated.master.id);
  assert.equal(w.pallets[a.sscc].loc, 'CONSO00');
  const story = w.movementsFor({ holder: 'PAL0000001' }).map((m) => m.event);
  assert.ok(story.includes('received') && story.includes('labelled') && story.includes('consolidated'));
  assert.ok(w.movementsFor({ user: 'morgan' }).some((m) => m.event === 'consolidated' && m.to === 'CONSO00'));
  assert.throws(() => w.removeHolder('PAL0000001'), /never reused/);
});

test('consolidation can keep a later MASTER, and refuses a plate that is not already a parent', () => {
  const w = wh();
  w.createLocation({ code: 'CONSO00', kind: 'virtual', role: 'consolidation', name: 'conso00' });
  const a = w.stockPallet('DOCK-IN', { itemNo: 'Y1', batch: 'A', expiry: '2027-01-01' });
  const b = w.stockPallet('01-01-0-10', { itemNo: 'Y1', batch: 'B', expiry: '2027-02-01' });
  const c = w.stockPallet('01-02-0-10', { itemNo: 'Y1', batch: 'C', expiry: '2027-03-01' });
  w.issuePlates({ sscc: a.sscc });
  w.issuePlates({ sscc: b.sscc });
  w.issuePlates({ sscc: c.sscc });
  const saved = w.holders.PAL0000001.parentId;
  w.holders.PAL0000001.parentId = null;
  assert.throws(() => w.consolidate({ pals: ['PAL0000001', 'PAL0000002'], at: 'CONSO00' }), /no MASTER plate to reuse/);
  w.holders.PAL0000001.parentId = saved;
  assert.throws(() => w.consolidate({ pals: ['PAL0000001', 'PAL0000002'], at: 'CONSO00', master: 'MASTER0000003' }), /already parents/);
  const kept = w.consolidate({ pals: ['PAL0000001', 'PAL0000002'], at: 'CONSO00', master: 'MASTER0000002', by: 'morgan' });
  assert.equal(kept.master.id, 'MASTER0000002');
  assert.equal(w.holders.MASTER0000001.status, 'retired');
  assert.equal(w.holders.MASTER0000001.supersededBy, 'MASTER0000002');
  assert.equal(w.holders.MASTER0000003.status, undefined);
  assert.equal(w.holderSeries.MASTER.next, 4);
  assert.deepEqual(kept.master.children.sort(), ['PAL0000001', 'PAL0000002']);
  const closed = w.movementsFor({ holder: 'MASTER0000001' }).find((m) => m.event === 'retired');
  assert.equal(closed.by, 'morgan');
  assert.match(closed.note, /MASTER0000002/);
  assert.throws(() => w.consolidate({ pals: ['PAL0000001', 'PAL0000003'], at: 'CONSO00', master: 'MASTER0000001' }), /retired/);
});

test('each warehouse has its own plate counters', () => {
  const a = wh();
  const b = wh();
  assert.equal(a.allocatePlate('PAL').id, 'PAL0000001');
  assert.equal(a.allocatePlate('ST').id, 'ST0000001');
  assert.equal(b.allocatePlate('PAL').id, 'PAL0000001');
  assert.equal(b.holderSeries.PAL.next, 2);
  assert.equal(a.holderSeries.PAL.next, 2);
  assert.equal(b.holderSeries.ST.next, 1);
});

test('virtual staging locations and mezzanine picks are traced', () => {
  const w = wh();
  w.createLocation({ code: 'STAGE01', kind: 'virtual', role: 'staging', name: 'Staging' });
  w.createLocation({ code: 'MEZZ-A1', kind: 'mezzanine', name: 'Mezzanine A1' });
  const inbound = w.issueSeries({ series: 'INB', itemNo: 'Y1', qty: 4, loc: 'DOCK-IN', by: 'omar' });
  assert.equal(inbound.holder.id, 'INB0000001');
  const stock = w.issueSeries({ series: 'ST', itemNo: 'Y1', qty: 2, loc: 'MEZZ-A1', by: 'omar' });
  w.pickHolder({ id: stock.holder.id, by: 'omar' });
  const picked = w.movementsFor({ holder: stock.holder.id });
  assert.equal(picked[0].event, 'picked');
  assert.equal(picked[0].by, 'omar');
  assert.equal(picked[0].from, 'MEZZ-A1');
  assert.equal(picked[0].qty, 2);
  w.issueSeries({ series: 'OUT', itemNo: 'Y1', qty: 1, loc: 'STAGE01', by: 'olivia' });
  assert.equal(w.holders.OUT0000001.loc, 'STAGE01');
});

test('kitting scans a base product and then its components', () => {
  const w = wh();
  w.addKit({ id: 'KIT-PLUG', name: 'Laptop with EU plug', base: { itemNo: 'NB-14', qty: 1 }, components: [{ itemNo: 'PLUG-EU', qty: 1 }] });
  w.addValStation({ id: 'VAL-01', name: 'Kitting line', kitId: 'KIT-PLUG' });
  const job = w.startVal({ stationId: 'VAL-01', by: 'omar' });
  assert.equal(job.status, 'open');
  assert.throws(() => w.scanVal({ stationId: 'VAL-01', code: 'PLUG-EU', by: 'omar' }), /not the next scan/);
  w.scanVal({ stationId: 'VAL-01', code: 'NB-14', by: 'omar' });
  const done = w.scanVal({ stationId: 'VAL-01', code: 'PLUG-EU', by: 'omar' });
  assert.equal(done.status, 'done');
  assert.deepEqual(done.got.map((g) => g.itemNo), ['NB-14', 'PLUG-EU']);
});

test('technical settings cover auto-sort and location defaults, and a manager can read movement history', () => {
  const w = wh();
  w.setTechnical({ autoSort: { strategy: 'fifo', rules: [{ category: 'YOG', putaway: 'rack' }] }, locationDefaults: { mezzanine: { heightMm: 1500, widthMm: 800, depthMm: 1200, maxWeightKg: 350 } } });
  assert.equal(w.technical.autoSort.strategy, 'fifo');
  assert.equal(w.technical.autoSort.rules[0].putaway, 'rack');
  assert.equal(w.technical.locationDefaults.mezzanine.heightMm, 1500);
  assert.throws(() => w.setTechnical({ autoSort: { strategy: 'random' } }), /fefo, fifo or nearest/);
});
