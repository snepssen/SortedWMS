const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHmac } = require('node:crypto');
const { Store } = require('../server/store');
const { createSendcloud, verifyWebhook, withBackoff, pickRule } = require('../server/sendcloud');

const site = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'server', 'site.blank.json'), 'utf8'));
const PUBLIC = 'sendcloud_public_example';
const SECRET = 'sendcloud_secret_example';
const HOOK = 'webhook-secret-example';
const PDF = Buffer.from('%PDF-1.4\n% fake label for tests\n');

function packed(store) {
  const w = store.wh;
  w.addItem({ itemNo: 'MUG', name: 'Mug', category: 'GEN', palletQty: 10 });
  w.generateGuided({ sections: { count: 1, name: 'Hall' }, layouts: [{ type: 'shelf', positions: { count: 2, name: 'Bin 1' } }] });
  w.binPut({ loc: 'Hall-Bin1', itemNo: 'MUG', qty: 10 });
  w.addClient({ id: 'CL-NORTH', name: 'North' });
  w.addOrder({ id: 'SO1', customer: 'Ada Lovelace', lane: 'OUT-01', clientId: 'CL-NORTH', lines: [{ itemNo: 'MUG', units: 2 }] });
  w.binTake({ loc: 'Hall-Bin1', itemNo: 'MUG', qty: 2, orderId: 'SO1' });
  const box = w.openCarton({ orderId: 'SO1' });
  w.packIntoCarton({ carton: box.id, code: 'Hall-Bin1', qty: 2 });
  w.closeCarton({ carton: box.id, lengthMm: 400, widthMm: 300, heightMm: 200, weightKg: 1.5 });
  return box;
}

function world(transport) {
  const store = new Store({ site });
  store.exec('setModules', { sendcloud: true, connections: true, returns: true }, 'admin');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sendcloud-'));
  const sc = createSendcloud({
    store, secretsFile: null, labelsDir: dir,
    transport: transport || (async () => ({ status: 200, headers: {}, body: Buffer.from('{}') })),
    sleep: async () => {}, log() {},
  });
  sc.saveAccount({
    publicKey: PUBLIC, secretKey: SECRET, webhookSecret: HOOK,
    senderName: 'Sorted warehouse', senderAddress: 'Dock 1', senderCity: 'Gent', senderPostal: '9000', senderCountry: 'BE',
  });
  sc.saveRule({ clientId: 'CL-NORTH', country: 'NL', minKg: 0, maxKg: 5, methodId: '8', carrier: 'PostNL', service: 'standard' });
  sc.saveRule({ country: 'NL', minKg: 5, maxKg: 30, methodId: '9', carrier: 'DPD', service: 'heavy' });
  return { store, sc, dir };
}

test('the signature must match, the rule follows client country and weight, and a label is bought once', async () => {
  const raw = JSON.stringify({ action: 'parcel_status_changed', parcel: { id: 42, status: { message: 'Delivered' } } });
  const good = createHmac('sha256', HOOK).update(raw).digest('hex');
  assert.equal(verifyWebhook(raw, good, HOOK), true);
  assert.equal(verifyWebhook(raw, 'nope', HOOK), false);
  const posts = [];
  const { store, sc, dir } = world(async (req) => {
    const url = String(req.url);
    if (req.method === 'POST' && url.endsWith('/parcels')) {
      posts.push(JSON.parse(req.body.toString()));
      return { status: 200, headers: {}, body: Buffer.from(JSON.stringify({ parcel: { id: 42, tracking_number: '3SEXAMPLE', tracking_url: 'https://tracking.example/3SEXAMPLE', label: { label_printer: 'https://panel.sendcloud.sc/api/v2/labels/42' } } })) };
    }
    if (url.includes('/labels/')) return { status: 200, headers: {}, body: PDF };
    return { status: 200, headers: {}, body: Buffer.from('{}') };
  });
  packed(store);
  const rule = pickRule([
    { client_id: 'CL-NORTH', country: 'NL', min_kg: 0, max_kg: 5, method_id: '8' },
    { client_id: '', country: 'NL', min_kg: 0, max_kg: 5, method_id: '1' },
    { client_id: '', country: '', min_kg: 0, max_kg: 30, method_id: '2' },
  ], { clientId: 'CL-NORTH', country: 'NL', weightKg: 1.5 });
  assert.equal(rule.method_id, '8');
  const heavy = pickRule(store.db.prepare('SELECT * FROM sendcloud_rules').all(), { clientId: 'CL-NORTH', country: 'NL', weightKg: 12 });
  assert.equal(heavy.method_id, '9');
  const first = await sc.createParcel({ orderId: 'SO1', name: 'Ada Lovelace', address: 'Keizersgracht 1', city: 'Amsterdam', postalCode: '1015', country: 'NL' });
  assert.equal(first.status, 'created');
  assert.equal(first.tracking, '3SEXAMPLE');
  assert.equal(first.weightKg, 1.5);
  assert.equal(first.lengthCm, 40);
  assert.equal(first.widthCm, 30);
  assert.equal(first.heightCm, 20);
  assert.equal(posts[0].parcel.shipment.id, 8);
  assert.equal(posts[0].parcel.weight, '1.500');
  assert.equal(fs.readFileSync(path.join(dir, '42.pdf')).slice(0, 5).toString(), '%PDF-');
  const queued = store.wh.printQueue.find((j) => j.label && j.label.kind === 'sendcloud');
  assert.ok(queued && queued.zpl.includes('3SEXAMPLE'));
  assert.equal(store.wh.orders.SO1.tracking, '3SEXAMPLE');
  store.wh.stageShipment({ orderId: 'SO1' });
  assert.match(store.wh.deliveryNote('SO1'), /3SEXAMPLE/);
  const again = await sc.createParcel({ orderId: 'SO1', name: 'Ada Lovelace', address: 'Keizersgracht 1', city: 'Amsterdam', postalCode: '1015', country: 'NL' });
  assert.equal(again.status, 'exists');
  assert.equal(posts.length, 1);
  const view = sc.status();
  assert.equal(view.account.secretKeySet, true);
  assert.equal(JSON.stringify(view).includes(SECRET), false);
  assert.equal(JSON.stringify(view).includes(PUBLIC), false);
  const updated = sc.acceptWebhook(raw, good);
  const duplicate = sc.acceptWebhook(raw, good);
  assert.equal(updated.status, 'updated');
  assert.equal(duplicate.status, 'duplicate');
  assert.throws(() => sc.acceptWebhook(raw, 'nope'), /signature/i);
  store.close();
});

test('a return label needs the returns module, and a 429 waits', async () => {
  const waits = [];
  let n = 0;
  let limited = 0;
  const { store, sc } = world(async (req) => {
    if (req.method === 'POST') {
      limited++;
      if (limited < 3) return { status: 429, headers: { 'retry-after': '0' }, body: Buffer.from('') };
      return { status: 200, headers: {}, body: Buffer.from(JSON.stringify({ parcel: { id: 7, tracking_number: 'RET1', label: { label_printer: 'https://panel.sendcloud.sc/api/v2/labels/7' } } })) };
    }
    return { status: 200, headers: {}, body: PDF };
  });
  const back = await withBackoff(async () => {
    n++;
    return n < 3 ? { status: 429, headers: {} } : { status: 200, headers: {}, body: '' };
  }, { sleep: async (ms) => waits.push(ms), baseMs: 10, max: 4 });
  assert.equal(back.status, 200);
  assert.deepEqual(waits, [10, 20]);
  packed(store);
  store.wh.dispatchCartons({ orderId: 'SO1' });
  store.wh.setModules({ returns: false, sendcloud: true, connections: true });
  await assert.rejects(() => sc.createReturnLabel({ returnId: 'RMA-1', name: 'Ada', address: 'Street 1', city: 'Amsterdam', postalCode: '1015', country: 'NL' }), /switched off/);
  store.wh.setModules({ returns: true, sendcloud: true, connections: true });
  const rma = store.wh.receiveReturn({ orderId: 'SO1', itemNo: 'MUG', qty: 1 });
  const label = await sc.createReturnLabel({ returnId: rma.id, name: 'Ada Lovelace', address: 'Keizersgracht 1', city: 'Amsterdam', postalCode: '1015', country: 'NL', weightKg: 1 });
  assert.equal(label.tracking, 'RET1');
  assert.equal(label.returnId, rma.id);
  store.close();
});
