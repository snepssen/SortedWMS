// Behaviour the other tests did not reach: holder and item edits, faults,
// dedicated space, stock sent between sites, plate labels, and the backup
// and sample tooling around the server.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { Warehouse } = require('../src/engine');
const { Store } = require('../server/store');
const backups = require('../server/backups');
const { SAMPLES, loadSample } = require('../server/samples');

function wh() {
  const w = new Warehouse({ aisles: [1], bays: 2, levels: 2, positions: [10], outLanes: 1, clock: () => Date.UTC(2026, 9, 8, 8) });
  w.addClient({ id: 'CL-1', name: 'North Shop' });
  w.addItem({ itemNo: 'Y1', name: 'Yoghurt', category: 'YOG', palletQty: 10, weightKg: 500 });
  return w;
}

test('a holder edit checks its type, refuses a parent loop, and must still fit where it stands', () => {
  const w = wh();
  w.createLocation({ code: 'LOW', kind: 'bin', heightMm: 1000 });
  const a = w.addHolder({ id: 'H-A', type: 'pallet', loc: 'LOW', heightMm: 900 });
  w.addHolder({ id: 'H-B', type: 'crate', parentId: 'H-A' });
  assert.throws(() => w.updateHolder('H-A', { type: 'box' }), /Holder type is one of/);
  assert.throws(() => w.updateHolder('H-A', { parentId: 'H-A' }), /cannot contain itself/);
  assert.throws(() => w.updateHolder('H-A', { parentId: 'H-B' }), /parent cycle/);
  assert.throws(() => w.updateHolder('H-A', { parentId: 'NOPE' }), /Unknown holder NOPE/);
  assert.throws(() => w.updateHolder('H-A', { heightMm: 1200 }), /too tall for LOW/);
  w.updateHolder('H-A', { type: 'tote', clientId: 'CL-1', heightMm: 950 });
  assert.equal(a.type, 'tote');
  assert.equal(a.clientId, 'CL-1');
});

test('item edits: barcodes with check digits, unit EAN with units per case, codes, flags and owner', () => {
  const w = wh();
  assert.throws(() => w.updateItem('Y1', { gtin: '5412345678901' }), /wrong check digit/);
  w.updateItem('Y1', { gtin: '5412345678908' });
  assert.equal(w.items.Y1.gtin, '05412345678908');
  assert.equal(w.items.Y1.barcodes[0].type, 'GTIN');
  assert.throws(() => w.updateItem('Y1', { unitGtin: '5412345678908' }), /Units per case/);
  w.updateItem('Y1', { unitGtin: '5412345678908', unitsPerCase: 12 });
  assert.equal(w.items.Y1.unitsPerCase, 12);
  w.updateItem('Y1', { unitGtin: '' });
  assert.equal(w.items.Y1.unitGtin, null);
  w.updateItem('Y1', { codes: 'a1, b2;c3', barcodes: ['x-9', { type: 'QR', value: ' q1 ' }, { value: '' }], food: true, clientId: 'CL-1' });
  assert.deepEqual(w.items.Y1.codes, ['A1', 'B2', 'C3']);
  assert.deepEqual(w.items.Y1.barcodes.map((b) => b.value), ['05412345678908', 'x-9', 'q1']);
  assert.equal(w.items.Y1.flags.food, true);
  assert.equal(w.items.Y1.clientId, 'CL-1');
  w.updateItem('Y1', { gtin: '', clientId: null });
  assert.equal(w.items.Y1.gtin, null);
  assert.equal(w.items.Y1.clientId, null);
  w.stockPallet('01-01-0-10', { itemNo: 'Y1', qty: 10, receivedAt: 1 });
  assert.throws(() => w.updateItem('Y1', { storage: 'block' }), /cannot change while the item is in stock/);
  assert.throws(() => w.updateItem('Y1', { name: ' ' }), /name is required/);
});

test('a fault closes once, with a note, and an unknown one is refused', () => {
  const w = wh();
  w.addEquipment({ id: 'EQ-1', name: 'Wrapper', kind: 'machine' });
  const f = w.reportFault({ equipmentId: 'EQ-1', summary: 'Film tears' }, 'tech');
  assert.equal(w.equipment['EQ-1'].status, 'fault');
  const closed = w.closeFault(f.id, 'New roll fitted', 'tech');
  assert.equal(closed.status, 'closed');
  assert.equal(w.closeFault(f.id, 'again', 'tech').closeNote, closed.closeNote, 'closing twice changes nothing');
  assert.throws(() => w.closeFault(999, 'x'), /No fault 999/);
});

test('dedicated space names a real aisle, bay, position and height', () => {
  const w = wh();
  const saved = w.setSpaces('CL-1', [
    { scope: 'warehouse', fee: 900 },
    { scope: 'aisle', aisle: 1, fee: 100 },
    { scope: 'height', aisle: '01', bay: 2, pos: 10, level: 'b', fee: 5 },
  ]);
  assert.deepEqual(saved.map((s) => s.label), ['Dedicated space (warehouse)', 'Dedicated space (aisle 01)', 'Dedicated space (aisle 01 bay 2 position 10 height B)']);
  assert.throws(() => w.setSpaces('CL-1', [{ scope: 'aisle', aisle: 7, fee: 1 }]), /No aisle 07/);
  assert.throws(() => w.setSpaces('CL-1', [{ scope: 'bay', aisle: 1, bay: 0, fee: 1 }]), /Bay is a whole number/);
  assert.throws(() => w.setSpaces('CL-1', [{ scope: 'position', aisle: 1, bay: 1, fee: 1 }]), /Name the position/);
  assert.throws(() => w.setSpaces('CL-1', [{ scope: 'height', aisle: 1, bay: 1, pos: 10, fee: 1 }]), /Name the height/);
  assert.throws(() => w.setSpaces('CL-1', [{ scope: 'shelf', fee: 1 }]), /Dedicated space is the warehouse/);
  assert.throws(() => w.setSpaces('CL-1', { scope: 'aisle' }), /is a list/);
});

test('stock sent to another site: a whole pallet of that size, else part of a plate; the other site receives it on an ST plate', () => {
  const w = wh();
  const p = w.stockPallet('01-01-0-10', { itemNo: 'Y1', qty: 10, batch: 'B1', receivedAt: 1 });
  const whole = w.exportStock({ itemNo: 'Y1', qty: 10, toSite: 'NORTH' });
  assert.equal(whole.batch, 'B1');
  assert.equal(w.pallets[p.sscc].transferredTo, 'NORTH');
  const { holder } = w.issueSeries({ series: 'ST', itemNo: 'Y1', qty: 6, loc: '01-02-0-10', batch: 'B2' });
  const part = w.exportStock({ itemNo: 'Y1', qty: 4, toSite: 'NORTH' });
  assert.equal(part.batch, 'B2');
  assert.equal(holder.contents[0].qty, 2);
  assert.throws(() => w.exportStock({ itemNo: 'Y1', qty: 50, toSite: 'NORTH' }), /No Y1 stock of 50/);
  assert.throws(() => w.exportStock({ itemNo: 'Y1', qty: 1 }), /destination warehouse/);
  const other = wh();
  const got = other.importStock({ ...part, fromSite: 'MAIN' });
  assert.equal(got.holder.loc, 'DOCK-IN');
  assert.equal(got.holder.contents[0].batch, 'B2');
  assert.throws(() => other.importStock({ itemNo: 'NOPE', qty: 1 }), /no item NOPE/);
});

test('a plate label prints the plate barcode and its contents', () => {
  const w = wh();
  const { label } = w.issueSeries({ series: 'ST', itemNo: 'Y1', qty: 3, loc: '01-01-0-10', batch: 'B9' });
  const doc = w.labelDocument(label.id);
  assert.match(doc.html, /ST0000001/);
  assert.match(doc.html, /<svg/);
  assert.match(doc.html, /B9/);
  assert.throws(() => w.labelDocument(999), /No label 999/);
});

test('backups: a consistent copy, the newest kept, a restore that keeps the old file, and a foreign file refused', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sorted-bk-'));
  try {
    const live = path.join(dir, 'live.db');
    const store = new Store({ file: live, site: JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'server', 'site.blank.json'), 'utf8')) });
    store.exec('applyPreset', { id: 'home-garage' }, 'test');
    const t = Date.UTC(2026, 9, 31, 9);
    for (let i = 0; i < 4; i++) backups.backup(store.db, path.join(dir, 'bk'), { keep: 3, now: t + i * 60000 });
    const kept = backups.listBackups(path.join(dir, 'bk'));
    assert.deepEqual(kept.map((b) => b.file), ['sorted-2026-10-31-090300.db', 'sorted-2026-10-31-090200.db', 'sorted-2026-10-31-090100.db']);
    assert.ok(backups.inspect(kept[0].path).changes >= 1);
    store.close();
    const done = backups.restore(kept[2].path, live, { now: t });
    assert.ok(fs.existsSync(done.kept), 'the replaced file is kept beside it');
    const foreign = path.join(dir, 'other.db');
    const db = new DatabaseSync(foreign);
    db.exec('CREATE TABLE notes (x)');
    db.close();
    assert.throws(() => backups.restore(foreign, live), /not a SortedWMS database/);
    assert.throws(() => backups.restore(path.join(dir, 'missing.db'), live), /No backup at/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('each sample loads into an empty warehouse and leaves a busy one alone', () => {
  const site = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'server', 'site.blank.json'), 'utf8'));
  for (const kind of Object.keys(SAMPLES)) {
    const store = new Store({ site });
    try {
      assert.match(loadSample(store, kind), /Sample loaded/);
      assert.ok(Object.keys(store.wh.items).length >= 4, kind);
      assert.match(loadSample(store, kind), /skipped/);
      store.load();
      assert.ok(Object.keys(store.wh.items).length >= 4, `${kind} replays from the journal`);
    } finally {
      store.close();
    }
  }
  const store = new Store({ site });
  loadSample(store, '3pl');
  store.exec('tick', {}, 'system');
  const wave = Object.values(store.wh.waves)[0];
  assert.deepEqual(wave.tasks.map((t) => `${t.kind} ${t.qty}`), ['pallet 240', 'bin 5', 'case 100', 'bin 20', 'pallet 24', 'case 20', 'bin 4']);
  assert.equal(store.wh.module('trucks'), true);
  store.close();
  assert.throws(() => loadSample(new Store({ site }), 'castle'), /Sample is one of home, maker, 3pl/);
});

test('the server makes a backup when the newest is a day old, and not again within the day', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sorted-sched-'));
  const lines = [];
  try {
    const store = new Store({ site: JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'server', 'site.blank.json'), 'utf8')) });
    const first = backups.schedule(store, dir, { keep: 5, log: (l) => lines.push(l), every: 3600000 });
    first.stop();
    assert.equal(first.list().length, 1);
    assert.match(lines[0], /^Backup sorted-.*\.db/);
    const again = backups.schedule(store, dir, { keep: 5, log: (l) => lines.push(l) });
    again.stop();
    assert.equal(again.list().length, 1, 'a backup made today is enough');
    const old = again.list()[0].path;
    const twoDaysAgo = (Date.now() - 2 * 86400000) / 1000;
    fs.utimesSync(old, twoDaysAgo, twoDaysAgo);
    const third = backups.schedule(store, dir, { keep: 5, log: (l) => lines.push(l) });
    third.stop();
    assert.equal(third.list().length, 2);
    assert.equal(third.now().file.startsWith('sorted-'), true);
    store.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
