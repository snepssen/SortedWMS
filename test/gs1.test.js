const test = require('node:test');
const assert = require('node:assert/strict');
const GS1 = require('../src/gs1');

test('check digits', () => {
  assert.equal(GS1.checkDigit('00871234500000001'), 3);
  assert.ok(GS1.isValidSscc(GS1.makeSscc(0, '9990000', 42)));
  assert.ok(!GS1.isValidSscc('999000000000000421'));
  assert.ok(GS1.isValidGtin(GS1.makeGtin13('20000', 1001)));
});

test('reads a bracketed pallet label', () => {
  const sscc = GS1.makeSscc(0, '9990000', 7);
  const r = GS1.parse(`(00)${sscc}(02)02000001001000(15)261031(10)L2614(37)96`);
  assert.deepEqual(r, { sscc, gtin: '02000001001000', expiry: '2026-10-31', batch: 'L2614', qty: 96 });
});

test('reads the raw scanner form with FNC1 separators and a symbology prefix', () => {
  const sscc = GS1.makeSscc(0, '9990000', 8);
  const raw = `]C100${sscc}02020000010010001726103110L2614${GS1.GS}3796`;
  const r = GS1.parse(raw);
  assert.equal(r.sscc, sscc);
  assert.equal(r.expiry, '2026-10-31');
  assert.equal(r.batch, 'L2614');
  assert.equal(r.qty, 96);
});

test('plain batch numbers, dates and item numbers are not mistaken for GS1', () => {
  for (const s of ['10023', 'L2614', '261031', 'Y1001', '2000001001007', '96']) assert.equal(GS1.parse(s), null, s);
});

test('day 00 means the last day of the month', () => {
  assert.equal(GS1.yymmdd('260200'), '2026-02-28');
  assert.equal(GS1.yymmdd('261332'), null);
});
