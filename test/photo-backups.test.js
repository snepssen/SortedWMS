const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../server/store');
const { createApi } = require('../server/api');
const { backup, restore } = require('../server/backups');
const { createOffsite } = require('../server/backup-offsite');
const { DatabaseSync } = require('node:sqlite');

const site = require('../server/site.blank.json');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const passphrase = 'example-photo-backup-passphrase';
const api = (store) => createApi({ store, printers: { flush() {} } });

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sorted-photo-backup-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'source', 'wms.db');
  fs.mkdirSync(path.dirname(file));
  const store = new Store({ file, site });
  t.after(() => store.close());
  store.createSite({ id: 'WEST' });
  const photos = [];
  for (const warehouse of ['MAIN', 'WEST']) store._withSite(warehouse, () => {
    store.exec('setModules', { photos: true }, 'admin');
    store.exec('addItem', { itemNo: 'SKU', name: 'Mug', category: 'GEN', palletQty: 1 }, 'office');
    const result = api(store).handle('POST', '/api/items/SKU/photos', { data: png.toString('base64') }, 'office');
    assert.equal(result.status, 200);
    photos.push({ site: warehouse, id: result.body.id });
  });
  return { dir, store, photos };
}

function checkPhotos(store, photos) {
  for (const photo of photos) store._withSite(photo.site, () => {
    const result = api(store).handle('GET', `/api/items/SKU/photos/${photo.id}`, {}, 'office');
    assert.equal(result.status, 200, `${photo.site}: photo survives restore without the source folder`);
    assert.equal(result.contentType, 'image/png');
    assert.deepEqual(result.body, png);
  });
}

test('plain backups restore main and secondary warehouse photos on another machine and can be backed up again', (t) => {
  const { dir, store, photos } = fixture(t);
  store.exec('setModules', { photos: false }, 'admin');
  const made = backup(store.file, path.join(dir, 'backups'));
  const destination = path.join(dir, 'destination', 'wms.db');
  restore(made.path, destination);
  const recovered = new Store({ file: destination, site });
  try {
    recovered.exec('setModules', { photos: true }, 'admin');
    checkPhotos(recovered, photos);
    const second = backup(recovered.db, path.join(dir, 'second-backup'));
    const next = path.join(dir, 'next-machine', 'wms.db');
    restore(second.path, next);
    const again = new Store({ file: next, site });
    try { checkPhotos(again, photos); } finally { again.close(); }
  } finally { recovered.close(); }
});

test('a missing or substituted photo cannot silently produce an incomplete backup or prune a good copy', (t) => {
  const { dir, store, photos } = fixture(t);
  const folder = path.join(dir, 'backups');
  const photoDir = path.join(path.dirname(store.file), 'item-photos', 'SKU');
  // A file in the folder that belongs to no journal entry is not warehouse data.
  fs.writeFileSync(path.join(photoDir, 'aaaaaaaaaaaaaaaa.png'), png);
  const good = backup(store.db, folder, { keep: 1 });
  const opened = new DatabaseSync(good.path, { readOnly: true });
  try { assert.equal(opened.prepare('SELECT COUNT(*) AS n FROM backup_item_photos').get().n, 2); } finally { opened.close(); }
  const image = path.join(photoDir, photos[0].id + '.png');
  fs.unlinkSync(image);
  assert.throws(() => backup(store.db, folder, { keep: 1 }), /Photo .* is missing/);
  assert.deepEqual(fs.readdirSync(folder), [good.file]);
  const unrelated = path.join(dir, 'unrelated.png');
  fs.writeFileSync(unrelated, png);
  fs.symlinkSync(unrelated, image);
  assert.throws(() => backup(store.db, folder, { keep: 1 }), /Photo .* is missing/);
  assert.deepEqual(fs.readdirSync(folder), [good.file]);
  fs.unlinkSync(image);
  fs.writeFileSync(image, 'not an image');
  assert.throws(() => backup(store.db, folder, { keep: 1 }), /Photo .* is damaged/);
  assert.deepEqual(fs.readdirSync(folder), [good.file]);
});

test('off-site and encrypted local backups restore the photo bytes, including after restart', async (t) => {
  const { dir, store, photos } = fixture(t);
  const offsite = createOffsite({ store, secretsFile: null, env: {}, log() {} });
  const folder = path.join(dir, 'offsite');
  offsite.save({ passphrase, testDecrypt: true, target: { id: 'folder', kind: 'folder', path: folder } });
  const remote = await offsite.run('admin');
  const local = offsite.writeLocalEncrypted({ dir: path.join(dir, 'encrypted-local'), force: true });
  for (const [name, file] of [['remote', path.join(folder, remote.file)], ['local', local.path]]) {
    const destination = path.join(dir, name, 'wms.db');
    fs.mkdirSync(path.dirname(destination));
    const recovered = new Store({ file: destination, site });
    try {
      const restoreService = createOffsite({ store: recovered, secretsFile: null, env: {}, log() {} });
      await restoreService.restore({ file, passphrase });
      checkPhotos(recovered, photos);
      // A second restore must discard a warehouse already cached in memory.
      recovered._withSite('WEST', () => recovered.exec('setModules', { photos: false }, 'admin'));
      await restoreService.restore({ file, passphrase });
      checkPhotos(recovered, photos);
    } finally { recovered.close(); }
    const again = new Store({ file: destination, site });
    try { checkPhotos(again, photos); } finally { again.close(); }
  }
});
