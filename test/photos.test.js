const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../server/store');
const { createApi } = require('../server/api');
const { permissionFor, DEFAULTS } = require('../server/permissions');

const site = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'server', 'site.blank.json'), 'utf8'));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

function world() {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'sorted-photos-'));
  const store = new Store({ site, file: path.join(folder, 'wms.db') });
  store.exec('setModules', { photos: true, clients: true }, 'admin');
  store.exec('addClient', { id: 'CL-A', name: 'North' }, 'office');
  store.exec('addClient', { id: 'CL-B', name: 'South' }, 'office');
  store.exec('addItem', { itemNo: 'SKU', name: 'Mug', category: 'GEN', clientId: 'CL-A', palletQty: 1 }, 'office');
  store.exec('addItem', { itemNo: 'OTHER', name: 'Bowl', category: 'GEN', clientId: 'CL-B', palletQty: 1 }, 'office');
  return store;
}

function api(store) {
  return createApi({ store, printers: { flush() {} } });
}

test('a photo is stored beside the database, checked, and kept when the module is off', () => {
  const store = world();
  const app = api(store);
  const bad = app.handle('POST', '/api/items/SKU/photos', { data: Buffer.from('not a picture').toString('base64') }, 'office');
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /JPEG/);
  const huge = Buffer.alloc(512 * 1024 + 1, 0);
  huge[0] = 0xff; huge[1] = 0xd8; huge[2] = 0xff;
  const big = app.handle('POST', '/api/items/SKU/photos', { data: huge.toString('base64') }, 'office');
  assert.equal(big.status, 400);
  assert.match(big.body.error, /512 KB/);
  const saved = app.handle('POST', '/api/items/SKU/photos', { name: 'front.png', data: png.toString('base64') }, 'office');
  assert.equal(saved.status, 200);
  assert.equal(saved.body.type, 'png');
  const listed = app.handle('GET', '/api/photos', {}, 'office');
  assert.equal(listed.body.length, 1);
  assert.equal(listed.body[0].itemNo, 'SKU');
  const file = app.handle('GET', `/api/items/SKU/photos/${saved.body.id}`, {}, 'office');
  assert.equal(file.contentType, 'image/png');
  assert.ok(file.body.slice(0, 8).equals(png.slice(0, 8)));
  const row = store.journal({ op: 'addItemPhoto', limit: 1 })[0];
  assert.equal(row.args.data, undefined);
  assert.equal(row.args.bytes, png.length);
  const onDisk = fs.readdirSync(path.join(path.dirname(store.file), 'item-photos', 'SKU'));
  assert.equal(onDisk.length, 1);
  for (let i = 0; i < 2; i++) {
    const extra = app.handle('POST', '/api/items/SKU/photos', { data: png.toString('base64') }, 'office');
    assert.equal(extra.status, 200);
  }
  const full = app.handle('POST', '/api/items/SKU/photos', { data: png.toString('base64') }, 'office');
  assert.equal(full.status, 400);
  assert.match(full.body.error, /3 photos/);
  assert.equal(fs.readdirSync(path.join(path.dirname(store.file), 'item-photos', 'SKU')).length, 3);
  store.exec('setModules', { photos: false }, 'admin');
  assert.equal(store.wh.itemPhotos.SKU.length, 3);
  assert.equal(app.handle('GET', '/api/photos', {}, 'office').status, 404);
  assert.equal(app.handle('POST', '/api/items/SKU/photos', { data: png.toString('base64') }, 'office').status, 403);
  const db = store.file;
  store.close();
  const again = new Store({ site, file: db });
  again.exec('setModules', { photos: true }, 'admin');
  const back = api(again).handle('GET', `/api/items/SKU/photos/${saved.body.id}`, {}, 'office');
  assert.equal(back.contentType, 'image/png');
  again.close();
});

test('a client sees only its own photos, and the text terminal has none', () => {
  const store = world();
  const app = api(store);
  app.handle('POST', '/api/items/SKU/photos', { data: png.toString('base64') }, 'client', null, { role: 'client', clientId: 'CL-A' });
  app.handle('POST', '/api/items/OTHER/photos', { data: png.toString('base64') }, 'office');
  const own = app.handle('GET', '/api/photos', {}, 'client', null, { role: 'client', clientId: 'CL-A' });
  assert.deepEqual(own.body.map((p) => p.itemNo), ['SKU']);
  const denied = app.handle('GET', '/api/items/OTHER/photos/aaaaaaaaaaaaaaaa', {}, 'client', null, { role: 'client', clientId: 'CL-A' });
  assert.equal(denied.status, 403);
  const posted = app.handle('POST', '/api/items/OTHER/photos', { data: png.toString('base64') }, 'client', null, { role: 'client', clientId: 'CL-A' });
  assert.equal(posted.status, 403);
  assert.equal(permissionFor('GET', '/api/photos').permission, 'photos.read');
  assert.equal(permissionFor('POST', '/api/items/SKU/photos').permission, 'photos.write');
  assert.equal(DEFAULTS.client.includes('photos.read'), true);
  assert.equal(DEFAULTS.office.includes('photos.write'), true);
  const terminal = fs.readFileSync(path.join(__dirname, '..', 'src', 'terminal.js'), 'utf8') + fs.readFileSync(path.join(__dirname, '..', 'server', 'terminal.js'), 'utf8');
  assert.equal(/photo/i.test(terminal), false);
  const html = fs.readFileSync(path.join(__dirname, '..', 'server', 'public', 'app.html'), 'utf8');
  assert.equal(html.includes("client: [['items', 'Items'], ['photos', 'Item photos']"), true);
  assert.equal(html.includes("['items', 'Items'], ['photos', 'Item photos'], ['bins'"), true);
  store.close();
});
