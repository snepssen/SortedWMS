#!/usr/bin/env node
/*
 * Build the GitHub Pages site: a short project page, and the real WMS screens
 * with the WMS running in the browser (server/local.js), since Pages has no
 * server. The in-browser warehouse starts as an empty building: run the setup
 * wizard, then add items one by one. demo/ holds the same screens on a demo
 * warehouse worked by bots (src/demo.js, pages/demo.html). Changes stay in
 * that browser.
 * Output: _site/
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const out = path.join(root, '_site');
const REPO = 'https://github.com/snepssen/SortedWMS';

const SRC = ['demo.js', 'gs1.js', 'labels.js', 'locations.js', 'presets.js', 'operations.js', 'bins.js', 'waves.js', 'corrections.js', 'sheets.js', 'renames.js', 'serials.js', 'returns.js', 'messages.js', 'offline-queue.js', 'foundation.js', 'engine.js', 'barcode.js', 'workload.js', 'drivers.js'];
// The WMS screens with the in-browser backend loaded before their own script.
const LOCAL = ['src/gs1.js', 'src/labels.js', 'src/locations.js', 'src/presets.js', 'src/operations.js', 'src/bins.js', 'src/waves.js', 'src/corrections.js', 'src/barcode.js', 'src/sheets.js', 'src/renames.js', 'src/serials.js', 'src/returns.js', 'src/messages.js', 'src/offline-queue.js', 'src/foundation.js', 'src/engine.js', 'src/workload.js', 'src/drivers.js', 'server/commands.js', 'server/site.js', 'server/api.js', 'server/local.js'];
const SCREENS = ['app.html', 'setup.html', 'bins.html', 'handheld.html', 'admin.html', 'loading.html', 'station.html', 'desk.html'];

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'src'), { recursive: true });
fs.mkdirSync(path.join(out, 'server'), { recursive: true });
for (const f of SRC) fs.copyFileSync(path.join(root, 'src', f), path.join(out, 'src', f));
for (const f of LOCAL.filter((f) => f.startsWith('server/')).concat('server/site.blank.json')) fs.copyFileSync(path.join(root, f), path.join(out, f));
fs.copyFileSync(path.join(root, 'server', 'public', 'card.html'), path.join(out, 'card.html')); // needs only src/
fs.copyFileSync(path.join(root, 'server', 'public', 'keys.html'), path.join(out, 'keys.html')); // stands alone
fs.copyFileSync(path.join(root, 'server', 'public', 'camera.js'), path.join(out, 'camera.js')); // scanning with the camera
fs.copyFileSync(path.join(root, 'server', 'public', 'theme.js'), path.join(out, 'theme.js')); // one light/dark setting for every screen

const tags = LOCAL.map((f) => `<script src="${f}"></script>`).join('\n');
for (const name of SCREENS) {
  const src = fs.readFileSync(path.join(root, 'server', 'public', name), 'utf8').replace(/src="\/src\//g, 'src="src/');
  const i = src.indexOf('<script>');
  if (i === -1) throw new Error(`${name}: expected a <script> block`);
  const boot = name === 'app.html' ? `<script>window.SORTED_DEMO = true;</script>\n${tags}\n` : `${tags}\n`;
  fs.writeFileSync(path.join(out, name), `${src.slice(0, i)}${boot}${src.slice(i)}`);
}

// The demo: the same screens in demo/, on their own journal and clock, with the demo warehouse and its bots.
const DEMO_KEY = 'sortedwms.demo.v1';
const demoTags = [`<script>window.SORTED_LOCAL = { key: '${DEMO_KEY}', demo: true };</script>`]
  .concat(LOCAL.slice(0, LOCAL.indexOf('server/commands.js')).concat('src/demo.js', LOCAL.slice(LOCAL.indexOf('server/commands.js'))).map((f) => `<script src="../${f}"></script>`)).join('\n');
fs.mkdirSync(path.join(out, 'demo'), { recursive: true });
fs.copyFileSync(path.join(root, 'server', 'public', 'camera.js'), path.join(out, 'demo', 'camera.js'));
fs.copyFileSync(path.join(root, 'server', 'public', 'theme.js'), path.join(out, 'demo', 'theme.js'));
for (const name of SCREENS) {
  const src = fs.readFileSync(path.join(root, 'server', 'public', name), 'utf8').replace(/src="\/src\//g, 'src="../src/').replace(/src="src\//g, 'src="../src/');
  const i = src.indexOf('<script>');
  const boot = name === 'app.html' ? `<script>window.SORTED_DEMO = true;</script>\n${demoTags}\n` : `${demoTags}\n`;
  fs.writeFileSync(path.join(out, 'demo', name), `${src.slice(0, i)}${boot}${src.slice(i)}`);
}
const hub = fs.readFileSync(path.join(root, 'pages', 'demo.html'), 'utf8');
if (!hub.includes('<!-- WMS -->')) throw new Error('pages/demo.html: expected <!-- WMS -->');
fs.writeFileSync(path.join(out, 'demo', 'index.html'), hub.replace('<!-- WMS -->', demoTags));

fs.writeFileSync(path.join(out, 'index.html'), `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="SortedWMS: an open-source warehouse management system for any warehouse, from a wall of bins to a reach-truck distribution centre.">
<title>SortedWMS</title>
<script src="theme.js"></script>
<style>
  :root { --bg: #f6f7f9; --ink: #17202a; --dim: #5d6b76; --card: #fff; --line: #dde3e8; --accent: #2f5fb3; }
  :root[data-theme="dark"] { --bg: #0f1316; --ink: #e9eef2; --dim: #93a1ad; --card: #182026; --line: #2a343d; --accent: #59a9ff; }
  .top { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
  select { font: inherit; color: var(--ink); background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 4px 8px; }
  body { margin: 0; background: var(--bg); color: var(--ink); font: 16px/1.5 system-ui, sans-serif; }
  main { max-width: 760px; margin: 0 auto; padding: 32px 16px 48px; }
  h1 { font-size: 30px; margin: 0 0 6px; } h2 { font-size: 19px; margin: 28px 0 8px; }
  p, li { color: var(--ink); } .dim { color: var(--dim); }
  a { color: var(--accent); }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; margin-top: 16px; }
  .card { display: block; background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 14px 16px; text-decoration: none; color: var(--ink); }
  .card b { display: block; color: var(--accent); margin-bottom: 4px; }
  code, pre { font-family: ui-monospace, monospace; font-size: 14px; }
  pre { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; overflow-x: auto; }
</style>
</head>
<body>
<main>
  <div class="top"><h1>SortedWMS</h1><select data-theme-picker></select></div>
  <p class="dim">An open-source warehouse management system for any warehouse: a wall of bins at home, a small maker, a 3PL with clients and invoices, or a reach-truck distribution centre.</p>

  <div class="cards">
    <a class="card" href="demo/"><b>Watch the demo →</b>A made-up distribution centre run by bots on the real screens: reach trucks, pick waves, packing and loading. Take over any role and work it yourself.</a>
    <a class="card" href="app.html"><b>Start your own →</b>The real screens, running in this browser. It starts as an empty building: open the setup wizard, then add your items one by one. Nothing leaves your browser.</a>
    <a class="card" href="${REPO}"><b>Source on GitHub →</b>MIT licensed. Node 22 and nothing else: no packages, no Docker.</a>
  </div>

  <h2>Run it yourself</h2>
<pre>git clone ${REPO}.git
cd SortedWMS
./start.sh                 # your own warehouse
./start.sh sample home     # or a sample: home, maker, 3pl</pre>
  <p>Then open <code>http://localhost:8080/login</code>. Everything is in the <a href="${REPO}#readme">README</a>.</p>

  <h2>Tools</h2>
  <ul>
    <li><a href="keys.html">Scanner key test</a>: what a new scanner sends for each key and each scan.</li>
    <li><a href="card.html">Command card</a>: barcodes for every handheld button, to print and laminate.</li>
  </ul>
</main>
</body>
</html>
`);

fs.writeFileSync(path.join(out, '.nojekyll'), ''); // serve files as-is
console.log(`Built ${path.relative(root, out)}/ (${fs.readdirSync(out).length} entries)`);
