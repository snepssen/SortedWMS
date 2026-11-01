// Two kinds of supplier label (made-up numbers on GS1's documentation prefix): one that needs typing, one that scans whole.
const test = require('node:test');
const assert = require('node:assert/strict');
const GS1 = require('../src/gs1');
const { Warehouse } = require('../src/engine');

const T0 = Date.UTC(2026, 9, 8, 7, 0);
const GS = GS1.GS;

function setup() {
  const wh = new Warehouse({ aisles: [31, 32], bays: 6, levels: 3, clock: () => T0, config: { groundNextPerItem: 0 } });
  wh.setFeatures({ temperatureZones: true, lotExpiry: true, fefo: true });
  // Northbank Packaging: the label counts tubes under the tube's EAN; the article number is in a (91) barcode.
  wh.addItem({ itemNo: 'S0545', name: 'Sealant 12x300 ml', category: 'GEN', palletQty: 80, unitGtin: '6141410054598', unitsPerCase: 12, codes: ['70012009'] });
  // Riverside Coatings: a full GS1 label, counted in boxes.
  wh.addItem({ itemNo: 'T0960', name: 'Tile grout 12x500 g', category: 'GEN', palletQty: 96, gtin: '06141410009604' });
  wh.applyTemplate(wh.selectLocations('31', '32'), 'GEN');
  wh.addTruck('RT1');
  return wh;
}

// ---- Reading the barcodes ------------------------------------------------------------

test('Northbank Packaging label: each of the three barcodes reads', () => {
  // Top: 13-digit EAN under (02), as printed; with and without the GS1 brackets.
  for (const top of ['026141410054598370960', '(02)6141410054598(37)0960', ']C1026141410054598370960']) {
    assert.deepEqual(GS1.parse(top), { gtin: '06141410054598', qty: 960 }, top);
  }
  assert.deepEqual(GS1.parse(']C19170012009'), { internal: '70012009' }, 'middle, with the symbology prefix');
  assert.equal(GS1.parse('9170012009'), null, 'middle without a prefix is just a number (the item list still knows it)');
  assert.deepEqual(GS1.parse('00306141410000027478'), { sscc: '306141410000027478' }, 'bottom');
});

test('Riverside Coatings label: item, count, best-before and batch in one barcode, with or without FNC1 separators', () => {
  const want = { gtin: '06141410009604', qty: 96, expiry: '2026-11-10', batch: '41/06' };
  assert.deepEqual(GS1.parse(`0206141410009604${'3796'}${GS}15261110${'1041/06'}`), want, 'with the separator');
  assert.deepEqual(GS1.parse('02061414100096043796152611101041/06'), want, 'scanner set up without the separator');
  assert.deepEqual(GS1.parse('(02)06141410009604(37)96(15)261110(10)41/06'), want, 'typed from the print');
  assert.deepEqual(GS1.parse('00006141410000009749'), { sscc: '006141410000009749' });
});

// ---- Receiving them on the handheld --------------------------------------------------

test('Northbank Packaging pallet: SSCC scanned, batch and best-before typed (they have no barcode)', () => {
  const wh = setup();
  wh.addDelivery({ id: 'D1', supplier: 'Northbank Packaging', category: 'GEN', pallets: 3 });
  assert.match(wh.scan('RT1', '00306141410000027478').text, /Next: batch/);
  assert.match(wh.scan('RT1', '810040274').text, /batch 810040274/);
  assert.match(wh.scan('RT1', '09112026').text, /expiry date 09-11-2026/, 'the typed date is read back');
  const r = wh.scan('RT1', '9170012009'); // the middle barcode: the supplier's article number
  assert.match(r.text, /Confirm the quantity/);
  wh.confirmQty('RT1');
  const p = wh.pallets['306141410000027478'];
  assert.deepEqual([p.itemNo, p.batch, p.expiry, p.qty], ['S0545', '810040274', '2026-11-09', 80]);
});

test('Northbank Packaging pallet: the top barcode gives item and count, 960 tubes = 80 cases', () => {
  const wh = setup();
  wh.addDelivery({ id: 'D1', supplier: 'Northbank Packaging', category: 'GEN', pallets: 1 });
  wh.scan('RT1', '00306141410000027478');
  wh.scan('RT1', '810040274');
  wh.scan('RT1', '091126'); // day month year on the keypad, not YYMMDD (that would be 2009)
  const r = wh.scan('RT1', '026141410054598370960');
  assert.match(r.text, /Delivery complete/);
  const p = wh.pallets['306141410000027478'];
  assert.deepEqual([p.itemNo, p.expiry, p.qty], ['S0545', '2026-11-09', 80]);
});

test('Riverside Coatings pallet: two scans, nothing typed', () => {
  const wh = setup();
  wh.addDelivery({ id: 'D1', supplier: 'Riverside Coatings', category: 'GEN', pallets: 1 });
  assert.ok(wh.scan('RT1', '02061414100096043796152611101041/06').ok);
  const r = wh.scan('RT1', '00006141410000009749');
  assert.match(r.text, /Delivery complete/);
  const p = wh.pallets['006141410000009749'];
  assert.deepEqual([p.itemNo, p.batch, p.expiry, p.qty], ['T0960', '41/06', '2026-11-10', 96]);
});

test('a count in tubes that is not whole cases is refused', () => {
  const wh = setup();
  wh.addDelivery({ id: 'D1', supplier: 'Northbank Packaging', category: 'GEN', pallets: 1 });
  const r = wh.scan('RT1', '(02)6141410054598(37)0961');
  assert.equal(r.ok, false);
  assert.match(r.text, /not whole cases of 12/);
});

test('typed dates: day-month-year on the keypad, the believable reading wins', () => {
  const wh = setup();
  wh.addDelivery({ id: 'D1', supplier: 'X', category: 'GEN', pallets: 1 });
  wh.scan('RT1', 'B1');
  assert.match(wh.scan('RT1', '261110').text, /10-11-2026/, 'a YYMMDD date-only barcode still reads');
  const wh2 = setup();
  wh2.addDelivery({ id: 'D1', supplier: 'X', category: 'GEN', pallets: 1 });
  wh2.scan('RT1', 'B1');
  assert.equal(wh2.scan('RT1', '45132026').ok, false, 'not a date');
});

test('stock check finds an item by the supplier code or the tube EAN', () => {
  const wh = setup();
  assert.equal(wh.lookup('70012009').item.itemNo, 'S0545');
  assert.equal(wh.lookup('6141410054598').item.itemNo, 'S0545');
  assert.equal(wh.lookup('06141410009604').item.itemNo, 'T0960');
});
