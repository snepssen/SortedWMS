const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('the static demo offers a role picker and says it is not a signed-in warehouse', () => {
  const app = fs.readFileSync('server/public/app.html', 'utf8');
  const build = fs.readFileSync('scripts/build-pages.js', 'utf8');
  assert.match(app, /Not a signed-in warehouse/);
  assert.match(app, /data-demo/);
  assert.match(app, /SORTED_DEMO/);
  for (const role of ['administrator', 'manager', 'office', 'technician', 'operator', 'machine']) assert.match(app, new RegExp(role));
  assert.match(build, /window\.SORTED_DEMO = true/);
  assert.match(build, /app\.html/);
});
