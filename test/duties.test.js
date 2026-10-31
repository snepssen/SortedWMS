const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { Warehouse } = require('../src/engine');
const { createAuth } = require('../server/auth');
const { DEFAULTS, ROLE_IDS } = require('../server/permissions');
const GS1 = require('../src/gs1');

const sscc = (n) => { const body = String(n).padStart(17, '0'); return body + GS1.checkDigit(body); };

function wh() {
  const w = new Warehouse({ aisles: [1], bays: 2, levels: 2, positions: [10], outLanes: 1, clock: () => Date.UTC(2026, 9, 8, 8) });
  w.addItem({ itemNo: 'Y1', name: 'Yoghurt', category: 'YOG', palletQty: 10 });
  return w;
}

test('each duty only takes its own jobs', () => {
  const w = wh();
  const pick = { type: 'PICK', orderId: 'O1' };
  const put = { type: 'PUTAWAY' };
  const shift = { type: 'SHIFT' };
  const count = { type: 'COUNT' };
  const toOrder = { type: 'MOVE', orderId: 'O1' };
  const toStore = { type: 'MOVE', orderId: null };
  const takes = (duty) => [pick, put, shift, count, toOrder, toStore].map((t) => w._dutyAllows({ duty }, t));
  assert.deepEqual(takes(null), [true, true, true, true, true, true]);
  assert.deepEqual(takes('inbound'), [false, true, false, false, false, false]);
  assert.deepEqual(takes('picking'), [true, false, false, false, true, false]);
  assert.deepEqual(takes('inventory'), [false, false, true, true, false, true]);
});

test('an EPT stays on the ground and a cart takes no truck jobs', () => {
  const w = wh();
  const ground = { type: 'PICK', from: '01-01-0-10', to: 'OUT-01' };
  const high = { type: 'PICK', from: '01-01-1-10', to: 'OUT-01' };
  assert.equal(w._dutyAllows({ equipment: 'ept' }, ground), true);
  assert.equal(w._dutyAllows({ equipment: 'ept' }, high), false);
  assert.equal(w._dutyAllows({ equipment: 'reach' }, high), true);
  assert.equal(w._dutyAllows({ equipment: 'manup' }, high), true);
  assert.equal(w._dutyAllows({ equipment: 'cart' }, ground), false);
  assert.throws(() => w.addTruck('T1') && w.setTruckEquipment('T1', 'forklift'), /Equipment is one of reach, manup, ept, cart/);
});

test('dispatch gives an inbound truck the put-away and the picker the pick', () => {
  const w = wh();
  w.addTruck('IN1', { position: 'DOCK-IN' });
  w.addTruck('PK1', { position: 'DOCK-IN' });
  w.setTruckDuty('IN1', 'inbound');
  w.assignOperator('PK1', 'pat', 'picking');
  assert.equal(w.trucks.PK1.duty, 'picking');
  w.stockPallet('01-01-0-10', { sscc: sscc(1), itemNo: 'Y1', qty: 10, receivedAt: 1 });
  w.addOrder({ id: 'O1', customer: 'Shop', lane: 'OUT-01', lines: [{ itemNo: 'Y1', pallets: 1 }] });
  w.dispatch();
  const job = (id) => w.trucks[id].taskId && w.tasks[w.trucks[id].taskId].type;
  assert.equal(job('PK1'), 'PICK');
  assert.equal(job('IN1') === 'PICK', false, 'the inbound truck does not pick');
  assert.throws(() => w.setTruckDuty('PK1', 'driving'), /Duty is one of inbound, picking, inventory/);
});

test('stock control creates and deletes stock with a reason, and billing stops when it is gone', () => {
  let now = Date.UTC(2026, 9, 1);
  const w = new Warehouse({ aisles: [1], bays: 2, levels: 1, positions: [10], outLanes: 1, clock: () => now });
  w.addClient({ id: 'CL1', name: 'Client' });
  w.addItem({ itemNo: 'Y1', name: 'Yoghurt', category: 'YOG', palletQty: 10, clientId: 'CL1' });
  const p = w.createStock({ code: '01-01-0-10', itemNo: 'Y1', qty: 8, reason: 'found', by: 'sam' });
  assert.equal(w.adjustments[0].after, 8);
  assert.equal(w.movements[0].event, 'created');
  assert.throws(() => w.createStock({ code: '01-02-0-10', itemNo: 'Y1', qty: 1, reason: 'magic' }), /Reason must be one of/);
  now += 3 * 86400000;
  w.deleteStock({ sscc: p.sscc, reason: 'damage', by: 'sam' });
  assert.equal(w.pallets[p.sscc].removed, 'deleted');
  assert.equal(w.locations['01-01-0-10'].sscc, null);
  assert.equal(w.availability().find((r) => r.itemNo === 'Y1').onHand, 0);
  assert.throws(() => w.deleteStock({ sscc: p.sscc, reason: 'damage' }), /not in stock/);
  now += 10 * 86400000;
  assert.equal(w.billingReport({ clientId: 'CL1' })[0].palletDays, 3, 'billed until it was deleted, not until today');
});

test('operator and machine users move to picker and inbound on upgrade', () => {
  const db = new DatabaseSync(':memory:');
  const first = createAuth(db);
  first.ensureAdmin();
  db.prepare("INSERT INTO users (username, display_name, password_hash, role, created_at) VALUES ('omar', 'Omar', 'x', 'operator', 1), ('mina', 'Mina', 'x', 'machine', 1)").run();
  db.prepare("INSERT INTO role_permissions (role, permissions) VALUES ('operator', '[]')").run();
  createAuth(db);
  const roles = Object.fromEntries(db.prepare('SELECT username, role FROM users').all().map((r) => [r.username, r.role]));
  assert.equal(roles.omar, 'picker');
  assert.equal(roles.mina, 'inbound');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM role_permissions WHERE role = 'operator'").get().n, 0);
  assert.deepEqual(ROLE_IDS.filter((r) => ['operator', 'machine'].includes(r)), []);
  assert.ok(DEFAULTS.inbound.includes('putaway.execute') && !DEFAULTS.inbound.includes('picks.execute'));
  assert.ok(DEFAULTS.picker.includes('picks.execute') && !DEFAULTS.picker.includes('moves.execute'));
  assert.ok(DEFAULTS.stock.includes('stock.delete') && DEFAULTS.stock.includes('counts.execute') && !DEFAULTS.stock.includes('picks.execute'));
});
