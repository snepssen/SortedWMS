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
