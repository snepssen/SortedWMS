const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Site = require('../server/site');
const { COMMANDS } = require('../server/commands');
const { createApi } = require('../server/api');
const { seedDemo } = require('./fixtures/seed');

const site = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'site.json'), 'utf8'));

function floor() {
  const t = Date.UTC(2026, 9, 9, 6);
  const wh = Site.buildWarehouse(site, () => t);
  const store = { wh, now: () => t, exec: (op, args, by) => COMMANDS[op](wh, args, by), journal: () => [] };
  seedDemo(store);
  return { wh, store, api: createApi({ store, printers: { results: [], flush() {} } }) };
}

test('customer requirements: set from the site file, changed in the office, checked for length', () => {
  const { wh } = floor();
  assert.deepEqual(wh.customerNotes('Harbour Hardware'), ['No double-stacked pallets']);
  assert.deepEqual(wh.customerNotes('Nobody'), []);
  wh.setCustomerNotes('Corner Builders', 'Wrap twice\n\nNo mixed pallets');
  assert.deepEqual(wh.customerNotes('Corner Builders'), ['Wrap twice', 'No mixed pallets']);
  wh.setCustomerNotes('Corner Builders', '');
  assert.deepEqual(wh.customerNotes('Corner Builders'), []);
  assert.throws(() => wh.setCustomerNotes('X', ['a'.repeat(81)]), /under 80 characters/);
  assert.throws(() => wh.setCustomerNotes('X', ['1', '2', '3', '4', '5', '6']), /At most 5/);
  assert.throws(() => COMMANDS.setCustomerNotes(wh, { notes: ['x'] }), /customer is required/);
});

test('customer requirements: the order brings them up on the handheld for the pick, without a lookup', async () => {
  const { wh, api } = floor();
  // Seed order 4501 is for Harbour Hardware, picked by HH01.
  const dev = (await api.handle('GET', '/api/devices/HH01')).body;
  assert.equal(dev.instruction.task.orderId, '4501');
  assert.deepEqual(dev.instruction.customer, { name: 'Harbour Hardware', notes: ['No double-stacked pallets'] });
  // Changed in the office: the next look at the handheld has it.
  await api.handle('POST', '/api/customers', { customer: 'Harbour Hardware', notes: 'No double-stacked pallets\nLabel on the long side' });
  const again = (await api.handle('GET', '/api/devices/HH01')).body;
  assert.deepEqual(again.instruction.customer.notes, ['No double-stacked pallets', 'Label on the long side']);
  assert.deepEqual((await api.handle('GET', '/api/customers')).body.find((c) => c.name === 'Harbour Hardware').notes.length, 2);
  // A job that is not for an order has none.
  const shift = Object.keys(wh.trucks).map((id) => wh.trucks[id]).find((t) => t.taskId && !wh.tasks[t.taskId].orderId);
  if (shift) assert.equal((await api.handle('GET', `/api/devices/${shift.id}`)).body.instruction.customer, undefined);
});
