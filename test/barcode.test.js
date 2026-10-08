const test = require('node:test');
const assert = require('node:assert/strict');
const Barcode = require('../src/barcode');

test('Code 128 B: start B, data, check digit, stop', () => {
  // CMD-AUTO: values 35 45 36 13 33 53 52 47; check = (104 + Σ value × position) mod 103.
  const v = Barcode.encode('CMD-AUTO');
  assert.equal(v[0], 104);
  assert.deepEqual(v.slice(1, -2), [35, 45, 36, 13, 33, 53, 52, 47]);
  assert.equal(v.at(-2), (104 + [35, 45, 36, 13, 33, 53, 52, 47].reduce((s, x, i) => s + x * (i + 1), 0)) % 103);
  assert.equal(v.at(-1), 106);
  assert.throws(() => Barcode.encode('é'), /can't encode/);
});

test('Code 128 B: every symbol is 11 modules (stop 13), starts with a bar and ends with a space', () => {
  const m = Barcode.modules('CMD-TRANSFER');
  assert.equal(m.length, (1 + 12 + 1) * 11 + 13);
  assert.equal(m[0], '1');
  assert.equal(m.at(-1), '1', 'the stop ends on its final bar');
  assert.match(Barcode.svg('CMD-AUTO', { module: 0.4, height: 14, unit: 'mm' }), /width="[\d.]+mm" height="14mm"/);
});

// Read symbol values back the way a scanner does: GS1-128 → "]C1" prefix, inner FNC1 → GS.
function decode(values) {
  const sum = values.slice(0, -2).reduce((s, v, i) => s + v * (i || 1), 0) % 103;
  assert.equal(values.at(-2), sum, 'check digit');
  assert.equal(values.at(-1), 106);
  let set = values[0] === 105 ? 'C' : 'B';
  let out = '';
  values.slice(1, -2).forEach((v, i) => {
    if (v === 102) { out += i === 0 ? ']C1' : '\x1d'; return; }
    if (set === 'C' && v === 100) { set = 'B'; return; }
    if (set === 'B' && v === 99) { set = 'C'; return; }
    out += set === 'C' ? String(v).padStart(2, '0') : String.fromCharCode(v + 32);
  });
  return out;
}

test('GS1-128: FNC1 first, separators as FNC1, digits packed in pairs; a scanner reads back the same label', () => {
  const GS1 = require('../src/gs1');
  const label = `0204388860261127${'3796'}${Barcode.GS}15261110${'1041/06'}`;
  const v = Barcode.encode(label, { gs1: true });
  assert.equal(v[0], 105, 'starts in set C: the label is digits first');
  assert.equal(v[1], 102, 'FNC1 marks it as GS1-128');
  const read = decode(v);
  assert.equal(read, `]C1${label}`);
  assert.deepEqual(GS1.parse(read), { gtin: '04388860261127', qty: 96, expiry: '2026-11-10', batch: '41/06' });
  // An SSCC: 20 digits → 10 pairs, half the symbols of set B.
  const sscc = Barcode.encode('00054133890000100974', { gs1: true });
  assert.equal(sscc.length, 2 + 10 + 2);
  assert.equal(decode(sscc), ']C100054133890000100974');
  // Odd digit runs and letters mixed in.
  for (const t of ['9140012009', '10ABC123456', `3712345${Barcode.GS}10X`, '1012345']) assert.equal(decode(Barcode.encode(t, { gs1: true })), `]C1${t}`, t);
  assert.throws(() => Barcode.encode(`A${Barcode.GS}B`), /needs gs1/);
});
