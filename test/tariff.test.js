const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Warehouse } = require('../src/engine');
const { Store } = require('../server/store');
const { createAuth } = require('../server/auth');
const { createServer } = require('../server/index');
const { Printers } = require('../server/print');
const { permissionFor, DEFAULTS } = require('../server/permissions');

const site = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'server', 'site.example.json'), 'utf8'));

function whAt(t) {
  let now = t;
  const w = new Warehouse({ aisles: [1], bays: 2, levels: 1, positions: [10], outLanes: 1, clock: () => now, config: { timeZone: 'UTC', country: 'BE' } });
  w.setFeatures({ lotExpiry: true, fefo: true });
  w.addClient({ id: 'CL-1', name: 'North Shop' });
  w.addItem({ itemNo: 'SKU1', name: 'Mug', category: 'YOG', palletQty: 10, clientId: 'CL-1' });
  w.at = (n) => { now = n; };
  return w;
}

function storageLines(inv) {
  return inv.lines.filter((l) => l.code === 'storage');
}

test('tier boundaries: the top of a band is included, and all-units differs from graduated', () => {
  const w = whAt(Date.UTC(2026, 9, 20));
  const tiers = [{ upTo: 10, rate: 3 }, { upTo: null, rate: 1 }];
  const base = { storageBasis: 'pallet-day', storageRate: 0, inboundRate: 0, outboundRate: 0, valRate: 0, minimum: 50, storageTierMode: 'all', storageTiers: tiers };
  w.setTariff('CL-1', base);
  const pallet = w.stockPallet('01-01-0-10', { itemNo: 'SKU1', batch: 'B', expiry: '2027-01-01', qty: 10, clientId: 'CL-1', receivedAt: Date.UTC(2026, 9, 1) });
  const ten = w.invoice({ clientId: 'CL-1', from: '2026-10-01', to: '2026-10-10' });
  assert.equal(ten.palletDays, 10);
  assert.equal(storageLines(ten)[0].qty, 10);
  assert.equal(storageLines(ten)[0].rate, 3);
  assert.equal(storageLines(ten)[0].amount, 30);
  assert.match(storageLines(ten)[0].tier, /all units up to 10 at 3/);
  assert.equal(ten.subtotal, 30);
  assert.equal(ten.minimum, 50);
  assert.equal(ten.total, 50);

  w.setTariff('CL-1', { ...base, minimum: 0 });
  const stillTen = w.invoice({ clientId: 'CL-1', from: '2026-10-01', to: '2026-10-10' });
  assert.equal(stillTen.total, 30);
  const eleven = w.invoice({ clientId: 'CL-1', from: '2026-10-01', to: '2026-10-11' });
  assert.equal(eleven.palletDays, 11);
  assert.equal(storageLines(eleven)[0].rate, 1);
  assert.equal(storageLines(eleven)[0].amount, 11);
  assert.match(storageLines(eleven)[0].tier, /all units above 10 at 1/);

  w.setTariff('CL-1', { ...base, minimum: 0, storageTierMode: 'graduated' });
  const banded = w.invoice({ clientId: 'CL-1', from: '2026-10-01', to: '2026-10-11' });
  const parts = storageLines(banded);
  assert.equal(parts[0].qty, 10);
  assert.equal(parts[0].amount, 30);
  assert.match(parts[0].tier, /band up to 10 at 3/);
  assert.equal(parts[1].qty, 1);
  assert.equal(parts[1].amount, 1);
  assert.match(parts[1].tier, /band above 10 at 1/);
  assert.equal(banded.total, 31);
  assert.notEqual(banded.total, eleven.total);
  assert.equal(pallet.clientId, 'CL-1');
});

test('a season that straddles the period is prorated, and overlapping seasons are refused', () => {
  const w = whAt(Date.UTC(2026, 9, 20));
  const tiers = [{ upTo: 15, rate: 2 }, { upTo: null, rate: 1 }];
  const card = {
    storageBasis: 'pallet-day', storageRate: 0, storageTierMode: 'graduated', storageTiers: tiers, tierScope: 'version',
    inboundRate: 0, outboundRate: 0, valRate: 0, minimum: 0,
  };
  w.setTariff('CL-1', {
    ...card,
    seasons: [
      { label: 'Peak storage', from: '2026-10-01', to: '2026-10-31', charge: 'storage', effect: 'surcharge', percent: 10 },
      { label: 'Peak inbound', from: '2026-10-01', to: '2026-10-31', charge: 'inbound', effect: 'override', rate: 8 },
    ],
  });
  assert.equal(w.clients['CL-1'].tariffVersions[0].seasons.length, 2);
  assert.throws(() => w.setTariff('CL-1', {
    ...card,
    seasons: [
      { label: 'Early', from: '2026-10-01', to: '2026-10-10', charge: 'storage', effect: 'override', rate: 5 },
      { label: 'Overlap', from: '2026-10-10', to: '2026-10-12', charge: 'storage', effect: 'override', rate: 6 },
    ],
  }), /same days/);
  assert.throws(() => w.setTariff('CL-1', {
    ...card,
    seasons: [
      { label: 'Q4', months: [10, 11], charge: 'storage', effect: 'surcharge', percent: 10 },
      { label: 'November', months: [11, 12], charge: 'storage', effect: 'surcharge', percent: 5 },
    ],
  }), /same days/);
  assert.throws(() => w.setTariff('CL-1', {
    ...card,
    seasons: [
      { label: 'October', months: [10], charge: 'storage', effect: 'surcharge', percent: 10 },
      { label: 'Opening week', from: '2026-10-01', to: '2026-10-05', charge: 'storage', effect: 'override', rate: 9 },
    ],
  }), /same days/);
  assert.equal(w.clients['CL-1'].tariffVersions[0].seasons.length, 2);

  w.setTariff('CL-1', {
    ...card,
    seasons: [
      { label: 'Early', from: '2026-10-01', to: '2026-10-10', charge: 'storage', effect: 'surcharge', percent: 50 },
      { label: 'Later', from: '2026-10-11', to: '2026-10-20', charge: 'storage', effect: 'surcharge', percent: 50 },
    ],
  });
  w.setTariff('CL-1', {
    ...card,
    seasons: [{ label: 'Q4 peak', from: '2026-10-01', to: '2026-10-31', charge: 'storage', effect: 'surcharge', percent: 50 }],
  });
  w.stockPallet('01-01-0-10', { itemNo: 'SKU1', batch: 'B', expiry: '2027-01-01', qty: 10, clientId: 'CL-1', receivedAt: Date.UTC(2026, 8, 20) });
  const inv = w.invoice({ clientId: 'CL-1', from: '2026-09-20', to: '2026-10-10' });
  const parts = storageLines(inv);
  assert.equal(inv.palletDays, 21);
  assert.equal(parts.reduce((s, l) => s + l.qty, 0), 21);
  assert.deepEqual(parts.map((l) => l.qty), [11, 4, 6]);
  assert.deepEqual(parts.map((l) => l.amount), [22, 12, 9]);
  assert.equal(parts[0].season, '');
  assert.match(parts[1].season, /Q4 peak \+50%/);
  assert.match(parts[2].season, /Q4 peak \+50%/);
  assert.match(parts[1].tier, /band up to 15 at 2/);
  assert.match(parts[2].tier, /band above 15 at 1/);
  assert.equal(parts[1].rate, 3);
  assert.equal(parts[2].rate, 1.5);
  assert.ok(parts.every((l) => l.version === 'v1'));
  assert.equal(inv.total, 43);

  w.setTariff('CL-1', {
    ...card,
    seasons: [{ label: 'Q4 peak', from: '2026-10-01', to: '2026-10-31', charge: 'storage', effect: 'override', rate: 4 }],
  });
  const replaced = storageLines(w.invoice({ clientId: 'CL-1', from: '2026-09-20', to: '2026-10-10' }));
  assert.equal(replaced[0].amount, 22);
  assert.equal(replaced[1].rate, 4);
  assert.equal(replaced[1].amount, 16);
  assert.equal(replaced[2].amount, 24);
  assert.match(replaced[1].season, /override 4/);

  const html = w.invoiceHtml({ clientId: 'CL-1', from: '2026-09-20', to: '2026-10-10' });
  const csv = w.invoiceCsv({ clientId: 'CL-1', from: '2026-09-20', to: '2026-10-10' });
  assert.match(html, /<th>Tier<\/th><th>Season<\/th><th>Version<\/th>/);
  assert.match(html, /Q4 peak override 4/);
  assert.match(html, />v1</);
  assert.match(csv, /band up to 15 at 2/);
  assert.match(csv, /Q4 peak override 4/);
  assert.match(csv.split('\n')[0], /"tier","season","version"/);
});

test('a recurring month applies again the next year and a quiet month does not', () => {
  const w = whAt(Date.UTC(2027, 9, 3));
  w.setTariff('CL-1', {
    storageBasis: 'pallet-day', storageRate: 2, inboundRate: 0, outboundRate: 0, valRate: 0, minimum: 0,
    seasons: [{ label: 'October', months: [10], charge: 'storage', effect: 'surcharge', percent: 100 }],
  });
  w.stockPallet('01-01-0-10', { itemNo: 'SKU1', batch: 'B', expiry: '2028-01-01', qty: 10, clientId: 'CL-1', receivedAt: Date.UTC(2027, 8, 2) });
  const quiet = w.invoice({ clientId: 'CL-1', from: '2027-09-02', to: '2027-09-02' });
  const peak = w.invoice({ clientId: 'CL-1', from: '2027-10-02', to: '2027-10-02' });
  assert.equal(storageLines(quiet)[0].qty, 1);
  assert.equal(storageLines(quiet)[0].amount, 2);
  assert.equal(storageLines(quiet)[0].season, '');
  assert.equal(storageLines(peak)[0].qty, 1);
  assert.equal(storageLines(peak)[0].amount, 4);
  assert.match(storageLines(peak)[0].season, /October \+100%/);
});

test('a version change mid-period prices each side on its own card, and the closing card supplies the minimum', () => {
  const w = whAt(Date.UTC(2026, 8, 20));
  w.setTariff('CL-1', {
    effectiveFrom: '2026-09-01', storageBasis: 'pallet-day', storageRate: 2,
    inboundRate: 0, outboundRate: 0, valRate: 4, minimum: 10,
  }, 'mina');
  w.at(Date.UTC(2026, 9, 20));
  w.setTariff('CL-1', {
    effectiveFrom: '2026-10-01', storageBasis: 'pallet-day', storageRate: 5,
    inboundRate: 0, outboundRate: 0, valRate: 9, minimum: 100,
  }, 'mina');
  const pallet = w.stockPallet('01-01-0-10', { itemNo: 'SKU1', batch: 'B', expiry: '2027-01-01', qty: 10, clientId: 'CL-1', receivedAt: Date.UTC(2026, 8, 20) });
  w.at(Date.UTC(2026, 8, 25));
  w.recordMovement({ sscc: pallet.sscc, from: '01-01-0-10', to: '01-01-0-10', qty: 1, event: 'kitted', by: 'omar' });
  w.at(Date.UTC(2026, 9, 5));
  w.recordMovement({ sscc: pallet.sscc, from: '01-01-0-10', to: '01-01-0-10', qty: 1, event: 'kitted', by: 'omar' });
  w.at(Date.UTC(2026, 9, 20));
  const inv = w.invoice({ clientId: 'CL-1', from: '2026-09-20', to: '2026-10-10' });
  const stored = storageLines(inv);
  assert.deepEqual(stored.map((l) => [l.version, l.qty, l.amount]), [
    ['v1 2026-09-01', 11, 22],
    ['v2 2026-10-01', 10, 50],
  ]);
  const val = inv.lines.filter((l) => l.code === 'val' && l.qty);
  assert.deepEqual(val.map((l) => [l.version, l.amount]), [
    ['v1 2026-09-01', 4],
    ['v2 2026-10-01', 9],
  ]);
  assert.equal(inv.subtotal, 85);
  assert.equal(inv.minimum, 100);
  assert.equal(inv.minimumVersion, 'v2 2026-10-01');
  assert.equal(inv.total, 100);
  assert.equal(stored.reduce((s, l) => s + l.qty, 0), inv.palletDays);

  assert.throws(() => w.setTariff('CL-1', { versionId: 'v1', effectiveFrom: '2026-09-01', storageRate: 9 }), /v1 is read-only/);
  assert.throws(() => w.setTariff('CL-1', { versionId: 'v2', effectiveFrom: '2026-10-01', storageRate: 9 }), /v2 is read-only/);
  assert.equal(w.clients['CL-1'].tariffVersions[0].storageRate, 2);
  w.setTariff('CL-1', { effectiveFrom: '2026-10-21', storageBasis: 'pallet-day', storageRate: 8, valRate: 1, minimum: 1 });
  const again = w.invoice({ clientId: 'CL-1', from: '2026-09-20', to: '2026-10-10' });
  assert.equal(again.total, 100);
  assert.equal(again.subtotal, 85);
  assert.match(w.events[0].text, /saved by/);
});

test('tariff changes are journaled with the user, and an old version cannot be rewritten', () => {
  const store = new Store({ site });
  try {
    store.exec('addClient', { id: 'CL-T', name: 'Tariff Co' }, 'office');
    store.exec('setTariff', { clientId: 'CL-T', tariff: { storageRate: 2, effectiveFrom: '2020-01-01', minimum: 5 } }, 'mina');
    store.exec('setTariff', { clientId: 'CL-T', tariff: { storageRate: 4, effectiveFrom: '2020-06-01', minimum: 9 } }, 'mina');
    assert.match(store.wh.events[0].text, /CL-T v2 \(2020-06-01\) saved by mina/);
    assert.ok(store.journal({ op: 'setTariff' }).every((r) => r.by === 'mina'));
    store.load();
    assert.equal(store.wh.clients['CL-T'].tariffVersions[0].storageRate, 2);
    assert.match(store.wh.events[0].text, /saved by mina/);
    const before = store.journal().length;
    assert.throws(() => store.exec('setTariff', { clientId: 'CL-T', tariff: { versionId: 'v1', effectiveFrom: '2020-01-01', storageRate: 9 } }, 'mina'), /read-only/);
    assert.equal(store.journal().length, before);
    assert.equal(store.wh.clients['CL-T'].tariffVersions[0].storageRate, 2);
  } finally {
    store.close();
  }
});

test('billing days follow the warehouse timezone, including a short and a long DST day', () => {
  const spring = new Warehouse({ aisles: [1], bays: 1, levels: 1, positions: [10], outLanes: 1, config: { timeZone: 'Europe/Brussels', country: 'BE' }, clock: () => Date.UTC(2026, 3, 1, 12) });
  spring.addClient({ id: 'CL-1', name: 'North Shop' });
  spring.addItem({ itemNo: 'SKU1', name: 'Mug', category: 'YOG', palletQty: 10, clientId: 'CL-1' });
  const start = spring.zonedMidnight('2026-03-29');
  const next = spring.zonedMidnight('2026-03-30');
  assert.equal(next - start, 23 * 3600000);
  spring.setTariff('CL-1', { storageBasis: 'pallet-day', storageRate: 24, inboundRate: 0, outboundRate: 0, valRate: 0, minimum: 0 });
  spring.stockPallet('01-01-0-10', { itemNo: 'SKU1', batch: 'B', expiry: '2027-01-01', qty: 10, clientId: 'CL-1', receivedAt: start });
  const short = spring.invoice({ clientId: 'CL-1', from: '2026-03-29', to: '2026-03-29' });
  assert.equal(short.palletDays, 0.96);

  const autumn = new Warehouse({ aisles: [1], bays: 1, levels: 1, positions: [10], outLanes: 1, config: { timeZone: 'Europe/Brussels', country: 'BE' }, clock: () => Date.UTC(2026, 9, 26, 12) });
  assert.equal(autumn.zonedMidnight('2026-10-26') - autumn.zonedMidnight('2026-10-25'), 25 * 3600000);
  const ny = new Warehouse({ config: { timeZone: 'America/New_York', country: 'US' }, clock: () => Date.UTC(2026, 2, 9, 12) });
  assert.equal(ny.zonedMidnight('2026-03-09') - ny.zonedMidnight('2026-03-08'), 23 * 3600000);

  spring.setTariff('CL-1', { effectiveFrom: '2026-03-30', storageBasis: 'pallet-day', storageRate: 48, inboundRate: 0, outboundRate: 0, valRate: 0, minimum: 0 });
  const split = spring.invoice({ clientId: 'CL-1', from: '2026-03-29', to: '2026-03-30' });
  const parts = split.lines.filter((l) => l.code === 'storage');
  assert.equal(parts[0].version, 'v1');
  assert.equal(parts[1].version, 'v2 2026-03-30');
  assert.equal(parts[0].qty, 0.96);
  assert.equal(parts[1].qty, 1);
});

test('a rate card chooses minimum proration, a fixed surcharge, and whether tiers reset each month', () => {
  const w = whAt(Date.UTC(2026, 9, 20));
  w.setTariff('CL-1', {
    storageBasis: 'pallet-day', storageRate: 2, inboundRate: 0, outboundRate: 0, valRate: 0,
    minimum: 310, minimumMode: 'prorate', tierScope: 'month',
    seasons: [{ label: 'Peak', months: [10], charge: 'storage', effect: 'each', amount: 0.5 }],
  });
  w.stockPallet('01-01-0-10', { itemNo: 'SKU1', batch: 'B', expiry: '2027-01-01', qty: 10, clientId: 'CL-1', receivedAt: Date.UTC(2026, 9, 1) });
  const ten = w.invoice({ clientId: 'CL-1', from: '2026-10-01', to: '2026-10-10' });
  assert.equal(storageLines(ten)[0].qty, 10);
  assert.equal(storageLines(ten)[0].rate, 2.5);
  assert.match(storageLines(ten)[0].season, /\+0\.5 each/);
  assert.equal(ten.minimum, 100);
  assert.equal(ten.subtotal, 25);
  assert.equal(ten.total, 100);

  w.setTariff('CL-1', {
    storageBasis: 'pallet-day', storageRate: 0, storageTierMode: 'graduated', tierScope: 'month',
    storageTiers: [{ upTo: 15, rate: 2 }, { upTo: null, rate: 1 }],
    inboundRate: 0, outboundRate: 0, valRate: 0, minimum: 0, minimumMode: 'full',
  });
  const pallet = w.pallets[Object.keys(w.pallets)[0]];
  pallet.receivedAt = Date.UTC(2026, 8, 20);
  const month = w.invoice({ clientId: 'CL-1', from: '2026-09-20', to: '2026-10-10' });
  const parts = storageLines(month);
  assert.deepEqual(parts.map((l) => l.amount), [22, 20]);
  w.setSpaces('CL-1', [{ scope: 'cell', cell: 'A', fee: 80 }], 'mina');
  const withSpace = w.invoice({ clientId: 'CL-1', from: '2026-09-20', to: '2026-10-10' });
  const space = withSpace.lines.find((l) => l.code === 'space');
  assert.equal(space.amount, 80);
  assert.match(space.label, /cell A/);
  assert.equal(withSpace.subtotal, 122);
  assert.throws(() => w.setSpaces('CL-1', [{ scope: 'cell', cell: 'Z', fee: 1 }]), /No cell/);
});

test('tariff editing is tariff.write for office and manager', async () => {
  assert.equal(permissionFor('POST', '/api/clients/CL-1/tariff').permission, 'tariff.write');
  assert.equal(permissionFor('GET', '/api/reports/invoice').permission, 'reports.read');
  assert.equal(permissionFor('GET', '/api/reports/invoice.csv').permission, 'reports.read');
  assert.equal(DEFAULTS.office.includes('tariff.write'), true);
  assert.equal(DEFAULTS.manager.includes('tariff.write'), true);
  assert.equal(DEFAULTS.operator.includes('tariff.write'), false);
  assert.equal(DEFAULTS.technician.includes('tariff.write'), false);
  assert.equal(DEFAULTS.machine.includes('tariff.write'), false);

  const store = new Store({ site });
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
  const sign = async (username, password) => {
    const res = await call('POST', '/api/login', { username, password });
    assert.equal(res.status, 200, res.body && res.body.error);
    return ((res.headers.getSetCookie && res.headers.getSetCookie()[0]) || res.headers.get('set-cookie') || '').split(';')[0];
  };
  try {
    const operator = await sign('operator', 'sorted-operator');
    assert.equal((await call('POST', '/api/clients/CL-DAIRY/tariff', { storageRate: 1 }, { cookie: operator })).status, 403);
    const office = await sign('office', 'sorted-office');
    const saved = await call('POST', '/api/clients/CL-DAIRY/tariff', {
      storageBasis: 'pallet-day', storageRate: 1.5, storageTierMode: 'all',
      storageTiers: [{ upTo: 10, rate: 2 }, { upTo: null, rate: 1 }],
      inboundRate: 2, outboundRate: 3, valRate: 0.4, minimum: 40,
      seasons: [{ label: 'Q4 peak', months: [10, 11, 12], charge: 'storage', effect: 'surcharge', percent: 25 }],
    }, { cookie: office });
    assert.equal(saved.status, 200, saved.body && saved.body.error);
    assert.equal(saved.body[0].id, 'v1');
    assert.equal(saved.body[0].readOnly, false);
    assert.equal(saved.body[0].storageTierMode, 'all');
    const tomorrow = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
    const manager = await sign('manager', 'sorted-manager');
    const next = await call('POST', '/api/clients/CL-DAIRY/tariff', {
      effectiveFrom: tomorrow, storageBasis: 'pallet-day', storageRate: 2, minimum: 80,
    }, { cookie: manager });
    assert.equal(next.status, 200, next.body && next.body.error);
    assert.equal(next.body[0].readOnly, true);
    assert.equal(next.body[1].readOnly, false);
    assert.equal(next.body[1].createdBy, 'manager');
    const csv = await call('GET', '/api/reports/invoice.csv?clientId=CL-DAIRY&from=2026-10-01&to=2026-10-15', null, { cookie: office });
    assert.equal(csv.status, 200);
    assert.match(csv.body, /tier","season","version"/);
    const html = await call('GET', '/api/reports/billing.html?clientId=CL-DAIRY&from=2026-10-01&to=2026-10-15', null, { cookie: manager });
    assert.match(html.body, /Tier/);
    assert.match(html.body, /Season/);
    assert.match(html.body, /Version/);
    assert.ok(store.journal({ op: 'setTariff' }).some((r) => r.by === 'office'));
    assert.ok(store.journal({ op: 'setTariff' }).some((r) => r.by === 'manager'));
  } finally {
    await new Promise((r) => server.close(r));
    store.close();
  }
});
