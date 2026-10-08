// The supplier labels on real pallets at the site (photos, October 2026).
const test = require('node:test');
const assert = require('node:assert/strict');
const GS1 = require('../src/gs1');
const { Warehouse } = require('../src/engine');

const T0 = Date.UTC(2026, 9, 8, 7, 0);
const GS = GS1.GS;

function setup() {
  const wh = new Warehouse({ aisles: [31, 32], bays: 6, levels: 3, clock: () => T0, config: { groundNextPerItem: 0 } });
  // A-ware Packaging: the label counts pots under the pot's EAN; the article number is in a (91) barcode.
  wh.addItem({ itemNo: '05459', name: 'Netto Gutes Land Skyr 12x500g', category: 'YOG', palletQty: 80, unitGtin: '4316268741606', unitsPerCase: 12, codes: ['40012009'] });
  // A-ware Kruibeke: a full GS1 label, counted in trays.
  wh.addItem({ itemNo: 'E0960', name: 'JA! skyr natuur 12x500g', category: 'YOG', palletQty: 96, gtin: '04388860261127' });
  wh.applyTemplate(wh.selectLocations('31', '32'), 'YOG');
  wh.addTruck('RT1');
  return wh;
}

// ---- Reading the barcodes ------------------------------------------------------------

test('A-ware Packaging label: each of the three barcodes reads', () => {
  // Top: 13-digit EAN under (02), as printed; with and without the GS1 brackets.
  for (const top of ['024316268741606370960', '(02)4316268741606(37)0960', ']C1024316268741606370960']) {
    assert.deepEqual(GS1.parse(top), { gtin: '04316268741606', qty: 960 }, top);
  }
  assert.deepEqual(GS1.parse(']C19140012009'), { internal: '40012009' }, 'middle, with the symbology prefix');
  assert.equal(GS1.parse('9140012009'), null, 'middle without a prefix is just a number (the item list still knows it)');
  assert.deepEqual(GS1.parse('00354111938100402747'), { sscc: '354111938100402747' }, 'bottom');
});

test('A-ware Kruibeke label: item, count, best-before and batch in one barcode, with or without FNC1 separators', () => {
  const want = { gtin: '04388860261127', qty: 96, expiry: '2026-11-10', batch: '41/06' };
  assert.deepEqual(GS1.parse(`0204388860261127${'3796'}${GS}15261110${'1041/06'}`), want, 'with the separator');
  assert.deepEqual(GS1.parse('02043888602611273796152611101041/06'), want, 'scanner set up without the separator');
  assert.deepEqual(GS1.parse('(02)04388860261127(37)96(15)261110(10)41/06'), want, 'typed from the print');
  assert.deepEqual(GS1.parse('00054133890000100974'), { sscc: '054133890000100974' });
});

// ---- Receiving them on the handheld --------------------------------------------------

test('A-ware Packaging pallet: SSCC scanned, batch and best-before typed (they have no barcode)', () => {
  const wh = setup();
  wh.addDelivery({ id: 'D1', supplier: 'A-ware Packaging', category: 'YOG', pallets: 3 });
  assert.match(wh.scan('RT1', '00354111938100402747').text, /Next: batch/);
  assert.match(wh.scan('RT1', '810040274').text, /batch 810040274/);
  assert.match(wh.scan('RT1', '09112026').text, /expiry date 09-11-2026/, 'the typed date is read back');
  const r = wh.scan('RT1', '9140012009'); // the middle barcode: the supplier's article number
  assert.match(r.text, /Confirm the quantity/);
  wh.confirmQty('RT1');
  const p = wh.pallets['354111938100402747'];
  assert.deepEqual([p.itemNo, p.batch, p.expiry, p.qty], ['05459', '810040274', '2026-11-09', 80]);
});

test('A-ware Packaging pallet: the top barcode gives item and count, 960 pots = 80 cases', () => {
  const wh = setup();
  wh.addDelivery({ id: 'D1', supplier: 'A-ware Packaging', category: 'YOG', pallets: 1 });
  wh.scan('RT1', '00354111938100402747');
  wh.scan('RT1', '810040274');
  wh.scan('RT1', '091126'); // day month year on the keypad, not YYMMDD (that would be 2009)
  const r = wh.scan('RT1', '024316268741606370960');
  assert.match(r.text, /Delivery complete/);
  const p = wh.pallets['354111938100402747'];
  assert.deepEqual([p.itemNo, p.expiry, p.qty], ['05459', '2026-11-09', 80]);
});

test('A-ware Kruibeke pallet: two scans, nothing typed', () => {
  const wh = setup();
  wh.addDelivery({ id: 'D1', supplier: 'A-ware Kruibeke', category: 'YOG', pallets: 1 });
  assert.ok(wh.scan('RT1', '02043888602611273796152611101041/06').ok);
  const r = wh.scan('RT1', '00054133890000100974');
  assert.match(r.text, /Delivery complete/);
  const p = wh.pallets['054133890000100974'];
  assert.deepEqual([p.itemNo, p.batch, p.expiry, p.qty], ['E0960', '41/06', '2026-11-10', 96]);
});

test('a count in pots that is not whole cases is refused', () => {
  const wh = setup();
  wh.addDelivery({ id: 'D1', supplier: 'A-ware Packaging', category: 'YOG', pallets: 1 });
  const r = wh.scan('RT1', '(02)4316268741606(37)0961');
  assert.equal(r.ok, false);
  assert.match(r.text, /not whole cases of 12/);
});

test('typed dates: day-month-year on the keypad, the believable reading wins', () => {
  const wh = setup();
  wh.addDelivery({ id: 'D1', supplier: 'X', category: 'YOG', pallets: 1 });
  wh.scan('RT1', 'B1');
  assert.match(wh.scan('RT1', '261110').text, /10-11-2026/, 'a YYMMDD date-only barcode still reads');
  const wh2 = setup();
  wh2.addDelivery({ id: 'D1', supplier: 'X', category: 'YOG', pallets: 1 });
  wh2.scan('RT1', 'B1');
  assert.equal(wh2.scan('RT1', '45132026').ok, false, 'not a date');
});

test('stock check finds an item by the supplier code or the pot EAN', () => {
  const wh = setup();
  assert.equal(wh.lookup('40012009').item.itemNo, '05459');
  assert.equal(wh.lookup('4316268741606').item.itemNo, '05459');
  assert.equal(wh.lookup('04388860261127').item.itemNo, 'E0960');
});
