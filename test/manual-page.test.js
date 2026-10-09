const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { build, buildDemo, blocks, inline } = require('../scripts/sop-page');
const root = path.join(__dirname, '..');

test('manual rendering preserves step numbers across tables and changes list type correctly', () => {
  const html = blocks('1. Begin\n2. Scan\n   | Label | Action |\n   | --- | --- |\n   | SSCC | Scan |\n\n3. Continue\n- Note\n4. Finish');
  assert.match(html, /<li value="3">Continue/);
  assert.match(html, /<li value="4">Finish/);
  assert.match(html, /<\/ol><ul><li>Note<\/li><\/ul><ol>/);
  assert.match(html, /<table>/);
  assert.equal(blocks('---'), '<hr>');
});

test('source manual links resolve to generated Pages files and keep scenario queries', () => {
  assert.equal(inline('[Guide](DEMO.md)'), '<a href="demo.html">Guide</a>');
  assert.equal(inline('[SOP](SOP.md)'), '<a href="sop.html">SOP</a>');
  assert.equal(inline('[Checks](DEMO-CHECK.md)'), '<a href="https://github.com/snepssen/SortedWMS/blob/main/docs/DEMO-CHECK.md">Checks</a>');
  assert.equal(inline('[Counts](../walkthrough.html?scenario=counts)'), '<a href="walkthrough.html?scenario=counts">Counts</a>');
});

test('both manuals have unique live contents anchors, complete wrappers and parseable scripts', () => {
  for (const html of [build(root), buildDemo(root)]) {
    assert.doesNotMatch(html, /\{\{\w+\}\}/);
    assert.equal((html.match(/<body>/g) || []).length, 1);
    assert.match(html, /<\/head>\s*<body>/);
    const markup = html.replace(/<script>[\s\S]*?<\/script>/g, '');
    const ids = [...markup.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
    assert.equal(new Set(ids).size, ids.length);
    for (const [, id] of markup.matchAll(/href="#([^"]+)"/g)) assert.ok(ids.includes(id), `Missing anchor ${id}`);
    for (const [, script] of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) assert.doesNotThrow(() => new vm.Script(script));
  }
  const sop = build(root);
  assert.match(sop, /not an approved site SOP/);
  assert.match(sop, /id="3-7-manual-put-away" data-roles="driver"/);
  assert.match(sop, /id="4-5-manual-pick" data-roles="driver"/);
  assert.doesNotMatch(sop, /scan really didn't arrive/);
  for (const id of Object.keys(require('../src/walkthrough').scenarios)) assert.ok(buildDemo(root).includes(`scenario=${id}`));
});

function rolePage(saved, hash = '') {
  const element = (id, dataset = {}) => ({ id, dataset, hidden: false, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, scrollIntoView() { this.scrolled = true; } });
  const buttons = ['driver', 'coordinator'].map((r) => element(r, { role: r }));
  const procedures = buttons.map((b) => element(`p-${b.id}`, { roles: b.id }));
  const sections = procedures.map((p) => ({ ...element(`s-${p.id}`), querySelectorAll: () => [p] }));
  const links = [...procedures, ...sections].map((p) => ({ id: p.id, parentElement: { hidden: false } }));
  const all = element('allRoles'), status = element('filterStatus');
  const nodes = [all, status, ...procedures, ...sections];
  const document = {
    querySelectorAll: (s) => s === '.filter[data-role]' ? buttons : s === '.proc' ? procedures : sections,
    querySelector: (s) => links.find((l) => s.includes(`#${l.id}"`)),
    getElementById: (id) => nodes.find((n) => n.id === id),
  };
  const script = fs.readFileSync(path.join(root, 'scripts/sop-template.html'), 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
  vm.runInNewContext(script, { document, location: { hash }, localStorage: { getItem: () => saved, setItem() {} }, window: { matchMedia: () => ({ matches: false }), addEventListener() {} } });
  return { buttons, procedures, sections, all, status };
}

test('role filter tolerates malformed storage, hides empty sections and has an All roles reset', () => {
  for (const saved of ['null', '{}', '"driver"', '["unknown"]', 'bad JSON']) {
    const p = rolePage(saved);
    assert.equal(p.all.attrs['aria-pressed'], 'true');
    assert.ok(p.procedures.every((x) => !x.hidden));
  }
  const p = rolePage('[]');
  p.buttons[0].onclick();
  assert.equal(p.procedures[1].hidden, true);
  assert.equal(p.sections[1].hidden, true);
  assert.equal(p.status.textContent, '1 of 2 procedures');
  p.all.onclick();
  assert.ok(p.procedures.every((x) => !x.hidden));
});

test('a direct procedure link reveals its target even after a different role was saved', () => {
  const p = rolePage('["driver"]', '#p-coordinator');
  assert.equal(p.procedures[1].hidden, false);
  assert.equal(p.procedures[1].scrolled, true);
  assert.equal(p.all.attrs['aria-pressed'], 'true');
});

test('free-play startup failures are visible rather than leaving empty panes', async () => {
  const html = fs.readFileSync(path.join(root, 'server/public/try.html'), 'utf8');
  const source = html.slice(html.indexOf('  function startupError'), html.indexOf("  $('#reset').onclick"));
  const nodes = new Map();
  const $ = (s) => { if (!nodes.has(s)) nodes.set(s, { hidden: true, textContent: '', disabled: false }); return nodes.get(s); };
  vm.runInNewContext(source, { $, SortedLocal: { ready: Promise.reject(new Error('Stock could not load')) } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal($('#startStatus').hidden, false);
  assert.match($('#startStatus').textContent, /Reload this page to retry/);
  assert.match($('#startStatus').textContent, /Stock could not load/);
  assert.equal($('#scanIt').disabled, true);
});

test('guided scenario links initialize the selected workflow and update when it changes', async () => {
  const html = fs.readFileSync(path.join(root, 'walkthrough.html'), 'utf8');
  const source = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1];
  for (const requested of ['manual', 'counts', 'readiness', '__proto__', 'unknown']) {
    const nodes = new Map();
    const node = (s) => {
      if (!nodes.has(s)) nodes.set(s, { value: s === '#scenario' ? 'shipping' : '', textContent: '', dataset: {}, setAttribute() {}, focus() {} });
      return nodes.get(s);
    };
    const roles = ['admin', 'office', 'scanner', 'station'].map((r) => ({ ...node(r), dataset: { role: r } }));
    const location = { href: `http://demo.test/walkthrough.html?scenario=${requested}`, search: `?scenario=${requested}` };
    let replaced;
    const ctx = {
      document: { querySelector: node, querySelectorAll: () => roles }, location, URL, URLSearchParams,
      history: { replaceState: (_, __, url) => { replaced = url.toString(); } },
      SortedWalkthrough: require('../src/walkthrough'), SortedWMS: require('../src/engine'), SortedBarcode: require('../src/barcode'),
      fetch: async () => ({ ok: true, json: async () => require('../server/site.example.json') }),
    };
    await vm.runInNewContext(source, ctx);
    assert.equal(node('#scenario').value, ['__proto__', 'unknown'].includes(requested) ? 'shipping' : requested);
    assert.match(node('#count').textContent, /^0 \/ /);
    node('#scenario').value = 'shift';
    node('#scenario').onchange();
    assert.equal(replaced, 'http://demo.test/walkthrough.html?scenario=shift');
    assert.equal(node('#count').textContent, '0 / 8 complete');
  }
});
