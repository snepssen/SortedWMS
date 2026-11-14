const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { document, A4 } = require('../src/pdf');
const { Store } = require('../server/store');
const { createApi } = require('../server/api');
const { deliveryNote, pickList, packingList, statement } = require('../server/documents');

const site = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'server', 'site.blank.json'), 'utf8'));

test('a hand-written PDF is A4 and keeps parentheses in the text', () => {
  const pdf = document([[
    { text: 'Delivery note (Ada)', size: 16 },
    { text: 'Line 1', size: 11 },
  ]]);
  const text = pdf.toString('latin1');
  assert.match(text, /^%PDF-1\.4/);
  assert.match(text, new RegExp(`/MediaBox \\[0 0 ${A4[0]} ${A4[1]}\\]`));
  assert.match(text, /Delivery note \\\(Ada\\\)/);
  assert.match(text, /%%EOF/);
  const length = Number(text.match(/\/Length (\d+)/)[1]);
  const start = text.indexOf('stream\n') + 'stream\n'.length;
  const stream = text.slice(start, text.indexOf('\nendstream', start));
  assert.equal(Buffer.byteLength(stream), length);
});

test('documents use the warehouse local date and a client cannot read another statement', async () => {
  const store = new Store({ site, now: () => Date.parse('2026-07-01T22:30:00Z') });
  store.exec('setConfig', { patch: { timeZone: 'Europe/Brussels', language: 'nl' } }, 'office');
  store.exec('setModules', { documents: true, billing: true, clients: true }, 'admin');
  store.exec('addClient', { id: 'CL-A', name: 'North' }, 'office');
  store.exec('addClient', { id: 'CL-B', name: 'South' }, 'office');
  store.exec('setTariff', { clientId: 'CL-A', tariff: { storageBasis: 'pallet-day', storageRate: 1, inboundBasis: 'pallet', inboundRate: 1, outboundBasis: 'order', outboundRate: 1, valBasis: 'unit', valRate: 0, monthlyMinimum: 0 } }, 'office');
  store.exec('addItem', { itemNo: 'MUG', name: 'Mug', category: 'GEN', clientId: 'CL-A', palletQty: 1 }, 'office');
  store.exec('addOrder', { id: 'SO1', customer: 'Ada (shop)', lane: 'OUT-01', clientId: 'CL-A', lines: [{ itemNo: 'MUG', units: 2 }] }, 'office');
  const note = deliveryNote(store.wh, 'SO1').toString('latin1');
  assert.match(note, /2026-07-02/);
  assert.match(note, /Leverbon/);
  assert.match(note, /Ada \\\(shop\\\)/);
  assert.match(pickList(store.wh, 'SO1').toString('latin1'), /Paklijst/);
  assert.match(packingList(store.wh, 'SO1').toString('latin1'), /Inpaklijst/);
  assert.match(packingList(store.wh, 'SO1').toString('latin1'), /Nog geen doos/);
  const bill = statement(store.wh, 'CL-A', { from: '2026-07-01', to: '2026-07-31' }).toString('latin1');
  assert.match(bill, /Rekening/);
  assert.match(bill, /2026-07-01/);
  const api = createApi({ store, printers: { flush() {} } });
  const off = new Store({ site });
  const closed = createApi({ store: off, printers: { flush() {} } });
  const denied = await closed.handle('GET', '/api/documents/delivery-note/SO1');
  assert.equal(denied.status, 404);
  const own = await api.handle('GET', '/api/documents/statement/CL-B', {}, 'client', null, { role: 'client', clientId: 'CL-A' });
  assert.equal(own.status, 403);
  const ok = await api.handle('GET', '/api/documents/delivery-note/SO1', {}, 'office', null, { role: 'office' });
  assert.equal(ok.contentType, 'application/pdf');
  assert.match(ok.body.toString('latin1'), /^%PDF-1\.4/);
  const labels = fs.readFileSync(path.join(__dirname, '..', 'src', 'labels.js'), 'utf8');
  assert.match(labels, /function shippingLabel/);
  assert.match(labels, /\^XA/);
  store.close();
  off.close();
});
