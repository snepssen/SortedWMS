const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { Warehouse } = require('../src/engine');
const { LAYOUTS } = require('../src/sheets');
const { Store } = require('../server/store');
const { Printers } = require('../server/print');
const { createServer } = require('../server/index');
const { createAuth } = require('../server/auth');

function wh() {
  const w = new Warehouse({ aisles: [1], bays: 2, levels: 2, positions: [10], outLanes: 1, clock: () => Date.UTC(2026, 9, 8, 8) });
  w.addItem({ itemNo: 'M3', name: 'M3 screw', category: 'YOG', palletQty: 1, uom: 'piece' });
  w.setItemUnits('M3', { packs: [{ unit: 'box', per: 100, barcode: '8710000003' }] });
  w.generateGuided({ sections: { count: 1, name: 'Garage' }, layouts: [{ type: 'shelf', bays: { count: 2, name: 'Shelf 1' }, positions: { count: 3, name: 'Bin 1' } }] });
  return w;
}
const count = (html, re) => (html.match(re) || []).length;

test('location labels for every bin under a prefix, on an A4 sheet that skips used stickers', () => {
  const w = wh();
  const html = w.labelSheet({ prefix: 'garage-shelf1', layout: 'a4-21', skip: 4 });
  assert.equal(count(html, /class="label"/g), 3);
  assert.equal(count(html, /class="label empty"/g), 4);
  assert.equal(count(html, /<svg/g), 3, 'each label has its barcode');
  assert.match(html, /Garage-Shelf1-Bin1/);
  assert.match(html, /@page \{ size: 210mm 297mm; margin: 0; \}/);
  assert.match(html, /grid-template-columns: repeat\(3, 63.5mm\)/);
  const many = w.labelSheet({ prefix: 'Garage', layout: 'a4-8' });
  assert.equal(count(many, /class="page"/g), 1);
  assert.equal(count(w.labelSheet({ prefix: 'Garage', layout: 'a4-8', skip: 3 }), /class="page"/g), 2, 'a part sheet runs onto a second page');
});

test('rack labels carry their check digits; a roll prints one label a page', () => {
  const w = wh();
  const html = w.labelSheet({ codes: '01-01-1-10, 01-02-1-10', layout: 'roll-62x29' });
  assert.equal(count(html, /class="corner"/g), 2);
  assert.match(html, new RegExp(`class="corner">${w.checkDigit('01-01-1-10')}<`));
  assert.equal(count(html, /class="page"/g), 2);
  assert.match(html, /@page \{ size: 62mm 29mm; margin: 0; \}/);
  assert.throws(() => w.labelSheet({ codes: 'NOWHERE' }), /NOWHERE/);
  assert.throws(() => w.labelSheet({ prefix: 'Garage', layout: 'a3-99' }), /Layout is one of/);
  assert.ok(Object.keys(LAYOUTS).includes('letter-30'));
});

test('item labels include each box barcode; plate labels use the plate number', () => {
  const w = wh();
  const items = w.labelSheet({ kind: 'items', items: 'M3', layout: 'a4-14' });
  assert.equal(count(items, /class="label"/g), 2);
  assert.match(items, /M3 box/);
  const { holder } = w.issueSeries({ series: 'ST', itemNo: 'M3', qty: 5, loc: 'Garage-Shelf1-Bin1' });
  const plates = w.labelSheet({ kind: 'plates', ids: holder.id, layout: 'roll-57x32' });
  assert.match(plates, new RegExp(holder.id));
  assert.throws(() => w.labelSheet({ kind: 'pets' }), /Kind is locations, items or plates/);
});

test('the sheet is served to anyone who prints labels, and the camera button only appears where the browser reads barcodes', async () => {
  const site = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'server', 'site.example.json'), 'utf8'));
  const store = new Store({ site });
  const auth = createAuth(store.db);
  auth.ensureDemoUsers();
  const server = createServer({ store, printers: new Printers({}), auth });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = async (username, password) => (await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) })).headers.get('set-cookie').split(';')[0];
  try {
    const picker = await login('picker', 'sorted-picker');
    const res = await fetch(base + '/api/labels/sheet?prefix=STAGE&layout=a4-21', { headers: { cookie: picker } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.match(await res.text(), /STAGE01/);
    const cam = await fetch(base + '/camera.js');
    assert.equal(cam.status, 200);
    for (const page of ['/app', '/handheld']) assert.match(await (await fetch(base + page)).text(), /<script src="camera.js"><\/script>/);
  } finally {
    await new Promise((r) => server.close(r));
    store.close();
  }
  // Without BarcodeDetector the script leaves the page alone.
  const touched = [];
  const window = { navigator: {}, document: { createElement: () => touched.push('element') } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'server', 'public', 'camera.js'), 'utf8'), { window, navigator: {}, document: window.document });
  assert.deepEqual(touched, []);
});
