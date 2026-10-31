const test = require('node:test');
const assert = require('node:assert/strict');
const { Warehouse } = require('../src/engine');

const DAY = 86400000;

// Two colour variants one key apart: 845356 and 845359. Inbound typed the
// wrong one; the pallet is really 845359.
function wh() {
  let t = Date.UTC(2026, 9, 8, 8);
  const w = new Warehouse({ aisles: [1], bays: 2, levels: 2, positions: [10], outLanes: 1, clock: () => t });
  w.addItem({ itemNo: '845356', name: 'Mug, pink', category: 'YOG', palletQty: 72, uom: 'piece' });
  w.addItem({ itemNo: '845359', name: 'Mug, blue', category: 'YOG', palletQty: 72, uom: 'piece' });
  w.setItemUnits('845356', { packs: [{ unit: 'box', per: 8 }] });
  w.generateGuided({ sections: { count: 1, name: 'Mezz' }, layouts: [{ type: 'shelf', positions: { count: 2, name: 'Bin 1' } }] });
  return { w, later: (ms) => { t += ms; } };
}

test('a wrong item found after a complaint: hold, correct, and the report shows −64 and +64', () => {
  const { w, later } = wh();
  const wrong = w.stockPallet('01-01-1-10', { itemNo: '845356', qty: 72, receivedAt: 1 });
  w.addOrder({ id: 'SO-77', customer: 'Shop', lane: 'OUT-01', lines: [{ itemNo: '845356', units: 8 }] });
  const wave = w.planWave({ orders: ['SO-77'] });
  w.confirmWaveTask({ task: wave.tasks[0].id });
  assert.equal(w.pallets[wrong.sscc].qty, 64);

  // The customer emails: wrong item in SO-77, picked from 01-01-1-10.
  w.addOrder({ id: 'SO-78', customer: 'Shop', lane: 'OUT-01', lines: [{ itemNo: '845356', units: 8 }] });
  const next = w.planWave({ orders: ['SO-78'] });
  const check = w.raiseCheck({ loc: '01-01-1-10', orderId: 'SO-77', itemNo: '845356', note: 'Customer got the wrong item in SO-77', by: 'office' });
  assert.equal(check.cancelledPicks, 1, 'the open pick from that pallet is cancelled');
  assert.equal(next.tasks[0].status, 'cancelled');
  assert.equal(w.shipState(w.pallets[wrong.sscc]), 'blocked', 'nothing is picked from it until it is checked');
  assert.throws(() => w.planWave({ orders: ['SO-78'] }), /Nothing in stock to pick/);
  assert.equal(w.transferPallet(wrong.sscc, '01-02-1-10').ok, false, 'nor transferred');
  assert.equal(w.openChecks()[0].stock[0].itemNo, '845356');

  // Stock control finds 64 of 845359 and corrects it in one go.
  const fix = w.correctItem({ target: wrong.sscc, itemNo: '845359', qty: 64, by: 'sam' });
  assert.equal(fix.from.itemNo, '845356');
  assert.equal(fix.to.itemNo, '845359');
  assert.equal(fix.checkId, check.id);
  assert.equal(w.checks[check.id].status, 'closed');
  assert.equal(w.checks[check.id].outcome, 'corrected');
  const now = w.pallets[fix.to.sscc];
  assert.equal(now.loc, '01-01-1-10');
  assert.equal(now.itemNo, '845359');
  assert.match(now.holderId, /^ST\d+/, 'a new ST plate');
  assert.equal(w.pallets[wrong.sscc].removed, 'corrected');
  assert.equal(w.shipState(now), 'ok');

  later(DAY);
  const report = w.stockChanges({ from: w.localDay(w.now() - DAY), to: w.localDay(w.now() - DAY) });
  assert.deepEqual(report.rows.map((r) => [r.itemNo, r.change, r.correctionId]), [['845356', -64, fix.id], ['845359', 64, fix.id]]);
  assert.deepEqual(report.net.map((n) => [n.itemNo, n.change]), [['845356', -64], ['845359', 64]]);
  assert.match(w.stockChangesCsv({}), /845356,"Mug, pink",-64,wrong item,01-01-1-10/);
});

test('a check that finds nothing wrong just lets the stock go again', () => {
  const { w } = wh();
  const p = w.stockPallet('01-01-1-10', { itemNo: '845356', qty: 72, receivedAt: 1 });
  const check = w.raiseCheck({ loc: '01-01-1-10', note: 'Label looks damaged' });
  assert.throws(() => w.raiseCheck({ loc: '01-01-1-10', note: 'again' }), /already held/);
  assert.throws(() => w.raiseCheck({ loc: '01-02-1-10' }), /Say what to check/);
  w.closeCheck({ id: check.id, outcome: 'ok', note: 'Right item, label replaced' });
  assert.equal(w.shipState(p), 'ok');
  assert.equal(w.transferPallet(p.sscc, '01-02-1-10').ok, true);
});

test('stock on a plate without a pallet is replaced on a new ST plate, and the old number is retired', () => {
  const { w } = wh();
  const { holder: inb } = w.issueSeries({ series: 'INB', itemNo: '845356', qty: 40, loc: 'Mezz-Bin1' });
  w.raiseCheck({ loc: 'Mezz-Bin1', note: 'Wrong colour seen while picking' });
  assert.throws(() => w.moveHolder(inb.id, 'Mezz-Bin2'), /held for stock check/);
  const fix = w.correctItem({ target: inb.id, itemNo: '845359', qty: 40 });
  assert.equal(w.holders[inb.id].status, 'retired');
  assert.equal(w.holders[fix.to.plate].contents[0].itemNo, '845359');
  assert.equal(w.holders[fix.to.plate].loc, 'Mezz-Bin1');
  assert.equal(w.locations['Mezz-Bin1'].checkHold, undefined);
});

test('a bin line booked under the wrong item is corrected without touching the other items in the bin', () => {
  const { w } = wh();
  w.binPut({ loc: 'Mezz-Bin1', itemNo: '845356', qty: 30 });
  w.binPut({ loc: 'Mezz-Bin1', itemNo: '845359', qty: 5 });
  w.raiseCheck({ loc: 'Mezz-Bin1', note: 'Count does not match' });
  assert.throws(() => w.binTake({ loc: 'Mezz-Bin1', itemNo: '845359', qty: 1 }), /held for stock check/);
  assert.throws(() => w.correctItem({ target: 'Mezz-Bin1', itemNo: '845359', qty: 30 }), /more than one item/);
  w.correctItem({ target: 'Mezz-Bin1', fromItem: '845356', itemNo: '845359', qty: 28 });
  assert.deepEqual(w.binContents('Mezz-Bin1').lines.map((l) => [l.itemNo, l.qty]).sort(), [['845359', 28], ['845359', 5]]);
  assert.equal(w.binsFor('845359').total, 33);
  assert.equal(w.binTake({ loc: 'Mezz-Bin1', itemNo: '845359', qty: 33 }).qty, 33, 'the check closed with the correction');
});
