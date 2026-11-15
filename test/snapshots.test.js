const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../server/store');
const { Warehouse } = require('../src/engine');

const site = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'site.json'), 'utf8'));

function found(store, itemNo = 'W1001') {
  const code = Object.values(store.wh.locations).find((l) => l.kind === 'rack' && !l.sscc && !l.reservedBy && l.category === store.wh.items[itemNo].category).code;
  store.exec('createStock', { code, itemNo, qty: 5, reason: 'found' }, 'stock');
  return code;
}
const stock = (store) => Object.values(store.wh.pallets).length;

function onDisk(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sorted-snap-'));
  try { return fn(path.join(dir, 'w.db')); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('restore copies the state it is given, unless the caller hands it over', () => {
  const store = new Store({ site });
  try {
    found(store);
    const mine = JSON.parse(JSON.stringify(store.wh));
    const copy = Warehouse.restore(mine, { clock: () => 0 });
    assert.notEqual(copy.pallets, mine.pallets, 'by default the caller keeps its own objects');
    const kept = Warehouse.restore(mine, { clock: () => 0, owned: true });
    assert.equal(kept.pallets, mine.pallets, 'handed over: no second copy');
    assert.deepEqual(JSON.parse(JSON.stringify(kept)), JSON.parse(JSON.stringify(copy)), 'the same warehouse either way');
  } finally { store.close(); }
});

test('a restart from a snapshot gives the same warehouse as replaying the whole journal', () => {
  onDisk((file) => {
    const a = new Store({ file, site });
    for (let i = 0; i < 6; i++) found(a);
    a.snapshot();
    for (let i = 0; i < 3; i++) found(a);
    const want = JSON.stringify(a.wh);
    a.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    a.load();
    assert.equal(JSON.stringify(a.wh), want, 'snapshot, then the journal after it');
    a.db.exec('DELETE FROM snapshots');
    a.load();
    assert.equal(JSON.stringify(a.wh), want, 'the journal alone');
    a.close();
  });
});

test('only the two newest snapshots are kept', () => {
  const store = new Store({ site });
  try {
    for (let i = 0; i < 5; i++) { found(store); store.snapshot(); }
    const rows = store.db.prepare('SELECT journal_id FROM snapshots ORDER BY id').all();
    assert.equal(rows.length, 2);
    assert.equal(rows[1].journal_id, store.lastId);
  } finally { store.close(); }
});

test('a snapshot that cannot be read is passed over for the one before it, and nothing is lost', () => {
  const store = new Store({ site });
  try {
    found(store);
    store.snapshot();
    found(store);
    found(store);
    store.snapshot();
    found(store);
    const want = JSON.stringify(store.wh);
    const newest = store.db.prepare('SELECT id, state FROM snapshots ORDER BY id DESC LIMIT 1').get();

    // Cut short, as a write that never finished.
    store.db.prepare('UPDATE snapshots SET state = ? WHERE id = ?').run(newest.state.slice(0, 2000), newest.id);
    store.load();
    assert.deepEqual(store.snapshotSkipped, [newest.id]);
    assert.equal(JSON.stringify(store.wh), want, 'the older snapshot and a longer stretch of journal reach the same state');
    assert.deepEqual(store.replayErrors, []);

    // Valid JSON that is not a warehouse is passed over too.
    store.db.prepare('UPDATE snapshots SET state = ? WHERE id = ?').run('{"note":"not a warehouse"}', newest.id);
    store.load();
    assert.deepEqual(store.snapshotSkipped, [newest.id]);
    assert.equal(JSON.stringify(store.wh), want);

    // Every snapshot unreadable: the journal alone still rebuilds it.
    store.db.exec("UPDATE snapshots SET state = 'x'");
    store.load();
    assert.equal(store.snapshotSkipped.length, 2);
    assert.equal(JSON.stringify(store.wh), want);
    assert.equal(stock(store), 4);

    // The next snapshot is good again and is the one a restart uses.
    store.snapshot();
    store.load();
    assert.deepEqual(store.snapshotSkipped, []);
    assert.equal(JSON.stringify(store.wh), want);
  } finally { store.close(); }
});
