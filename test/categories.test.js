const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Site = require('../server/site');

const blank = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'server', 'site.blank.json'), 'utf8'));

test('a blank building takes items in General straight away, and categories are added one by one', () => {
  const w = Site.buildWarehouse(blank, () => Date.UTC(2026, 10, 5, 8));
  assert.deepEqual(w.categories, { GEN: 'General' });
  w.addItem({ itemNo: 'HAMMER-1', name: 'Claw hammer', category: 'GEN', palletQty: 40, uom: 'piece' });
  assert.throws(() => w.addItem({ itemNo: 'SAW-1', name: 'Hand saw', category: 'TOOLS', palletQty: 20 }), /Unknown category TOOLS/);
  assert.deepEqual(w.addCategory({ code: ' tools ', name: 'Hand tools' }), { code: 'TOOLS', name: 'Hand tools', added: true });
  w.addItem({ itemNo: 'SAW-1', name: 'Hand saw', category: 'TOOLS', palletQty: 20 });
  assert.deepEqual(w.addCategory({ code: 'TOOLS', name: 'Tools' }), { code: 'TOOLS', name: 'Tools', added: false }, 'the same code renames it');
  assert.equal(w.items['SAW-1'].category, 'TOOLS');
  assert.throws(() => w.addCategory({ code: 'two words' }), /1 to 12 letters or digits/);
  assert.equal(w.addCategory({ code: 'A' }).name, 'A', 'a code alone is its own name');
  w.applyPreset('home-garage');
  assert.deepEqual(Object.keys(w.categories), ['GEN', 'TOOLS', 'A', 'HOME'], 'a preset adds its own beside yours');
});
