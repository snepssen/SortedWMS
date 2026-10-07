#!/usr/bin/env node
/*
 * Build the demo as a standalone site for GitHub Pages.
 *
 * index.html is written as a page fragment (title, styles, body content)
 * because the artifact viewer adds the document wrapper. Pages serves files
 * as they are, so this adds the doctype, charset and mobile viewport, and
 * copies the scripts next to it. Output: _site/
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const out = path.join(root, '_site');
const page = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

// Head = everything up to the end of the first <style> block; the rest is the body.
const cut = page.indexOf('</style>');
if (cut === -1) throw new Error('index.html: expected a <style> block');
const head = page.slice(0, cut + '</style>'.length);
const body = page.slice(cut + '</style>'.length);

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
for (const f of ['gs1.js', 'labels.js', 'engine.js']) {
  fs.copyFileSync(path.join(root, 'src', f), path.join(out, 'src', f));
}
fs.writeFileSync(path.join(out, '.nojekyll'), ''); // serve files as-is
console.log(`Built ${path.relative(root, out)}/ (${fs.readdirSync(out).length} entries)`);
