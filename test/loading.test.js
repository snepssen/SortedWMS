const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { buildWarehouse } = require('../server/site');
const { Warehouse } = require('../src/engine');
const { Store } = require('../server/store');
const { createApi } = require('../server/api');
const { createServer } = require('../server/index');
const { Walkthrough } = require('../src/walkthrough');
const site = require('../server/site.example.json');
const now = () => Date.UTC(2026, 9, 8, 6);

function stage(wh, id = '5001', count = 2, verifyLoading = true) {
  const pallets = Array.from({ length: count }, (_, i) => wh.stockPallet(wh.resolve(`AA0${i + 1}A1`), { itemNo: 'Y1001', batch: `LOAD-${id}-${i}`, expiry: '2026-11-20' }));
  const order = wh.addOrder({ id, customer: 'Demo customer', lane: 'OUT-01', verifyLoading, lines: [{ itemNo: 'Y1001', pallets: count }] });
  if (!wh.trucks.RT1) wh.addTruck('RT1', { categories: ['YOG'] });
  for (let i = 0; i < count * 2; i++) {
    const ins = wh.instruction('RT1');
    assert.ok(wh.scan('RT1', ins.kind === 'pickup' ? ins.pallet.sscc : ins.target).ok);
  }
  assert.equal(order.status, 'ready');
  return { order, pallets };
}
function setup(count = 2) {
  const wh = buildWarehouse(site, now);
  wh.setConfig({ checkAfterPick: false, groundNextPerItem: 0 });
  return { wh, ...stage(wh, '5001', count) };
}
function load(wh, p, id = '5001', device = 'LOAD-01') {
  wh.scanLoading(id, device, `]C100${p.sscc}`, false, 'operator');
  return wh.scanLoading(id, device, wh.orders[id].loading.location, false, 'operator');
}
function unchanged(wh, action, pattern) {
  const before = JSON.stringify(wh);
  assert.throws(action, pattern);
  assert.equal(JSON.stringify(wh), before);
}

test('verified loading requires a ready, fully allocated manifest and a unique trailer', () => {
  const { wh, order } = setup();
  unchanged(wh, () => wh.shipOrder(order.id), /Open a trailer manifest/);
  for (const trailer of ['', 'bad id', null, 'a'.repeat(31)]) unchanged(wh, () => wh.startLoading(order.id, trailer), /Trailer ID/);
  wh.startLoading(order.id, ' demo-07 ', 'coordinator');
  assert.equal(order.loading.trailer, 'DEMO-07');
  unchanged(wh, () => wh.startLoading(order.id, 'NEW'), /already has a trailer/);
  const second = stage(wh, '5002', 1);
  unchanged(wh, () => wh.startLoading(second.order.id, 'DEMO-07'), /another active order/);
  second.order.lines[0].pallets++;
  second.order.lines[0].short++;
  unchanged(wh, () => wh.startLoading('5002', 'DEMO-08'), /shortages/);
});

test('pallet plus trailer scans move stock once; wrong and duplicate scans leave it unchanged', () => {
  const { wh, pallets: [first, second] } = setup();
  wh.startLoading('5001', 'DEMO-07');
  const extra = wh.stockPallet(wh.resolve('AB01A1'), { itemNo: 'Y1001', batch: 'OTHER', expiry: '2026-12-20' });
  unchanged(wh, () => wh.scanLoading('5001', 'LOAD-01', extra.sscc), /not allocated/);
  unchanged(wh, () => wh.scanLoading('5001', 'LOAD-01', 'TRAILER-DEMO-07'), /not allocated/);
  wh.scanLoading('5001', 'LOAD-01', `]C100${first.sscc}`);
  assert.equal(first.loc, 'OUT-01');
  unchanged(wh, () => wh.scanLoading('5001', 'LOAD-01', 'TRAILER-WRONG'), /Wrong destination/);
  wh.scanLoading('5001', 'LOAD-01', 'TRAILER-DEMO-07');
  assert.equal(first.loc, 'TRAILER-DEMO-07');
  assert.deepEqual(wh.locations[first.loc].pallets, [first.sscc]);
  unchanged(wh, () => wh.scanLoading('5001', 'LOAD-01', first.sscc), /already loaded/);
  unchanged(wh, () => wh.shipOrder('5001', { seal: 'S1' }), /loaded on/);
  assert.equal(second.loc, 'OUT-01');
});

test('eligibility and location are checked again between the two loading scans', () => {
  const { wh, pallets: [p] } = setup(1);
  wh.startLoading('5001', 'DEMO-07');
  wh.scanLoading('5001', 'LOAD-01', p.sscc);
  wh.recordTemperature(p.sscc, 9, 2, 6, 'Outbound concern');
  unchanged(wh, () => wh.scanLoading('5001', 'LOAD-01', 'TRAILER-DEMO-07'), /Quality hold/);
  assert.equal(p.loc, 'OUT-01');
  wh.releaseQualityHold(p.sscc, 'Reviewed');
  wh.transferPallet(p.sscc, wh.resolve('AB01A1'));
  unchanged(wh, () => wh.scanLoading('5001', 'LOAD-01', 'TRAILER-DEMO-07'), /not staged/);
  wh.scanLoading('5001', 'LOAD-01', 'CMD-CANCEL');
  assert.deepEqual(wh.orders['5001'].loading.pending, {});
});

test('concurrent scanners cannot load one pallet twice or discharge a pending movement', () => {
  const { wh, pallets: [p] } = setup(1);
  wh.startLoading('5001', 'DEMO-07');
  wh.scanLoading('5001', 'LOAD-01', p.sscc);
  wh.scanLoading('5001', 'LOAD-02', p.sscc);
  wh.scanLoading('5001', 'LOAD-01', 'TRAILER-DEMO-07');
  unchanged(wh, () => wh.scanLoading('5001', 'LOAD-02', 'TRAILER-DEMO-07'), /already loaded/);
  unchanged(wh, () => wh.shipOrder('5001', { seal: 'S1' }), /pending/);
  wh.scanLoading('5001', 'LOAD-02', 'CMD-CANCEL');
  wh.shipOrder('5001', { seal: 'S1' });
  assert.equal(p.status, 'shipped');
});

test('a loaded quality-held or recalled pallet can unload but the whole shipment cannot depart', () => {
  const { wh, order, pallets: [first, second] } = setup();
  wh.startLoading('5001', 'DEMO-07');
  load(wh, first); load(wh, second);
  wh.placeBatchHold('Y1001', first.batch, 'Supplier concern');
  unchanged(wh, () => wh.shipOrder('5001', { seal: 'S1' }), /Batch recall/);
  assert.equal(second.status, 'available');
  assert.equal(second.loc, 'TRAILER-DEMO-07');
  assert.equal(wh.transferPallet(first.sscc, 'OUT-01').ok, false);
  unchanged(wh, () => wh.requestQuarantine(first.sscc, 'Segregate'), /Unload/);
  wh.scanLoading('5001', 'LOAD-01', first.sscc, true);
  unchanged(wh, () => wh.scanLoading('5001', 'LOAD-01', 'OUT-02', true), /Wrong destination/);
  wh.scanLoading('5001', 'LOAD-01', 'OUT-01', true);
  assert.equal(first.loc, 'OUT-01');
  assert.equal(wh.shipState(first), 'blocked');
  // Quarantining the staged pallet creates a shortage, but cannot strand the other loaded pallet.
  wh.requestQuarantine(first.sscc, 'Segregate');
  assert.equal(order.lines[0].short, 1);
  wh.scanLoading('5001', 'LOAD-01', second.sscc, true);
  wh.scanLoading('5001', 'LOAD-01', 'OUT-01', true);
  assert.equal(second.loc, 'OUT-01');
});

test('verified dispatch requires a seal, checks every pallet atomically and preserves the manifest', () => {
  const { wh, order, pallets } = setup();
  wh.startLoading('5001', 'DEMO-07', 'office-1');
  pallets.forEach((p) => load(wh, p));
  for (const seal of [null, '', ' ', 's'.repeat(41)]) unchanged(wh, () => wh.shipOrder('5001', { seal }), /seal ID/);
  wh.setPalletStatus(pallets[1].sscc, 'blocked', 'Damaged');
  unchanged(wh, () => wh.shipOrder('5001', { seal: 'S1' }), /Damaged/);
  assert.ok(pallets.every((p) => p.loc === 'TRAILER-DEMO-07'));
  wh.setPalletStatus(pallets[1].sscc, 'available');
  wh.locations['TRAILER-DEMO-07'].blocked = true;
  unchanged(wh, () => wh.shipOrder('5001', { seal: 'S1' }), /blocked/);
  wh.locations['TRAILER-DEMO-07'].blocked = false;
  wh.shipOrder('5001', { seal: ' SEAL-7 ' }, 'dispatch-1');
  assert.equal(order.status, 'shipped');
  assert.equal(order.loading.seal, 'SEAL-7');
  assert.equal(order.loading.history.at(-1).by, 'dispatch-1');
  assert.equal(wh.shipments[0].loadingHistory.filter((e) => e.kind === 'loaded').length, 2);
  assert.equal(wh.trace(pallets[0].batch).shipped[0].trailer, 'DEMO-07');
  assert.equal(wh.batchRecall('Y1001', pallets[0].batch).shipped[0].seal, 'SEAL-7');
  unchanged(wh, () => wh.scanLoading('5001', 'LOAD-01', pallets[0].sscc, true), /No open/);
  const next = stage(wh, '5002', 1);
  wh.startLoading(next.order.id, 'DEMO-07');
  assert.equal(order.loading.seal, 'SEAL-7', 'reusing a departed trailer does not alter old history');
});

test('ordinary stock corrections and imports cannot bypass trailer verification', () => {
  const { wh, pallets: [p] } = setup(1);
  wh.startLoading('5001', 'DEMO-07');
  assert.equal(wh.transferPallet(p.sscc, 'TRAILER-DEMO-07').ok, false);
  unchanged(wh, () => wh.stockPallet('TRAILER-DEMO-07', { itemNo: 'Y1001', batch: 'IMPORT', expiry: '2026-11-20' }), /loading scans/);
  load(wh, p);
  assert.equal(wh.transferPallet(p.sscc, wh.resolve('AB01A1')).ok, false);
  unchanged(wh, () => wh.startProcess(p.sscc, 'CHANGE'), /not in storage/);
});

test('checked stock that expires while loaded is rejected at the final departure gate', () => {
  const { wh, pallets: [p] } = setup(1);
  wh.startLoading('5001', 'DEMO-07');
  load(wh, p);
  wh.clock = () => Date.UTC(2026, 11, 1, 6);
  unchanged(wh, () => wh.shipOrder('5001', { seal: 'S1' }), /expired/);
  assert.equal(p.loc, 'TRAILER-DEMO-07');
  wh.scanLoading('5001', 'LOAD-01', p.sscc, true);
  wh.scanLoading('5001', 'LOAD-01', 'OUT-01', true);
  assert.equal(p.loc, 'OUT-01');
});

test('loading API, pending scans, actors and trailer inventory survive journal and snapshot recovery', () => {
  const store = new Store({ site, now });
  try {
    store.exec('setConfig', { patch: { checkAfterPick: false, groundNextPerItem: 0 } });
    store.exec('importStock', { rows: [{ code: 'AA01A1', sscc: '387999990000091016', itemNo: 'Y1001', batch: 'LOAD', expiry: '2026-11-20' }] });
    const id = 'PO / 5001', route = encodeURIComponent(id);
    store.exec('addOrder', { id, customer: 'Demo', lane: 'OUT-01', verifyLoading: true, lines: [{ itemNo: 'Y1001', pallets: 1 }] });
    store.exec('addTruck', { id: 'RT1', categories: ['YOG'] });
    store.exec('scan', { id: 'RT1', code: '387999990000091016' });
    store.exec('scan', { id: 'RT1', code: 'OUT-01' });
    const api = createApi({ store, printers: { flush() {}, results: [] } });
    const post = (path, body, by = 'operator-1') => api.handle('POST', `/api/orders/${route}/${path}`, body, by);
    assert.equal(post('ship', { seal: 'S1' }).status, 400);
    assert.equal(post('loading', { trailer: 'DEMO-07' }, 'office-1').status, 200);
    assert.equal(post('loading/scan', { device: 'LOAD-01', code: '387999990000091016' }).status, 200);
    const before = JSON.stringify(store.wh);
    store.load();
    assert.equal(JSON.stringify(store.wh), before);
    assert.deepEqual(store.replayErrors, []);
    assert.equal(post('loading/scan', { device: 'LOAD-01', code: 'TRAILER-WRONG' }).status, 400);
    assert.equal(JSON.stringify(store.wh), before);
    assert.equal(post('loading/scan', { device: 'LOAD-01', code: 'TRAILER-DEMO-07' }).status, 200);
    const report = api.handle('GET', `/api/orders/${route}/loading`).body;
    assert.equal(report.loaded, 1);
    assert.equal(report.loading.history.at(-1).by, 'operator-1');
    assert.equal(Warehouse.restore(store.wh.toJSON(), { clock: now }).pallets['387999990000091016'].loc, 'TRAILER-DEMO-07');
    assert.equal(post('ship', { seal: 'S1' }, 'dispatch-1').status, 200);
    const shipped = JSON.stringify(store.wh);
    store.load();
    assert.equal(JSON.stringify(store.wh), shipped);
    assert.equal(store.wh.shipments[0].seal, 'S1');
  } finally { store.close(); }
});

test('scanner identities cannot affect prototypes and blocked destinations cannot move stock', () => {
  const { wh, pallets: [p] } = setup(1);
  wh.startLoading('5001', 'DEMO-07');
  unchanged(wh, () => wh.scanLoading('5001', '', p.sscc), /Scanner ID/);
  wh.scanLoading('5001', '__proto__', p.sscc);
  assert.equal(Object.getPrototypeOf(wh.orders['5001'].loading.pending), Object.prototype);
  wh.locations['TRAILER-DEMO-07'].blocked = true;
  unchanged(wh, () => wh.scanLoading('5001', '__proto__', 'TRAILER-DEMO-07'), /blocked/);
  assert.equal(p.loc, 'OUT-01');
});

test('guided loading rejects unsafe departure, unloads held stock, reloads and traces the sealed shipment', () => {
  const d = new Walkthrough(site, 'loading');
  for (let i = 0; d.step; i++) {
    d.next();
    if (i === 13) assert.equal(d.wh.pallets[d.first].loc, 'OUT-01');
    if (i === 15) assert.equal(d.wh.orders['5001'].status, 'ready');
    if (i === 19) assert.ok(d.wh.pallets[d.first].qualityHold);
    if (i === 21) assert.equal(d.wh.pallets[d.first].loc, 'OUT-01');
  }
  assert.equal(d.wh.orders['5001'].status, 'shipped');
  assert.equal(d.trace.shipped[0].seal, 'DEMO-SEAL-07');
  assert.equal(d.wh.orders['5001'].loading.history.filter((e) => e.kind === 'unloaded').length, 1);
});

test('loading screen and changed inline scripts parse and the server serves the scanner page', async () => {
  for (const file of ['server/public/loading.html', 'server/public/admin.html', 'walkthrough.html']) {
    for (const [, script] of fs.readFileSync(file, 'utf8').matchAll(/<script>([\s\S]*?)<\/script>/g)) assert.doesNotThrow(() => new vm.Script(script), file);
  }
  const store = new Store({ site, now });
  const server = createServer({ store, printers: { flush() {}, results: [] } });
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const res = await fetch(`http://127.0.0.1:${server.address().port}/loading`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Outbound loading/);
  } finally { await new Promise((resolve) => server.close(resolve)); store.close(); }
});
