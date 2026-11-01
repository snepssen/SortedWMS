const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test('the load test runs end to end on a small warehouse', () => {
  const out = execFileSync(process.execPath, ['--no-warnings', path.join(__dirname, '..', 'scripts', 'load-test.js'), '--scale', '0.03'], { encoding: 'utf8', timeout: 120000 });
  assert.match(out, /SortedWMS load test, scale 0\.03/);
  assert.match(out, /restart from nothing: replay all \d+ journal rows/);
  assert.match(out, /GET \/api\/stock {2}\[200,/);
  assert.doesNotMatch(out, /\[(4|5)\d\d,/, 'every API read answers');
});
