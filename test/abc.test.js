const test = require('node:test');
const assert = require('node:assert/strict');
const { Warehouse } = require('../src/engine');

function wh(now = Date.UTC(2026, 10, 5, 23, 30)) {
  const w = new Warehouse({ aisles: [1], bays: 2, levels: 1, positions: [10], outLanes: 1, clock: () => now, config: { timeZone: 'Europe/Brussels' } });
  w.addItem({ itemNo: 'FAST', name: 'Fast', category: 'GEN', palletQty: 10, value: 1 });
  w.addItem({ itemNo: 'SLOW', name: 'Slow', category: 'GEN', palletQty: 10, value: 5000 });
  w.createLocation({ code: 'BIN-A', kind: 'bin', name: 'Bin A' });
  w.createLocation({ code: 'BIN-B', kind: 'bin', name: 'Bin B' });
  return w;
}

test('classes follow velocity or value, and the daily list uses the warehouse timezone', () => {
  const w = wh();
  // 23:30 UTC is 00:30 the next day in Brussels.
  assert.equal(w.localDay(), '2026-11-06');
  for (let i = 0; i < 9; i++) w.recordMovement({ from: 'BIN-A', to: 'ORDER-1', qty: 10, event: 'picked', by: 'picker', note: 'FAST' });
  w.recordMovement({ from: 'BIN-B', to: 'ORDER-1', qty: 1, event: 'picked', by: 'picker', note: 'SLOW' });
  let classes = w.abcClasses();
  assert.equal(classes.items.FAST.class, 'A');
  assert.equal(classes.items.SLOW.class, 'C');
  w.items.FAST.value = 1;
  w.items.SLOW.value = 5000;
  w.setAbc({ basis: 'value' });
  classes = w.abcClasses();
  assert.equal(classes.items.SLOW.class, 'A', 'value puts the expensive slow mover first');
  w.setAbcClass('SLOW', 'B');
  assert.equal(w.abcClasses().items.SLOW.class, 'B');
  assert.equal(w.abcClasses().items.SLOW.fixed, true);

  w.binPut({ loc: 'BIN-A', itemNo: 'FAST', qty: 8 });
  w.binPut({ loc: 'BIN-B', itemNo: 'SLOW', qty: 4 });
  w.setAbc({ basis: 'velocity', frequency: { A: 1, B: 1, C: 1 }, thresholdQty: 1, thresholdPercent: 0 });
  const first = w.planAbcDay();
  assert.equal(first.day, '2026-11-06');
  assert.ok(first.lines.length >= 2);
  const again = w.planAbcDay();
  assert.deepEqual(again.lines.map((l) => l.id), first.lines.map((l) => l.id));
  const counter = w.abcMine('ina');
  assert.equal(counter.blind, true);
  assert.equal(counter.expected, null);
  const manager = w.abcBoard({ reveal: true });
  assert.ok(manager.lines.every((l) => l.expected == null || typeof l.expected === 'number'));
});

test('a small variance adjusts at once, a large one waits for another person and then approval', () => {
  const w = wh();
  w.binPut({ loc: 'BIN-A', itemNo: 'FAST', qty: 10 });
  w.setAbc({ thresholdQty: 1, thresholdPercent: 0, frequency: { A: 1, B: 1, C: 1 } });
  w.planAbcDay();
  const line = w.abcBoard({ reveal: true }).lines.find((l) => l.itemNo === 'FAST');
  const close = w.submitAbc({ id: line.id, qty: 10, by: 'ina' });
  assert.equal(close.status, 'matched');
  assert.equal(w.binContents('BIN-A').lines[0].qty, 10);

  w.binPut({ loc: 'BIN-B', itemNo: 'SLOW', qty: 10 });
  // Today's list is already built. Put the slow item on it directly.
  const book = w.abcDays[w.localDay()];
  book.lines.push({ id: 'ABC-EXTRA', loc: 'BIN-B', itemNo: 'SLOW', class: 'C', status: 'open', counts: [] });
  assert.throws(() => w.submitAbc({ id: 'ABC-EXTRA', qty: 7, by: 'ina' }), /Reason is one of/);
  const held = w.submitAbc({ id: 'ABC-EXTRA', qty: 7, reason: 'damage', by: 'ina' });
  assert.equal(held.status, 'recount');
  assert.equal(held.expected, null, 'the counter still does not see the booked quantity');
  assert.equal(w.binContents('BIN-B').lines[0].qty, 10, 'stock waits');
  assert.throws(() => w.recountAbc({ id: 'ABC-EXTRA', qty: 7, reason: 'damage', by: 'ina' }), /different person/);
  const recounted = w.recountAbc({ id: 'ABC-EXTRA', qty: 6, reason: 'damage', by: 'otto' });
  assert.equal(recounted.status, 'approval');
  assert.equal(w.binContents('BIN-B').lines[0].qty, 10);
  assert.throws(() => w.approveAbc({ id: 'ABC-EXTRA', by: 'otto' }), /not the person who counted/);
  const approved = w.approveAbc({ id: 'ABC-EXTRA', by: 'maya' });
  assert.equal(approved.status, 'adjusted');
  assert.equal(approved.expected, 10);
  assert.equal(w.binContents('BIN-B').lines[0].qty, 6);
  assert.ok(w.events.some((e) => /approved by maya/.test(e.text)));
  const row = w.journal ? null : w.adjustments[0];
  assert.equal(row.reason, 'damage');
  assert.equal(row.by, 'maya');

  book.lines.push({ id: 'ABC-NO', loc: 'BIN-A', itemNo: 'FAST', class: 'A', status: 'open', counts: [] });
  w.submitAbc({ id: 'ABC-NO', qty: 4, reason: 'missing', by: 'ina' });
  w.recountAbc({ id: 'ABC-NO', qty: 4, reason: 'missing', by: 'otto' });
  w.rejectAbc({ id: 'ABC-NO', reason: 'Count the aisle again tomorrow', by: 'maya' });
  assert.equal(w.binContents('BIN-A').lines[0].qty, 10, 'a rejection does not change stock');
});

test('the module gates the list, and a journal replay keeps the approval', () => {
  const { Store } = require('../server/store');
  const site = { name: 'Count', layout: { aisles: [], bays: 1, levels: 1, positions: [10], outLanes: 1 }, categories: { GEN: 'General' } };
  let t = Date.UTC(2026, 10, 5, 10);
  const store = new Store({ site, now: () => t });
  try {
    store.wh.setConfig({ timeZone: 'Europe/Brussels' });
    store.exec('addItem', { itemNo: 'FAST', name: 'Fast', category: 'GEN', palletQty: 1 }, 'admin');
    store.exec('createLocation', { code: 'BIN-A', kind: 'bin', name: 'Bin A' }, 'admin');
    store.exec('binPut', { loc: 'BIN-A', itemNo: 'FAST', qty: 5 }, 'ina');
    store.exec('setAbc', { settings: { thresholdQty: 0, thresholdPercent: 0, frequency: { A: 1, B: 1, C: 1 } } }, 'maya');
    store.exec('planAbc', {}, 'ina');
    const id = store.wh.abcDays[store.wh.localDay()].lines[0].id;
    store.exec('submitAbc', { id, qty: 2, reason: 'missing' }, 'ina');
    assert.equal(store.wh.binContents('BIN-A').lines[0].qty, 5);
    store.exec('recountAbc', { id, qty: 2, reason: 'missing' }, 'otto');
    store.exec('approveAbc', { id }, 'maya');
    assert.equal(store.wh.binContents('BIN-A').lines[0].qty, 2);
    store.load();
    assert.equal(store.wh.binContents('BIN-A').lines[0].qty, 2);
    assert.equal(store.wh.abcDays[store.wh.localDay()].lines[0].status, 'adjusted');
    store.exec('setModules', { modules: { abc: false } }, 'admin');
    assert.throws(() => store.wh.planAbcDay(), /switched off/);
  } finally {
    store.close();
  }
});
