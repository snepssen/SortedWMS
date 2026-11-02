const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const pub = (f) => fs.readFileSync(path.join(__dirname, '..', 'server', 'public', f), 'utf8');
const SCREENS = ['app.html', 'admin.html', 'bins.html', 'desk.html', 'handheld.html', 'keys.html', 'loading.html', 'login.html', 'setup.html', 'station.html'];

test('every screen follows the one theme setting: theme.js in the head, a light and a dark palette, a picker', () => {
  for (const f of SCREENS) {
    const html = pub(f);
    const head = html.slice(0, html.indexOf('</head>') > 0 ? html.indexOf('</head>') : html.indexOf('<style>') + 1);
    assert.match(head, /<script src="theme\.js"><\/script>/, `${f} loads theme.js in its head`);
    assert.match(html, /\[data-theme="dark"\]/, `${f} has a dark palette`);
    assert.doesNotMatch(html, /prefers-color-scheme/, `${f} leaves the device setting to theme.js`);
    assert.match(html, /data-theme-picker|SortedTheme\.html\(\)/, `${f} offers the choice`);
  }
  for (const f of ['pages/demo.html']) {
    const html = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    assert.match(html, /theme\.js/);
    assert.doesNotMatch(html, /prefers-color-scheme/);
  }
  const build = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'build-pages.js'), 'utf8');
  assert.match(build, /'theme\.js'\), path\.join\(out, 'theme\.js'\)/);
  assert.match(build, /'theme\.js'\), path\.join\(out, 'demo', 'theme\.js'\)/);
});

test('theme.js: Auto follows the device, a choice is kept, and every open screen hears of it', () => {
  const store = {};
  const listeners = {};
  const html = { dataset: {}, style: {} };
  const pickers = [{ value: '' }];
  let dark = false;
  const mq = { get matches() { return dark; }, addEventListener: (k, f) => { listeners.mq = f; } };
  const doc = { documentElement: html, body: null, querySelector: () => null, querySelectorAll: () => pickers, addEventListener: (k, f) => { listeners[`doc:${k}`] = f; } };
  const win = { matchMedia: () => mq, addEventListener: (k, f) => { listeners[k] = f; } };
  const run = new Function('self', 'document', 'localStorage', 'getComputedStyle', fs.readFileSync(path.join(__dirname, '..', 'server', 'public', 'theme.js'), 'utf8'));
  run(win, doc, { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } }, () => ({}));
  assert.equal(html.dataset.theme, 'light');
  dark = true;
  listeners.mq();
  assert.equal(html.dataset.theme, 'dark', 'Auto follows the device');
  win.SortedTheme.set('light');
  assert.equal(store['sorted.theme'], 'light');
  assert.equal(html.dataset.theme, 'light', 'a choice beats the device');
  assert.equal(pickers[0].value, 'light');
  store['sorted.theme'] = 'dark';
  listeners.storage({ key: 'sorted.theme' });
  assert.equal(html.dataset.theme, 'dark', 'another screen changed it: this one follows');
  assert.match(win.SortedTheme.html(), /<option value="dark" selected>/);
});
