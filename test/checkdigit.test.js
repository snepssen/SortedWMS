const test = require('node:test');
const assert = require('node:assert/strict');
const GS1 = require('../src/gs1');
const { Warehouse } = require('../src/engine');

const T0 = Date.UTC(2026, 9, 9, 6, 0);

function setup() {
  const wh = new Warehouse({ aisles: [31, 32], bays: 4, levels: 2, clock: () => T0, config: { groundNextPerItem: 0, checkAfterPick: false } });
  wh.addItem({ itemNo: 'Y1', gtin: GS1.makeGtin13('20000', 1), name: 'Yoghurt', category: 'YOG', palletQty: 96 });
  wh.applyTemplate(wh.selectLocations('31', '32'), 'YOG');
  return wh;
}

test('check digits: two digits per rack location, always the same, none for lanes', () => {
  const wh = setup();
  const racks = wh._racks().map((l) => l.code);
  for (const c of racks) assert.match(wh.checkDigit(c), /^[1-9]\d$/);
  assert.equal(wh.checkDigit(racks[0]), setup().checkDigit(racks[0]));
  assert.ok(new Set(racks.map((c) => wh.checkDigit(c))).size > racks.length / 3, 'spread out, so neighbours rarely share one');
  assert.equal(wh.checkDigit('DOCK-IN'), null);
  assert.equal(wh.checkDigit('OUT-01'), null);
});

test('check digits: typed instead of a location label that will not scan', () => {
  const wh = setup();
  const p = wh.stockPallet('31-02-0-10', { itemNo: 'Y1', batch: 'B1', expiry: '2026-12-01' });
  wh.addTruck('RT1', { mode: 'shift' });
  wh.scan('RT1', p.sscc); wh.scan('RT1', p.sscc); // move it: the system picks the slot
  const task = wh.tasks[wh.trucks.RT1.taskId];
  assert.equal(task.step, 1);
  const right = wh.checkDigit(task.to);
  const wrong = String(right === '10' ? 11 : Number(right) - 1);
  const r = wh.scan('RT1', wrong);
  assert.equal(r.ok, false);
  assert.match(r.text, new RegExp(`${wrong} is not the check digit of ${task.to}`));
  assert.equal(wh.tasks[task.id].status, 'active', 'a wrong digit changes nothing');
  assert.ok(wh.scan('RT1', right).ok);
  assert.equal(wh.pallets[p.sscc].loc, task.to);
});

test('check digits: only for a drop; a pickup or a count takes the label, and a quantity while receiving stays a quantity', () => {
  const wh = setup();
  const p = wh.stockPallet('31-02-0-10', { itemNo: 'Y1', batch: 'B1', expiry: '2026-12-01' });
  wh.planCounts({ codes: ['31-02-0-10'] });
  wh.addTruck('RT1');
  assert.equal(wh.instruction('RT1').kind, 'count');
  assert.equal(wh.scan('RT1', wh.checkDigit('31-02-0-10')).ok, false, 'a count needs the location label');
  assert.ok(wh.scan('RT1', '31-02-0-10').ok);
  assert.match(wh.scan('RT1', p.sscc).text, /Count OK/);
  // Receiving: two digits typed for the count stay a count of cases.
  wh.addDelivery({ id: 'D1', supplier: 'S', category: 'YOG', pallets: 1 });
  assert.equal(wh.instruction('RT1').kind, 'receive');
  wh.scan('RT1', `01${GS1.gtin14(wh.items.Y1.gtin)}15261201` + '10B9');
  wh.scan('RT1', `00${GS1.makeSscc(0, '8799990', 77)}`);
  assert.equal(wh.instruction('RT1').field, 'qty');
  assert.ok(wh.scan('RT1', '80').ok);
  assert.equal(Object.values(wh.pallets).find((x) => x.batch === 'B9').qty, 80);
});

test('check digits: the real labels\' digits can be loaded with the location list', () => {
  const wh = setup();
  wh.importLocations([{ code: '31-01-0-10', check: 7 }, { code: '31-01-0-40', check: '93' }]);
  assert.equal(wh.checkDigit('31-01-0-10'), '07');
  assert.equal(wh.checkDigit('31-01-0-40'), '93');
  assert.throws(() => wh.importLocations([{ code: '31-01-0-70', check: 'AB' }]), /must be 2 digits/);
});
