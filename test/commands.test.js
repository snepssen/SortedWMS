const test = require('node:test');
const assert = require('node:assert/strict');
const GS1 = require('../src/gs1');
const { Warehouse, SCAN_COMMANDS } = require('../src/engine');

const T0 = Date.UTC(2026, 9, 7, 6, 0);

// Command barcodes: a card on the truck, so a driver in gloves never needs the touch screen.
function setup() {
  let t = T0;
  const wh = new Warehouse({ aisles: 4, bays: 6, levels: 3, positions: 3, outLanes: 2, clock: () => t, config: { groundNextPerItem: 0 } });
  wh.addItem({ itemNo: 'Y1', gtin: GS1.makeGtin13('20000', 1), name: 'Greek yoghurt', category: 'YOG', palletQty: 96 });
  wh.setLocationCategory({ aisle: 1 }, 'YOG');
  wh.setLocationCategory({ aisle: 2 }, 'YOG');
  const put = (code, batch, expiry) => wh.stockPallet(code, { itemNo: 'Y1', batch, expiry });
  return { wh, put, advance: (s) => { t += s * 1000; } };
}

test('commands: a mode barcode switches mode, also with the scanner symbology prefix or in lower case', () => {
  const { wh } = setup();
  wh.addTruck('RT1');
  assert.ok(wh.scan('RT1', 'CMD-TRANSFER').ok);
  assert.equal(wh.trucks.RT1.mode, 'transfer');
  wh.scan('RT1', ']C0CMD-STOCK');
  assert.equal(wh.trucks.RT1.mode, 'find');
  wh.scan('RT1', 'cmd-pause');
  assert.equal(wh.trucks.RT1.mode, 'paused');
  assert.match(wh.scan('RT1', '01-01-0-10').text, /scan AUTO/, 'a paused truck says how to start again');
  assert.ok(wh.scan('RT1', 'CMD-AUTO').ok, 'commands work while paused');
  assert.equal(wh.trucks.RT1.mode, 'auto');
  const r = wh.scan('RT1', 'CMD-NOPE');
  assert.equal(r.ok, false);
  assert.match(r.text, /Unknown command/);
});

test('commands: no mode change with a pallet on the forks', () => {
  const { wh, put } = setup();
  const p = put('01-01-1-10', 'B1', '2026-12-01');
  wh.addOrder({ id: 'O1', customer: 'Shop', lane: 'OUT-01', lines: [{ itemNo: 'Y1', pallets: 1 }] });
  wh.addTruck('RT1');
  wh.scan('RT1', p.sscc);
  const r = wh.scan('RT1', 'CMD-TRANSFER');
  assert.equal(r.ok, false);
  assert.match(r.text, /drop it before changing mode/);
  assert.equal(wh.trucks.RT1.mode, 'auto');
});

test('commands: a problem report is confirmed by scanning it twice; any other scan cancels it', () => {
  const { wh, put } = setup();
  const first = put('01-01-0-10', 'B1', '2026-11-20');
  const second = put('01-02-0-10', 'B2', '2026-11-28');
  wh.addOrder({ id: 'O1', customer: 'Shop', lane: 'OUT-01', lines: [{ itemNo: 'Y1', pallets: 1 }] });
  wh.addTruck('RT1');
  const job = wh.tasks[wh.trucks.RT1.taskId];

  const ask = wh.scan('RT1', 'CMD-MISSING');
  assert.match(ask.text, /Pallet missing\? Scan MISSING again/);
  assert.deepEqual(wh.instruction('RT1').armed, { cmd: 'MISSING', code: 'CMD-MISSING', label: 'Pallet missing' });
  assert.equal(job.status, 'active', 'nothing reported yet');

  wh.scan('RT1', '02-06-2-70'); // something else: the report is dropped
  assert.equal(wh.instruction('RT1').armed, undefined);
  wh.scan('RT1', 'CMD-MISSING');
  assert.match(wh.scan('RT1', 'CMD-CANCEL').text, /cancelled/);
  assert.equal(job.status, 'active');

  wh.scan('RT1', 'CMD-MISSING');
  wh.scan('RT1', 'CMD-DAMAGED'); // a different report doesn't confirm the first
  assert.equal(wh.trucks.RT1.armed.cmd, 'DAMAGED');
  wh.scan('RT1', 'CMD-MISSING');
  const r = wh.scan('RT1', 'CMD-MISSING');
  assert.match(r.text, /Pallet missing reported\. Replacement pallet allocated/);
  assert.equal(job.status, 'held');
  assert.equal(first.status, 'missing');
  assert.equal(wh.tasks[wh.trucks.RT1.taskId].sscc, second.sscc);
});

test('commands: the confirm scan must come within 30 seconds', () => {
  const { wh, put, advance } = setup();
  put('01-01-0-10', 'B1', '2026-11-20');
  wh.addOrder({ id: 'O1', customer: 'Shop', lane: 'OUT-01', lines: [{ itemNo: 'Y1', pallets: 1 }] });
  wh.addTruck('RT1');
  const job = wh.tasks[wh.trucks.RT1.taskId];
  wh.scan('RT1', 'CMD-DAMAGED');
  advance(31);
  assert.match(wh.scan('RT1', 'CMD-DAMAGED').text, /again to confirm/, 'too late: it asks again');
  assert.equal(job.status, 'active');
  advance(5);
  wh.scan('RT1', 'CMD-DAMAGED');
  assert.equal(job.status, 'held');
});

test('commands: a report that is not possible says why straight away, without asking to confirm', () => {
  const { wh, put } = setup();
  wh.addTruck('RT1');
  assert.match(wh.scan('RT1', 'CMD-BLOCKED').text, /No job/);
  assert.equal(wh.instruction('RT1').armed, undefined);
  const p = put('01-01-1-10', 'B1', '2026-12-01');
  wh.addOrder({ id: 'O1', customer: 'Shop', lane: 'OUT-01', lines: [{ itemNo: 'Y1', pallets: 1 }] });
  wh.dispatch();
  wh.scan('RT1', p.sscc);
  assert.match(wh.scan('RT1', 'CMD-DAMAGED').text, /on the forks/);
  assert.equal(wh.instruction('RT1').armed, undefined);
});

test('commands: receiving needs no taps — FULL for a full pallet, DONE twice to close the delivery', () => {
  const { wh } = setup();
  wh.addDelivery({ id: 'D1', supplier: 'Dairy Co', category: 'YOG', pallets: 3 });
  wh.addTruck('RT1');
  assert.match(wh.scan('RT1', 'CMD-FULL').text, /Scan the batch first/);
  wh.scan('RT1', 'L2614');
  wh.scan('RT1', '261031');
  wh.scan('RT1', wh.items.Y1.gtin);
  const sscc = wh.nextSscc();
  wh.scan('RT1', sscc);
  assert.ok(wh.scan('RT1', 'CMD-FULL').ok);
  assert.equal(wh.pallets[sscc].qty, 96);
  assert.equal(wh.trucks.RT1.stats.taps, 0);
  assert.equal(wh.trucks.RT1.stats.receiveInputs, 6, '5 good scans and the FULL that came too early');

  assert.match(wh.scan('RT1', 'CMD-DONE').text, /again to confirm/);
  assert.equal(wh.deliveries.D1.status, 'open');
  wh.scan('RT1', 'CMD-DONE');
  assert.equal(wh.deliveries.D1.status, 'received');
  assert.equal(wh.tasks[wh.trucks.RT1.taskId].type, 'PUTAWAY', 'Auto hands out the put-away straight away');
  assert.match(wh.scan('RT1', 'CMD-FULL').text, /Only while receiving/);
});

test('commands: MOVE moves a held pallet, CANCEL lets it go', () => {
  const { wh, put } = setup();
  const p = put('01-04-0-10', 'B1', '2026-12-01');
  wh.addTruck('RT1');
  assert.match(wh.scan('RT1', 'CMD-MOVE').text, /No pallet held/);
  wh.scan('RT1', p.sscc);
  assert.ok(wh.instruction('RT1').pending);
  assert.match(wh.scan('RT1', 'CMD-CANCEL').text, /Let go/);
  assert.equal(wh.instruction('RT1').pending, undefined);
  wh.scan('RT1', p.sscc);
  wh.scan('RT1', 'CMD-STOCK'); // a mode change drops the hold
  assert.equal(wh.instruction('RT1').pending, undefined);
  wh.scan('RT1', 'CMD-AUTO');
  wh.scan('RT1', p.sscc);
  assert.match(wh.scan('RT1', 'CMD-MOVE').text, /^Auto-Shift: take it to/);
  assert.equal(wh.trucks.RT1.load, p.sscc);
});

test('commands: CANCEL clears a half-done transfer', () => {
  const { wh, put } = setup();
  const p = put('01-04-0-10', 'B1', '2026-12-01');
  wh.addTruck('RT1');
  wh.scan('RT1', 'CMD-TRANSFER');
  wh.scan('RT1', p.sscc);
  assert.ok(wh.instruction('RT1').pallet);
  assert.match(wh.scan('RT1', 'CMD-CANCEL').text, /Transfer cancelled/);
  assert.equal(wh.instruction('RT1').pallet, null);
  assert.equal(p.loc, '01-04-0-10');
  assert.match(wh.scan('RT1', 'CMD-CANCEL').text, /Nothing to cancel/);
});

test('commands: every command has a label and a card group', () => {
  for (const [k, c] of Object.entries(SCAN_COMMANDS)) {
    assert.match(k, /^[A-Z]+$/);
    assert.ok(c.label && c.group, k);
  }
});
