// The office, station and desk screens' API paths, on the example site.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const GS1 = require('../src/gs1');
const { Store } = require('../server/store');
const { Printers } = require('../server/print');
const { createApi } = require('../server/api');
const { seedDemo } = require('../server/seed');

const site = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'server', 'site.example.json'), 'utf8'));

function setup() {
  let t = Date.UTC(2026, 9, 8, 6);
  const store = new Store({ site, now: () => (t += 7000) });
  seedDemo(store);
  const api = createApi({ store, printers: new Printers({}) });
  const call = async (method, url, body, by = 'office') => {
    const r = await api.handle(method, url, body, by);
    if (r.status >= 400) throw Object.assign(new Error(r.body.error), { status: r.status });
    return r.body;
  };
  return { store, call };
}

test('orders import from a spreadsheet: rows with one order number make one order with several lines', async () => {
  const { store, call } = setup();
  const r = await call('POST', '/api/import/orders', { rows: [
    { orderId: 4601, customer: 'Fresh Market', lane: 'OUT-03', itemNo: 'Y1001', pallets: 1 },
    { orderId: 4601, customer: 'Fresh Market', lane: 'OUT-03', itemNo: 'Y1002', pallets: 1, verifyLoading: '1' },
    { orderId: 4602, customer: 'City Deli', lane: 'OUT-04', itemNo: 'C2001', pallets: 1, process: 'CHANGE' },
    { orderId: 4603, customer: 'Nobody', lane: 'NOT-A-LANE', itemNo: 'Y1001', pallets: 1 },
  ] });
  assert.equal(r.added, 2);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /^4603:/);
  assert.deepEqual(store.wh.orders['4601'].lines.map((l) => l.itemNo), ['Y1001', 'Y1002']);
  assert.equal(store.wh.orders['4602'].lines[0].process, 'CHANGE');
});

test('a delivery announced with its list is received with one scan per pallet', async () => {
  const { store, call } = setup();
  const s = GS1.makeSscc(3, '8711111', 77);
  await call('POST', '/api/deliveries', { id: 'D-3001', supplier: 'A-ware', category: 'YOG', pallets: 1, list: [{ sscc: s, itemNo: '05459', batch: '810040274', expiry: '2026-11-09', qty: 80 }] });
  await call('POST', '/api/config', { priority: ['RECEIVE', 'PICK', 'MOVE', 'CHECK', 'PUTAWAY', 'SHIFT'] });
  await call('POST', '/api/devices', { id: 'HH09', categories: ['YOG'] });
  // HH09 is idle and gets a receiving job; the yoghurt deliveries are D-2042 and D-3001.
  let dev = await call('GET', '/api/devices/HH09');
  while (dev.instruction.kind === 'receive' && dev.instruction.delivery.id !== 'D-3001') {
    await call('POST', '/api/devices/HH09/scan', { code: 'CMD-DONE' });
    await call('POST', '/api/devices/HH09/scan', { code: 'CMD-DONE' });
    dev = await call('GET', '/api/devices/HH09');
  }
  assert.equal(dev.instruction.delivery.id, 'D-3001');
  await call('POST', '/api/devices/HH09/scan', { code: `00${s}` });
  const p = store.wh.pallets[s];
  assert.deepEqual([p.itemNo, p.batch, p.expiry, p.qty], ['05459', '810040274', '2026-11-09', 80]);
});

test('a new operator changes the handheld\'s categories', async () => {
  const { store, call } = setup();
  await call('POST', '/api/devices/HH01/categories', { categories: ['CHE'] });
  assert.deepEqual(store.wh.trucks.HH01.categories, ['CHE']);
  await call('POST', '/api/devices/HH01/categories', { categories: null });
  assert.equal(store.wh.trucks.HH01.categories, null);
});

test('station screen: list, process started from the office, start and finish by scanning', async () => {
  const { store, call } = setup();
  const stations = await call('GET', '/api/stations');
  assert.deepEqual(stations.map((s) => s.id), ['PRESS', 'FOIL', 'PLATE', 'WARM']);
  assert.deepEqual((await call('GET', '/api/routes')).map((r) => r.id), ['CHANGE', 'FOIL', 'HOLES']);
  const wh = store.wh;
  const p = Object.values(wh.pallets).find((x) => x.itemNo === 'C2001' && wh.locations[x.loc].kind === 'rack' && !Object.values(wh.tasks).some((t) => t.sscc === x.sscc && ['open', 'active', 'held'].includes(t.status)));
  await call('POST', `/api/pallets/${p.sscc}/process`, { route: 'CHANGE' });
  // Pretend a truck brought it to the press.
  wh.transferPallet(p.sscc, 'ST-PRESS', { by: 'test' });
  let v = await call('GET', '/api/stations/PRESS');
  assert.ok(v.queue.some((q) => q.sscc === p.sscc) || v.waiting.some((q) => q.sscc === p.sscc));
});

test('receiving desk: start a desk delivery, scans and typed values, the pallet registers', async () => {
  const { store, call } = setup();
  await call('POST', '/api/deliveries', { id: 'D-3002', supplier: 'A-ware', category: 'YOG', pallets: 1, at: 'desk' });
  const desk = (await call('GET', '/api/devices')).find((d) => d.kind === 'desk');
  await call('POST', `/api/desks/${desk.id}/start`, { deliveryId: 'D-3002' });
  let v = await call('GET', `/api/devices/${desk.id}`);
  assert.equal(v.instruction.callout.word, 'BATCH');
  const s = GS1.makeSscc(3, '8711111', 78);
  await call('POST', `/api/devices/${desk.id}/scan`, { code: '810040274' });
  await call('POST', `/api/devices/${desk.id}/scan`, { code: `00${s}` });
  await call('POST', `/api/desks/${desk.id}/enter`, { field: 'expiry', value: '09112026' });
  await call('POST', `/api/devices/${desk.id}/scan`, { code: '9140012009' });
  v = await call('GET', `/api/devices/${desk.id}`);
  assert.equal(v.instruction.field, 'qty');
  await call('POST', `/api/desks/${desk.id}/enter`, { field: 'qty', value: '80' });
  const p = store.wh.pallets[s];
  assert.deepEqual([p.itemNo, p.batch, p.expiry, p.qty], ['05459', '810040274', '2026-11-09', 80]);
  // A scan with no delivery open says so instead of failing.
  const r = await call('POST', `/api/devices/${desk.id}/scan`, { code: 'X' });
  assert.match(r.text, /No delivery open/);
});

test('a pallet set down at its station without the drop scan: a transfer records the arrival', async () => {
  const { store, call } = setup();
  const wh = store.wh;
  const p = Object.values(wh.pallets).find((x) => x.itemNo === 'C2001' && wh.locations[x.loc].kind === 'rack' && !Object.values(wh.tasks).some((t) => t.sscc === x.sscc && ['open', 'active', 'held'].includes(t.status)));
  await call('POST', `/api/pallets/${p.sscc}/process`, { route: 'CHANGE' });
  const move = Object.values(wh.tasks).find((t) => t.sscc === p.sscc && t.type === 'MOVE' && ['open', 'active'].includes(t.status));
  assert.ok(move, 'a truck job to the press');
  // Before: the station says it's still on a truck job.
  wh.locations['ST-PRESS'].pallets.push(p.sscc); const realLoc = p.loc; p.loc = 'ST-PRESS';
  assert.match(wh.stationScan('PRESS', p.sscc).text, /truck job to here/);
  wh.locations['ST-PRESS'].pallets.pop(); p.loc = realLoc;
  const r = await call('POST', '/api/transfer', { sscc: p.sscc, to: 'ST-PRESS' });
  assert.match(r.text, /Arrived at Pallet change/);
  assert.equal(move.status, 'cancelled');
  assert.match(wh.stationScan('PRESS', p.sscc).text, /^Started/);
  assert.match(wh.stationScan('PRESS', p.sscc).text, /^Done in/);
  assert.equal(wh.stationScan('PRESS', p.sscc).text, 'Done here. Waiting for a truck');
});
