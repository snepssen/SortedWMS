// Exercise the emitted bootstrap, so a new engine installer cannot silently
// work in Node while being omitted from the published browser build.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const out = path.join(root, '_site');
test.before(() => execFileSync(process.execPath, ['scripts/build-pages.js'], { cwd: root }));

function browser(page, storage) {
  const html = fs.readFileSync(path.join(out, page), 'utf8');
  const context = vm.createContext({
    console, URL,
    document: { currentScript: null },
    localStorage: {
      getItem: (key) => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key),
    },
    fetch: async () => ({ json: async () => JSON.parse(fs.readFileSync(path.join(out, 'server/site.blank.json'), 'utf8')) }),
    addEventListener() {}, setInterval() {},
  });
  context.window = context.self = context;
  const bootstrap = html.slice(html.indexOf('<script src="' + (page.startsWith('demo/') ? '../' : '') + 'modules/'));
  for (const [, src] of bootstrap.matchAll(/<script src="([^"]+)"><\/script>/g)) {
    const file = path.resolve(path.dirname(path.join(out, page)), src);
    vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: src });
  }
  return context.SortedLocal.store();
}

for (const page of ['app.html', 'demo/app.html']) {
  test(`${page}: the emitted BOM consumes stock and replays across pages`, async () => {
    const storage = new Map();
    const store = await browser(page, storage);
    store.exec('setModules', { bom: true, kitting: true, bins: true }, 'admin');
    for (const itemNo of ['PART', 'KIT']) store.exec('addItem', { itemNo, name: itemNo, category: 'GEN', palletQty: 1 }, 'office');
    store.exec('createLocation', { code: 'BIN-1', kind: 'bin' }, 'office');
    store.exec('binPut', { loc: 'BIN-1', itemNo: 'PART', qty: 2 }, 'office');
    store.exec('setBom', { itemNo: 'KIT', lines: [{ itemNo: 'PART', qty: 2 }] }, 'office');
    store.exec('buildKit', { itemNo: 'KIT', qty: 1, loc: 'BIN-1' }, 'office');
    const again = await browser(page, storage);
    const stock = again.wh.binStock['BIN-1'];
    assert.equal(stock.filter((row) => row.itemNo === 'PART').reduce((n, row) => n + row.qty, 0), 0);
    assert.equal(stock.find((row) => row.itemNo === 'KIT').qty, 1);
    assert.equal(typeof again.wh.addItemPhoto, 'function');
  });
}

test('published screens have valid inline scripts and existing local script assets', () => {
  for (const folder of ['', 'demo']) {
    for (const name of fs.readdirSync(path.join(out, folder)).filter((file) => file.endsWith('.html'))) {
      const file = path.join(out, folder, name);
      const html = fs.readFileSync(file, 'utf8');
      for (const [, src, inline] of html.matchAll(/<script(?: src="([^"]+)")?[^>]*>([\s\S]*?)<\/script>/g)) {
        if (src) assert.ok(fs.existsSync(path.resolve(path.dirname(file), src)), `${folder}/${name}: ${src}`);
        else new vm.Script(inline, { filename: file });
      }
    }
  }
});
