const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Warehouse } = require('../src/engine');
const { Store } = require('../server/store');
const { createApi } = require('../server/api');
const { createAuth } = require('../server/auth');
const { createServer } = require('../server/index');
const { Printers } = require('../server/print');
const { createSession } = require('../src/terminal');
const registry = require('../modules/registry');

const blank = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'server', 'site.blank.json'), 'utf8'));

function cookieOf(headers) {
  const raw = (headers.getSetCookie && headers.getSetCookie()[0]) || headers.get('set-cookie') || '';
  return raw.split(';')[0];
}

test('movers use the warehouse timezone, rank fast then slow, and stay inside one client', () => {
  const clock = () => Date.UTC(2026, 5, 15, 22, 30);
  const w = new Warehouse({ aisles: [1], bays: 2, levels: 1, positions: [10], outLanes: 1, clock });
  w.setConfig({ timeZone: 'Europe/Brussels' });
  w.addClient({ id: 'CL-A', name: 'Alpha' });
  w.addClient({ id: 'CL-B', name: 'Beta' });
  w.setModules({ 'client-items': true });
  w.addItem({ itemNo: 'FAST', name: '=Fast', category: 'GEN', palletQty: 10, clientId: 'CL-A', description: 'A red tin' });
  w.addItem({ itemNo: 'SLOW', name: 'Slow', category: 'GEN', palletQty: 10, clientId: 'CL-A' });
  w.addItem({ itemNo: 'OTHER', name: 'Other', category: 'GEN', palletQty: 10, clientId: 'CL-B' });
  w.createLocation({ code: 'BIN-1', kind: 'bin' });
  w.binPut({ loc: 'BIN-1', itemNo: 'FAST', qty: 8 });
  w.addOrder({ id: 'O1', customer: 'Shop', lane: 'OUT-01', clientId: 'CL-A', lines: [{ itemNo: 'FAST', units: 3 }] });
  w.binTake({ loc: 'BIN-1', itemNo: 'FAST', qty: 3, orderId: 'O1' });
  assert.equal(w.localDay(), '2026-06-16');
  const day = w.clientItemMovers({ clientId: 'CL-A', from: '2026-06-16', to: '2026-06-16', actor: { role: 'office' } });
  assert.equal(day.timeZone, 'Europe/Brussels');
  assert.equal(day.rows.find((r) => r.itemNo === 'FAST').unitsOut, 3);
  assert.equal(day.rows.find((r) => r.itemNo === 'FAST').orderLines, 1);
  assert.equal(day.rows.find((r) => r.itemNo === 'FAST').daysSince, 0);
  assert.equal(day.rows.find((r) => r.itemNo === 'FAST').rank, 1);
  assert.equal(day.rows.find((r) => r.itemNo === 'FAST').pace, 'fast');
  assert.equal(day.rows.find((r) => r.itemNo === 'SLOW').pace, 'slow');
  assert.equal(day.rows.find((r) => r.itemNo === 'SLOW').unitsOut, 0);
  assert.equal(day.rows.find((r) => r.itemNo === 'SLOW').daysSince, null);
  assert.equal(day.rows.some((r) => r.itemNo === 'OTHER'), false);
  const yesterday = w.clientItemMovers({ clientId: 'CL-A', from: '2026-06-15', to: '2026-06-15', actor: { role: 'office' } });
  assert.equal(yesterday.rows.find((r) => r.itemNo === 'FAST').unitsOut, 0);
  assert.throws(() => w.clientItemMovers({ clientId: 'CL-B', actor: { role: 'client', clientId: 'CL-A' } }), /another client/);
  const csv = w.clientItemMoversCsv({ clientId: 'CL-A', from: '2026-06-16', to: '2026-06-16', actor: { role: 'client', clientId: 'CL-A' } });
  assert.match(csv, /"Rank","Item"/);
  assert.match(csv, /"'=Fast"/);
  assert.doesNotMatch(csv, /OTHER/);
  const listed = w.clientItemList({ q: 'red tin', actor: { role: 'client', clientId: 'CL-A' } });
  assert.deepEqual(listed.items.map((i) => i.itemNo), ['FAST']);
  assert.equal(listed.photos, false);
  w.setModules({ photos: true });
  assert.equal(w.clientItemList({ actor: { role: 'client', clientId: 'CL-A' } }).items.find((i) => i.itemNo === 'FAST').photos.length, 0);
  w.binPut({ loc: 'BIN-1', itemNo: 'SLOW', qty: 1 });
  w.binTake({ loc: 'BIN-1', itemNo: 'SLOW', qty: 1 });
  assert.throws(() => w.removeItem('SLOW'), /history/);
  w.setModules({ 'client-items': false });
  assert.equal(w.removeItem('SLOW').removed, 'SLOW');
  assert.equal(w.module('client-items'), false);
  assert.equal(registry.presetModules('3pl')['client-items'], true);
  assert.equal(registry.presetModules('home-garage')['client-items'], false);
  assert.deepEqual(registry.get('client-items').dependencies, ['clients']);
});

test('the client keeps the description, staff carry out removals, and tenants stay apart', async () => {
  const store = new Store({ site: blank });
  const auth = createAuth(store.db);
  auth.ensureDemoUsers();
  const server = createServer({ store, printers: new Printers({}), auth });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body, headers = {}) => {
    const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch (e) { parsed = text; }
    return { status: res.status, body: parsed, headers: res.headers };
  };
  const sign = async (username, password) => cookieOf((await call('POST', '/api/login', { username, password })).headers);
  try {
    const admin = await sign('admin', 'sorted-admin');
    const office = await sign('office', 'sorted-office');
    const manager = await sign('manager', 'sorted-manager');
    const stock = await sign('stock', 'sorted-stock');
    assert.equal((await call('GET', '/api/client-items', null, { cookie: admin })).status, 404);
    assert.equal((await call('POST', '/api/client-items', { itemNo: 'X', name: 'X', category: 'GEN' }, { cookie: admin })).status, 403);
    const renamed = await call('POST', '/api/items', { itemNo: 'HOUSE', name: 'House paint', category: 'GEN', palletQty: 4 }, { cookie: office });
    assert.equal(renamed.status, 200, renamed.body && renamed.body.error);
    assert.equal((await call('POST', '/api/items/HOUSE', { name: 'House white' }, { cookie: office })).status, 200);

    await call('POST', '/api/clients', { id: 'CL-A', name: 'Alpha' }, { cookie: admin });
    await call('POST', '/api/clients', { id: 'CL-B', name: 'Beta' }, { cookie: admin });
    const on = await call('POST', '/api/setup/modules', { modules: { 'client-items': true } }, { cookie: admin });
    assert.equal(on.status, 200, on.body && on.body.error);
    const paints = await call('POST', '/api/users', { username: 'alpha', password: 'sorted-alpha', role: 'client', displayName: 'Alpha', clientId: 'CL-A' }, { cookie: admin });
    assert.equal(paints.status, 200, paints.body && paints.body.error);
    assert.equal((await call('POST', '/api/users', { username: 'beta', password: 'sorted-beta', role: 'client', displayName: 'Beta', clientId: 'CL-B' }, { cookie: admin })).status, 200);
    const alpha = await sign('alpha', 'sorted-alpha');
    const beta = await sign('beta', 'sorted-beta');

    const added = await call('POST', '/api/client-items', { itemNo: 'TIN', name: 'Red tin', description: 'Gloss', category: 'GEN', uom: 'tin', codes: 'TIN-1', lengthMm: 10, weightKg: 0.4, clientId: 'CL-B' }, { cookie: alpha });
    assert.equal(added.status, 200, added.body && added.body.error);
    assert.equal(added.body.clientId, 'CL-A');
    assert.equal(added.body.description, 'Gloss');
    const betaItem = await call('POST', '/api/client-items', { itemNo: 'CUP', name: 'Cup', category: 'GEN', uom: 'ea' }, { cookie: beta });
    assert.equal(betaItem.status, 200, betaItem.body && betaItem.error);
    const found = await call('GET', '/api/client-items?q=gloss', null, { cookie: alpha });
    assert.deepEqual(found.body.items.map((i) => i.itemNo), ['TIN']);
    assert.equal((await call('GET', '/api/client-items', null, { cookie: beta })).body.items.some((i) => i.itemNo === 'TIN'), false);
    assert.equal((await call('POST', '/api/client-items/TIN', { name: 'Stolen' }, { cookie: beta })).status, 404);
    assert.equal((await call('POST', '/api/items/TIN', { name: 'Office name' }, { cookie: office })).status, 403);
    assert.equal((await call('POST', '/api/items/TIN', { palletQty: 9 }, { cookie: alpha })).status, 403);
    const ops = await call('POST', '/api/items/TIN', { reorderPoint: 2, palletQty: 6 }, { cookie: office });
    assert.equal(ops.status, 200, ops.body && ops.body.error);
    assert.equal(store.wh.items.TIN.palletQty, 6);
    assert.equal(store.wh.items.TIN.name, 'Red tin');
    assert.equal((await call('POST', '/api/items/TIN', { name: 'No reason' }, { cookie: manager })).status, 403);
    const override = await call('POST', '/api/client-items/TIN', { name: 'Red tin, large', reason: 'Label was wrong' }, { cookie: manager });
    assert.equal(override.status, 200, override.body && override.body.error);
    assert.equal(store.wh.items.TIN.name, 'Red tin, large');
    assert.match(store.wh.events[0].text, /overridden by manager: Label was wrong/);

    const flagged = await call('POST', '/api/client-items/TIN/flag', { note: 'Photo is the old lid' }, { cookie: office });
    assert.equal(flagged.status, 200, flagged.body && flagged.body.error);
    assert.equal((await call('POST', '/api/client-items/TIN/flag', { note: 'no' }, { cookie: alpha })).status, 403);
    assert.equal((await call('GET', '/api/client-items?flagged=1', null, { cookie: beta })).body.items.length, 0);
    const mine = await call('GET', '/api/client-items?flagged=1', null, { cookie: alpha });
    assert.equal(mine.body.items[0].flag.note, 'Photo is the old lid');
    assert.equal((await call('POST', '/api/client-items/TIN/resolve', {}, { cookie: beta })).status, 404);
    assert.equal((await call('POST', '/api/client-items/TIN/resolve', {}, { cookie: office })).status, 403);
    assert.equal((await call('POST', '/api/client-items/TIN/resolve', {}, { cookie: alpha })).body.flag, null);

    await call('POST', '/api/locations', { code: 'BIN-1', kind: 'bin' }, { cookie: admin });
    await call('POST', '/api/bins/put', { loc: 'BIN-1', itemNo: 'TIN', qty: 5 }, { cookie: admin });
    const ask = await call('POST', '/api/client-items/removals', { itemNo: 'TIN', qty: 2, kind: 'write-off', reason: 'Dented' }, { cookie: alpha });
    assert.equal(ask.status, 200, ask.body && ask.body.error);
    assert.equal(store.wh.binStock['BIN-1'][0].qty, 5);
    assert.equal((await call('GET', '/api/client-items/removals', null, { cookie: beta })).body.some((r) => r.id === ask.body.id), false);
    assert.equal((await call('POST', '/api/client-items/removals/' + ask.body.id + '/cancel', {}, { cookie: beta })).status, 404);
    assert.equal((await call('POST', '/api/client-items/removals/' + ask.body.id + '/confirm', {}, { cookie: alpha })).status, 403);
    assert.equal((await call('POST', '/api/stock/adjust', { sscc: '1', qty: 0, reason: 'damage' }, { cookie: alpha })).status, 403);
    const cancelled = await call('POST', '/api/client-items/removals/' + ask.body.id + '/cancel', {}, { cookie: alpha });
    assert.equal(cancelled.body.status, 'cancelled');
    const again = await call('POST', '/api/client-items/removals', { itemNo: 'TIN', qty: 2, kind: 'disposal', reason: 'Leaking' }, { cookie: alpha });
    assert.equal((await call('POST', '/api/client-items/removals/' + again.body.id + '/start', {}, { cookie: stock })).body.status, 'started');
    assert.match((await call('POST', '/api/client-items/removals/' + again.body.id + '/cancel', {}, { cookie: alpha })).body.error, /started/);
    const done = await call('POST', '/api/client-items/removals/' + again.body.id + '/confirm', {}, { cookie: stock });
    assert.equal(done.status, 200, done.body && done.body.error);
    assert.equal(store.wh.binStock['BIN-1'][0].qty, 3);
    assert.equal(store.wh.movements[0].event, 'removed');
    assert.ok(store.wh.adjustments.some((row) => row.itemNo === 'TIN' && row.reason === 'disposal'));
    const movers = await call('GET', '/api/client-items/movers.csv', null, { cookie: alpha });
    assert.equal(movers.status, 200);
    assert.match(movers.body, /TIN/);
    assert.doesNotMatch(movers.body, /CUP/);

    const rest = await call('POST', '/api/client-items/removals', { itemNo: 'TIN', qty: 3, kind: 'collected', reason: 'Empty the bin' }, { cookie: alpha });
    assert.equal((await call('POST', '/api/client-items/removals/' + rest.body.id + '/start', {}, { cookie: stock })).status, 200);
    assert.equal((await call('POST', '/api/client-items/removals/' + rest.body.id + '/confirm', {}, { cookie: stock })).status, 200);
    assert.match((await call('POST', '/api/client-items/TIN/remove', {}, { cookie: alpha })).body.error, /history/);
    const fresh = await call('POST', '/api/client-items', { itemNo: 'NEW', name: 'Unused', category: 'GEN' }, { cookie: alpha });
    assert.equal(fresh.status, 200, fresh.body && fresh.body.error);
    assert.equal((await call('POST', '/api/client-items/NEW/remove', {}, { cookie: alpha })).status, 200);
    assert.equal(store.wh.items.NEW, undefined);

    const before = JSON.stringify(store.wh);
    store.load();
    assert.deepEqual(store.replayErrors, []);
    assert.equal(JSON.stringify(store.wh), before);
    const dump = JSON.parse(JSON.stringify(store.exportBackup()));
    const restored = new Store({ site: blank });
    try {
      createAuth(restored.db);
      restored.importBackup(dump);
      assert.equal(restored.wh.items.TIN.name, 'Red tin, large');
      assert.equal(restored.wh.items.TIN.staffFlag, null);
      assert.equal(restored.wh.items.TIN.staffFlagHistory.length, 1);
      assert.equal(Object.values(restored.wh.clientRemovals).some((row) => row.status === 'done' && row.itemNo === 'TIN'), true);
      assert.equal(restored.wh.binStock['BIN-1'], undefined);
    } finally { restored.close(); }

    const off = await call('POST', '/api/setup/modules', { modules: { 'client-items': false } }, { cookie: admin });
    assert.equal(off.status, 200, off.body && off.body.error);
    assert.equal((await call('GET', '/api/client-items', null, { cookie: alpha })).status, 404);
    assert.equal((await call('POST', '/api/client-items/removals', { itemNo: 'TIN', qty: 1, kind: 'collected', reason: 'Mine' }, { cookie: alpha })).status, 403);
    assert.equal(store.wh.items.TIN.name, 'Red tin, large');
    assert.equal((await call('POST', '/api/items/TIN', { name: 'Office again' }, { cookie: office })).status, 200);
    assert.equal(store.wh.items.TIN.name, 'Office again');
    await call('POST', '/api/setup/modules', { modules: { 'client-items': true } }, { cookie: admin });
    assert.equal((await call('GET', '/api/client-items/removals', null, { cookie: alpha })).body.some((row) => row.status === 'done'), true);

    await call('POST', '/api/clients/CL-B/archive', {}, { cookie: admin });
    const owner = await call('POST', '/api/items/TIN', { description: 'Owner copy' }, { cookie: admin });
    assert.equal(owner.status, 200, owner.body && owner.body.error);
    assert.match(store.wh.events[0].text, /owner list/);
    const ownList = await call('GET', '/api/client-items', null, { cookie: alpha });
    assert.equal(ownList.body.single, true);
    assert.equal(ownList.body.items.some((i) => i.itemNo === 'HOUSE'), true);
  } finally {
    await new Promise((r) => server.close(r));
    store.close();
  }
});

test('the text terminal shows a removal as plain text and staff can finish it there', () => {
  const store = new Store({ site: blank, now: () => Date.UTC(2026, 5, 16, 10) });
  const auth = createAuth(store.db);
  auth.ensureDemoUsers();
  const stock = auth.getUser('stock');
  auth.setTerminalPin(stock.id, '1357');
  auth.updateUser(stock.id, { language: 'nl', by: 'admin' });
  store.exec('setModules', { modules: { terminal: true, 'client-items': true } }, 'admin');
  store.exec('addClient', { id: 'CL-A', name: 'Alpha' }, 'admin');
  store.exec('addItem', { itemNo: 'BOX', name: 'Box', category: 'GEN', palletQty: 1, clientId: 'CL-A' }, 'admin');
  store.exec('createLocation', { code: 'BIN-1', kind: 'bin' }, 'admin');
  store.exec('binPut', { loc: 'BIN-1', itemNo: 'BOX', qty: 4 }, 'admin');
  store.exec('requestClientRemoval', { itemNo: 'BOX', qty: 2, kind: 'collected', reason: 'Vanity', actor: { role: 'client', clientId: 'CL-A' } }, 'alpha');
  const session = createSession({ store, auth, device: 'GUN1', profile: '40x8', lang: 'en' });
  session.input('stock');
  session.input('1357');
  session.input('9');
  session.input('2');
  const text = session.screen().join('\n');
  assert.match(text, /R0001 BOX 2 collected requested Vanity/);
  assert.doesNotMatch(text, /[<>]/);
  assert.match(text, /nummer/);
  session.input('R0001');
  assert.match(session.screen().join('\n'), /started/);
  session.input('ok R0001');
  assert.match(session.screen().join('\n'), /OK/);
  assert.equal(store.wh.binStock['BIN-1'][0].qty, 2);
  assert.equal(store.wh.clientRemovals.R0001.status, 'done');
  store.load();
  assert.deepEqual(store.replayErrors, []);
  assert.equal(store.wh.clientRemovals.R0001.status, 'done');
  assert.equal(store.wh.binStock['BIN-1'][0].qty, 2);
  store.close();
});
