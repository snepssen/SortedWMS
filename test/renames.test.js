const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Warehouse } = require('../src/engine');
const { Store } = require('../server/store');

function wh() {
  const w = new Warehouse({ aisles: [1], bays: 1, levels: 1, positions: [10], outLanes: 1, clock: () => Date.UTC(2026, 9, 8, 8) });
  w.addItem({ itemNo: 'M3', name: 'M3 screw', category: 'YOG', palletQty: 100, uom: 'piece' });
  w.generateGuided({ sections: { count: 1, name: 'Garage' }, layouts: [{ type: 'shelf', bays: { count: 2, name: 'Shelf 1' }, positions: { count: 2, name: 'Bin 1' } }] });
  w.generateGuided({ sections: { count: 1, name: 'Hall' }, layouts: [{ type: 'rack', bays: { count: 2, name: '1' } }] });
  return w;
}

test('a renamed bin keeps its stock, plates, picks and checks, and its old code still scans', () => {
  const w = wh();
  w.binPut({ loc: 'Garage-Shelf1-Bin1', itemNo: 'M3', qty: 50 });
  const { holder } = w.issueSeries({ series: 'ST', itemNo: 'M3', qty: 5, loc: 'Garage-Shelf1-Bin1' });
  w.addOrder({ id: 'O1', customer: 'A', lane: 'OUT-01', lines: [{ itemNo: 'M3', units: 10 }] });
  const wave = w.planWave({});
  w.raiseCheck({ loc: 'Garage-Shelf2-Bin1', note: 'Loose shelf' });
  const out = w.renameLocations({ pairs: [{ from: 'garage-shelf1-bin1', to: 'G-S1-B1' }] });
  assert.deepEqual(out.pairs, [{ from: 'Garage-Shelf1-Bin1', to: 'G-S1-B1' }]);
  assert.equal(w.locations['Garage-Shelf1-Bin1'], undefined);
  assert.equal(w.locations['G-S1-B1'].code, 'G-S1-B1');
  assert.equal(w.binContents('G-S1-B1').lines[0].qty, 50);
  assert.equal(w.holders[holder.id].loc, 'G-S1-B1');
  assert.equal(wave.tasks[0].loc, 'G-S1-B1');
  assert.equal(w.resolve('Garage-Shelf1-Bin1'), 'G-S1-B1', 'the old label still finds it');
  assert.equal(w.binContents('garage-shelf1-bin1').code, 'G-S1-B1');
  w.confirmWaveTask({ task: wave.tasks[0].id, scan: 'Garage-Shelf1-Bin1' });
  assert.equal(w.binContents('G-S1-B1').lines[0].qty, 40);
  assert.deepEqual(w.aliasList(), [{ old: 'GARAGE-SHELF1-BIN1', code: 'G-S1-B1' }]);
  assert.throws(() => w.createLocation({ code: 'Garage-Shelf1-Bin1', kind: 'bin', preserveCase: true }), /old code of G-S1-B1/);
});

test('every code starting the same way is renamed at once; the setup wizard skips old codes; aliases can be dropped', () => {
  const w = wh();
  w.binPut({ loc: 'Garage-Shelf2-Bin2', itemNo: 'M3', qty: 7 });
  const plan = w.renamePlan({ prefix: 'Garage-', to: 'G-' });
  assert.deepEqual(plan.map((p) => p.to), ['G-Shelf1-Bin1', 'G-Shelf1-Bin2', 'G-Shelf2-Bin1', 'G-Shelf2-Bin2']);
  w.renameLocations({ prefix: 'Garage-', to: 'G-' });
  assert.equal(w.binContents('G-Shelf2-Bin2').lines[0].qty, 7);
  const again = w.generateGuided({ sections: { count: 1, name: 'Garage' }, layouts: [{ type: 'shelf', bays: { count: 2, name: 'Shelf 1' }, positions: { count: 2, name: 'Bin 1' } }] });
  assert.equal(again.created, 0, 'running the wizard again does not bring the old codes back');
  assert.equal(w.dropAliases({ code: 'garage-shelf1-bin1' }).dropped, 1);
  assert.equal(w.resolve('Garage-Shelf1-Bin1'), 'GARAGE-SHELF1-BIN1', 'a dropped code finds nothing');
  assert.equal(w.dropAliases({ prefix: 'GARAGE-' }).left, 0);
  assert.throws(() => w.dropAliases({}), /nothing|Say which/i);
});

test('rack slots made on site can be renamed, the site layout and the dock cannot, and bad plans change nothing', () => {
  const w = wh();
  const p = w.stockPallet('Hall-1', { itemNo: 'M3', qty: 100, receivedAt: 1 });
  w.renameLocations({ pairs: [{ from: 'Hall-1', to: 'H01' }] });
  assert.equal(w.pallets[p.sscc].loc, 'H01');
  assert.equal(w.transferPallet(p.sscc, 'Hall-2').ok, true);
  assert.throws(() => w.renamePlan({ pairs: [{ from: '01-01-0-10', to: 'X1' }] }), /part of the site layout/);
  assert.throws(() => w.renamePlan({ pairs: [{ from: 'DOCK-IN', to: 'DOCK' }] }), /site layout|system/);
  assert.throws(() => w.renamePlan({ pairs: [{ from: 'H01', to: 'Hall-2' }] }), /already a location/);
  assert.throws(() => w.renamePlan({ pairs: [{ from: 'H01', to: 'bad code' }] }), /not a code/);
  assert.throws(() => w.renamePlan({ pairs: [{ from: 'H01', to: 'Z' }, { from: 'Hall-2', to: 'z' }] }), /both be z/i);
  assert.throws(() => w.renamePlan({ prefix: 'Nowhere', to: 'X' }), /No location you can rename/);
  w.renameLocations({ pairs: [{ from: 'H01', to: 'Hall-2' }, { from: 'Hall-2', to: 'H01' }] });
  assert.equal(w.locations['Hall-2'].kind, 'rack', 'two codes can swap');
  assert.equal(w.pallets[p.sscc].loc, 'H01');
});

test('a rename is journaled and replays to the same place', () => {
  const site = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'server', 'site.blank.json'), 'utf8'));
  const store = new Store({ site });
  try {
    store.exec('applyPreset', { id: 'home-garage' }, 'test');
    store.exec('generateGuided', { answers: { sections: { count: 1, name: 'Wall' }, layouts: [{ type: 'shelf', positions: { count: 2, name: 'Bin 1' } }] } }, 'test');
    store.exec('addItem', { itemNo: 'AA', name: 'AA battery', category: 'HOME', palletQty: 1, uom: 'piece' }, 'test');
    store.exec('binPut', { loc: 'Wall-Bin1', itemNo: 'AA', qty: 9 }, 'test');
    store.exec('renameLocations', { prefix: 'Wall-', to: 'W' }, 'test');
    store.load();
    assert.equal(store.wh.binContents('WBin1').lines[0].qty, 9);
    assert.equal(store.wh.resolve('Wall-Bin1'), 'WBin1');
  } finally {
    store.close();
  }
});
