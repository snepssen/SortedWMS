#!/usr/bin/env node
/*
 * Build the demo as a standalone site for GitHub Pages.
 *
 * index.html is written as a page fragment (title, styles, body content)
 * because the artifact viewer adds the document wrapper. Pages serves files
 * as they are, so this adds the doctype, charset and mobile viewport, and
 * copies the scripts next to it.
 *
 * The WMS screens (handheld, office) go along too, with the WMS running in
 * the browser (server/local.js) since Pages has no server: wms.html shows
 * both side by side. Output: _site/
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const out = path.join(root, '_site');
const page = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

// Head = everything up to the end of the first <style> block; the rest is the body.
const cut = page.indexOf('</style>');
if (cut === -1) throw new Error('index.html: expected a <style> block');
// The page carries its own charset and viewport tags so it also works served raw;
// the wrapper adds them below, so drop the page's copies.
const head = page.slice(0, cut + '</style>'.length).replace(/<meta (charset|name="viewport")[^>]*>\s*/g, '');
// A way from the simulated shift to the real screens and the SOP, which only exist on Pages.
const cards = [
  '<a class="start-card" href="wms.html"><b>Handheld + office →</b><span>Try the real screens: handheld and office side by side. A button scans whatever the handheld asks for.</span></a>',
  '<a class="start-card" href="sop.html"><b>How the floor works →</b><span>The standard operating procedures, by role: driver, coordinator, station, desk.</span></a>',
].join('\n    ');
const marker = /<!-- pages-cards:[^>]*-->/;
if (!marker.test(page)) throw new Error('index.html: expected the pages-cards marker');
const body = page.slice(cut + '</style>'.length).replace(marker, cards);

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="description" content="SortedWMS demo: a simulated reach-truck shift with Auto dispatch, FEFO picking, receiving, check & label and Auto-Shift.">
<style>
:root { color-scheme: light; padding-top: env(safe-area-inset-top, 0px); padding-bottom: env(safe-area-inset-bottom, 0px); }
body { margin: 0; }
img { max-width: 100%; }
</style>
${head.trim()}
</head>
<body>
${body.trim()}
</body>
</html>
`;

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'src'), { recursive: true });
fs.writeFileSync(path.join(out, 'index.html'), html);
for (const f of ['gs1.js', 'labels.js', 'engine.js', 'barcode.js', 'walkthrough.js', 'workload.js', 'drivers.js']) {
  fs.copyFileSync(path.join(root, 'src', f), path.join(out, 'src', f));
}
fs.copyFileSync(path.join(root, 'walkthrough.html'), path.join(out, 'walkthrough.html'));
fs.copyFileSync(path.join(root, 'server', 'public', 'card.html'), path.join(out, 'card.html')); // needs only src/
fs.copyFileSync(path.join(root, 'server', 'public', 'keys.html'), path.join(out, 'keys.html')); // stands alone

// The WMS screens with the in-browser backend loaded before their own script.
const LOCAL = ['src/gs1.js', 'src/labels.js', 'src/engine.js', 'src/workload.js', 'src/drivers.js', 'server/commands.js', 'server/site.js', 'server/seed.js', 'server/api.js', 'server/local.js'];
fs.mkdirSync(path.join(out, 'server'), { recursive: true });
for (const f of LOCAL.filter((f) => f.startsWith('server/')).concat('server/site.example.json')) {
  fs.copyFileSync(path.join(root, f), path.join(out, f));
}
const tags = LOCAL.map((f) => `<script src="${f}"></script>`).join('\n');
for (const [from, to] of [['handheld.html', 'handheld.html'], ['admin.html', 'admin.html'], ['loading.html', 'loading.html'], ['try.html', 'wms.html'], ['kit.html', 'kit.html'], ['station.html', 'station.html'], ['desk.html', 'desk.html']]) {
  const src = fs.readFileSync(path.join(root, 'server', 'public', from), 'utf8');
  const i = src.indexOf('<script>');
  if (i === -1) throw new Error(`${from}: expected a <script> block`);
  fs.writeFileSync(path.join(out, to), `${src.slice(0, i)}${tags}\n${src.slice(i)}`);
}

// The SOP manual, rendered from docs/SOP.md and docs/WORKFLOW-REVIEW.md.
fs.writeFileSync(path.join(out, 'sop.html'), require('./sop-page').build(root));

fs.writeFileSync(path.join(out, '.nojekyll'), ''); // serve files as-is
console.log(`Built ${path.relative(root, out)}/ (${fs.readdirSync(out).length} entries)`);
