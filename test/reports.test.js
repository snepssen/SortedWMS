const test = require('node:test');
const assert = require('node:assert/strict');
const { Warehouse } = require('../src/engine');

function wh() {
  const w = new Warehouse({ aisles: [1], bays: 1, levels: 1, positions: [10], outLanes: 1, clock: () => Date.UTC(2026, 10, 5, 23, 30), config: { timeZone: 'Europe/Brussels' } });
  w.addClient({ id: 'CL-1', name: 'North' });
  w.addClient({ id: 'CL-2', name: 'South' });
  w.addItem({ itemNo: 'N1', name: 'North mug', category: 'GEN', palletQty: 10, clientId: 'CL-1' });
  w.addItem({ itemNo: 'S1', name: 'South mug', category: 'GEN', palletQty: 10, clientId: 'CL-2' });
  w.createLocation({ code: 'BIN-N', kind: 'bin', name: 'North bin' });
  w.createLocation({ code: 'BIN-S', kind: 'bin', name: 'South bin' });
  return w;
}

test('reports filter in the warehouse timezone, hide a module that is off, and stay inside one client', () => {
  const w = wh();
  assert.equal(w.localDay(), '2026-11-06');
  w.binPut({ loc: 'BIN-N', itemNo: 'N1', qty: 4 });
  w.binPut({ loc: 'BIN-S', itemNo: 'S1', qty: 9 });
  w.recordMovement({ from: 'BIN-N', to: 'ORDER-1', qty: 2, event: 'picked', by: 'ina', note: 'N1' });
  w.orders.O1 = { id: 'O1', customer: 'Shop', clientId: 'CL-1', status: 'shipped', createdAt: w.now() - 3600000, shippedAt: w.now(), lines: [] };
  const area = w.reportArea({});
  assert.equal(area.timeZone, 'Europe/Brussels');
  assert.ok(area.catalog.some((r) => r.id === 'expiry'));
  assert.ok(area.catalog.some((r) => r.id === 'counts'));
  const stock = area.reports.find((r) => r.id === 'stock');
  assert.equal(stock.rows.length, 2);
  const mine = w.reportById('stock', {}, 'CL-1');
  assert.deepEqual(mine.rows.map((r) => r.item), ['N1']);
  const moves = w.reportById('movements', { user: 'ina', from: '2026-11-06', to: '2026-11-06' });
  assert.equal(moves.rows.length, 1);
  assert.equal(moves.rows[0].day, '2026-11-06');
  assert.equal(moves.rows[0].holder, '');
  const earlier = w.reportById('movements', { from: '2026-11-05', to: '2026-11-05' });
  assert.equal(earlier.rows.length, 0, 'the UTC date is the previous local day');
  const cycle = w.reportById('cycle', { client: 'CL-1' });
  assert.equal(cycle.rows[0].minutes, 60);
  const csv = w.reportCsv('stock', { client: 'CL-1' });
  assert.match(csv.split('\n')[0], /client/);
  assert.match(csv, /N1/);
  assert.doesNotMatch(csv, /S1/);

  w.setModules({ lots: false, abc: false });
  const hidden = w.reportCatalog();
  assert.equal(hidden.some((r) => r.id === 'expiry'), false);
  assert.equal(hidden.some((r) => r.id === 'counts'), false);
  assert.equal(w.reportById('expiry', {}).hidden, true);
  assert.throws(() => w.reportCsv('expiry', {}), /Lots and best-before/);
  w.setModules({ reports: false });
  assert.throws(() => w.reportArea({}), /Reports are switched off/);
});

test('ageing, volumes, utilisation and count accuracy use local dates', () => {
  const w = wh();
  w.binPut({ loc: 'BIN-N', itemNo: 'N1', qty: 3 });
  const ageing = w.reportById('ageing', { item: 'N1' });
  assert.equal(ageing.rows[0].bucket, '0-30');
  w.recordMovement({ from: null, to: 'BIN-N', qty: 3, event: 'received', by: 'ina', note: 'N1' });
  w.recordMovement({ from: 'BIN-N', to: 'OUT', qty: 1, event: 'shipped', by: 'ina', note: 'N1' });
  const volumes = w.reportById('volumes', { from: '2026-11-06', to: '2026-11-06' });
  assert.ok(volumes.rows[0].inboundQty >= 3);
  assert.equal(volumes.rows[0].outboundQty, 1);
  const use = w.reportById('utilisation', { loc: 'BIN-N' });
  assert.equal(use.rows.length, 1);
  assert.ok(use.rows[0].used > 0);
  w.counts = [{ t: w.now(), code: 'BIN-N', result: 'ok', by: 'ina' }];
  const counts = w.reportById('counts', {});
  assert.match(String(counts.rows[0].result), /1 matched/);
});
