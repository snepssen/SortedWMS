/*
 * The SOP and presenter guide on GitHub Pages, with a shared contents
 * layout and role filtering for procedures. Handles the source markdown:
 * headings, paragraphs, lists (one level of nesting), tables, quotes, code.
 */
const fs = require('fs');
const path = require('path');

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function inline(t) {
  let s = esc(t);
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^\w*])\*([^*\n]+)\*(?![\w*])/g, '$1<em>$2</em>');
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, text, href) => {
    const manuals = {
      'SOP.md': 'sop.html', 'DEMO.md': 'demo.html', 'WORKFLOW-REVIEW.md': 'sop.html#review',
      'DEMO-CHECK.md': 'https://github.com/snepssen/SortedWMS/blob/main/docs/DEMO-CHECK.md',
    };
    const url = manuals[href] || (href.startsWith('../') ? href.slice(3) : href);
    return `<a href="${url.replace(/"/g, '&quot;')}">${text}</a>`;
  });
  // The review table carries small <ul><li> lists in its cells.
  return s.replace(/&lt;(\/?)(ul|li)&gt;/g, '<$1$2>');
}

const slug = (t) => t.replace(/<[^>]+>/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const LIST = /^(\s*)(\d+\.|-) (.*)/;

function blocks(md) {
  const lines = md.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) { i++; continue; }
    if (/^\s*---+\s*$/.test(l)) { out.push('<hr>'); i++; continue; }
    if (l.startsWith('```')) {
      const buf = [];
      for (i++; i < lines.length && !lines[i].startsWith('```'); i++) buf.push(lines[i]);
      out.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`);
      i++;
      continue;
    }
    if (l.trim().startsWith('|')) {
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) rows.push(lines[i++].trim());
      const cells = (r) => r.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = cells(rows[0]);
      out.push(`<div class="table"><table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${
        rows.slice(2).map((r) => `<tr>${cells(r).map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    if (l.startsWith('>')) {
      const buf = [];
      while (i < lines.length && lines[i].startsWith('>')) buf.push(lines[i++].slice(1).trim());
      out.push(`<aside class="why">${inline(buf.join(' '))}</aside>`);
      continue;
    }
    if (LIST.test(l)) {
      const items = []; // [indent, ordered, text, step number]
      while (i < lines.length) {
        const m = LIST.exec(lines[i]);
        if (m) { items.push([m[1].length, m[2] !== '-', m[3], m[2] === '-' ? null : Number(m[2].slice(0, -1))]); i++; continue; }
        if (items.length && lines[i].startsWith('   ') && lines[i].trim()) {
          if (lines[i].trim().startsWith('|')) {
            const buf = [];
            while (i < lines.length && lines[i].trim().startsWith('|')) buf.push(lines[i++].trim());
            items[items.length - 1][2] += `\n${buf.join('\n')}`;
            continue;
          }
          items[items.length - 1][2] += ` ${lines[i++].trim()}`;
          continue;
        }
        if (!lines[i].trim() && i + 1 < lines.length && /^\s+(\d+\.|-|\|) /.test(lines[i + 1])) { i++; continue; }
        break;
      }
      const html = [];
      const stack = [];
      for (const [ind, ordered, text, number] of items) {
        const level = ind >= 2 ? 1 : 0;
        const tag = ordered ? 'ol' : 'ul';
        while (stack.length > level + 1) html.push(`</li></${stack.pop()}>`);
        if (stack.length === level + 1) {
          html.push('</li>');
          if (stack[stack.length - 1] !== tag) { html.push(`</${stack.pop()}>`); stack.push(tag); html.push(`<${tag}>`); }
        } else { stack.push(tag); html.push(`<${tag}>`); }
        const [first, ...more] = text.split('\n');
        html.push(`<li${ordered ? ` value="${number}"` : ''}>${inline(first)}${more.length ? blocks(more.join('\n')) : ''}`);
      }
      while (stack.length) html.push(`</li></${stack.pop()}>`);
      out.push(html.join(''));
      continue;
    }
    const buf = [];
    while (i < lines.length && lines[i].trim() && !/^(\s*)(\d+\.|-) |^\||^>|^#|^```/.test(lines[i])) buf.push(lines[i++]);
    if (buf.length) out.push(`<p>${inline(buf.join(' '))}</p>`); else i++;
  }
  return out.join('\n');
}

const ROLES = [['driver', 'Driver'], ['coordinator', 'Coordinator'], ['station', 'Station'], ['desk', 'Desk'], ['loader', 'Loader']];
const ALL = ROLES.map(([k]) => k);
// Procedures whose header doesn't name the role in so many words.
const OVERRIDE = {
  '3.2': ['driver'], '3.3': ['driver', 'coordinator'], '3.4': ['driver', 'coordinator'], '3.5': ['driver', 'coordinator'], '3.6': ['driver', 'coordinator'],
  '5.3': ['station', 'coordinator'], '5.4': ['coordinator', 'station'],
  '6.1': ['coordinator'], '6.2': ['coordinator'], '6.3': ['coordinator'], '6.4': ['coordinator'], '6.5': ['coordinator'], '6.6': ['coordinator'],
};
function rolesOf(text) {
  const t = text.toLowerCase();
  if (/\banyone\b|\bnobody\b/.test(t)) return ALL;
  const found = new Set(ALL.filter((k) => t.includes(k)));
  if (/\bqa\b|manager/.test(t)) found.add('coordinator');
  if (t.includes('keyboard operator')) found.add('desk');
  return [...found];
}
function rolesFor(n, title, who, body = '') {
  const t = title.toLowerCase();
  if (OVERRIDE[n]) return OVERRIDE[n];
  if (['screens', 'the rules the system keeps for you', 'words used here'].includes(t)) return ALL;
  if (['command card', 'mc9401 keys', 'modes', 'messages on the handheld'].includes(t)) return ['driver'];
  if (t.startsWith('settings')) return ['coordinator'];
  const r = who ? rolesOf(who) : rolesOf(`${title} ${body.slice(0, 200)}`);
  return r.length ? r : ALL;
}

function renderPage({ title, eyebrow, heading, intro, toc, main, filters = '' }) {
  const tpl = fs.readFileSync(path.join(__dirname, 'sop-template.html'), 'utf8');
  const values = { TITLE: esc(title), EYEBROW: esc(eyebrow), HEADING: esc(heading), INTRO: intro, TOC: `<ol>${toc.join('')}</ol>`, MAIN: main.join('\n'), FILTERS: filters };
  const page = tpl.replace(/\{\{(\w+)\}\}/g, (_, key) => values[key]);
  return `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n${page}\n</html>\n`;
}

function build(root) {
  const sop = fs.readFileSync(path.join(root, 'docs', 'SOP.md'), 'utf8');
  const review = fs.readFileSync(path.join(root, 'docs', 'WORKFLOW-REVIEW.md'), 'utf8');
  const [intro, rest] = sop.split('\n---\n', 2).length > 1 ? [sop.slice(0, sop.indexOf('\n---\n')), sop.slice(sop.indexOf('\n---\n') + 5)] : [sop, ''];
  const introMd = intro.split('\n').slice(1).join('\n').replace(/\nContents\n[\s\S]*$/, '');
  const toc = [];
  const main = [];
  for (let sec of rest.split(/\n(?=## )/)) {
    sec = sec.trim().replace(/-+\s*$/, '').trim();
    if (!sec.startsWith('## ')) continue;
    const nl = sec.indexOf('\n');
    const stitle = (nl === -1 ? sec : sec.slice(0, nl)).slice(3).trim();
    const md = nl === -1 ? '' : sec.slice(nl + 1);
    const procs = `\n${md}`.split(/\n(?=### )/);
    const tocItems = [];
    const cards = [];
    for (let pr of procs.slice(1)) {
      pr = pr.trim();
      const pn = pr.indexOf('\n');
      const ptitle = (pn === -1 ? pr : pr.slice(0, pn)).slice(4).trim();
      let pmd = pn === -1 ? '' : pr.slice(pn + 1).trim();
      const num = /^(\d+\.\d+) (.*)/.exec(ptitle);
      const [n, t] = num ? [num[1], num[2]] : ['', ptitle];
      let meta = '';
      let who = '';
      const mm = /^(\*\*(?:Who|Screen)\*\* .*)/.exec(pmd);
      if (mm) {
        pmd = pmd.slice(mm[0].length);
        const items = mm[1].split('·').map((p) => p.trim()).map((p) => {
          const k = /^\*\*(\w+)\*\* (.*)/.exec(p);
          return k ? [k[1], k[2]] : ['Who', p];
        });
        if (items[0][0] === 'Who') who = items[0][1];
        meta = `<dl class="meta">${items.map(([k, v]) => `<div><dt>${k}</dt><dd>${inline(v)}</dd></div>`).join('')}</dl>`;
      }
      const roles = rolesFor(n, t, who, pmd);
      const id = slug(ptitle);
      tocItems.push(`<li><a href="#${id}"><span class="n">${n}</span> ${inline(t)}</a></li>`);
      cards.push(`<article class="proc" id="${id}" data-roles="${roles.join(' ')}"><header>${n ? `<span class="pid">${n}</span>` : ''}<h3>${inline(t)}</h3>`
        + `<span class="roles">${roles.map((r) => `<span class="chip">${ROLES.find(([k]) => k === r)[1]}</span>`).join('')}</span></header>${meta}${blocks(pmd)}</article>`);
    }
    const sid = slug(stitle);
    toc.push(`<li><a href="#${sid}">${inline(stitle)}</a>${tocItems.length ? `<ol>${tocItems.join('')}</ol>` : ''}</li>`);
    main.push(`<section class="part" id="${sid}"><h2>${inline(stitle)}</h2>${blocks(procs[0].trim())}${cards.join('')}</section>`);
  }
  // The workflow review, last.
  const rv = review.split('\n').slice(1).join('\n').split(/\n(?=## )/);
  let rvHtml = blocks(rv[0]);
  for (const part of rv.slice(1)) {
    const k = part.trim().indexOf('\n');
    rvHtml += `<h3 class="sub">${inline(part.trim().slice(3, k))}</h3>${blocks(part.trim().slice(k + 1))}`;
  }
  toc.push('<li><a href="#review">Workflow review</a></li>');
  main.push(`<section class="part" id="review"><details class="review"><summary>Workflow review and implementation notes</summary>${rvHtml}</details></section>`);
  return renderPage({ title: 'SortedWMS Demo SOP', eyebrow: 'SortedWMS · demo procedures', heading: 'Demo SOP: floor workflows', intro: blocks(introMd.trim()), toc, main,
    filters: `<div class="filters" role="group" aria-label="Show procedures for"><span class="label">Role</span><button class="filter" id="allRoles" aria-pressed="true">All roles</button>${ROLES.map(([k, v]) => `<button class="filter" data-role="${k}" aria-pressed="false">${v}</button>`).join('')}<span id="filterStatus" role="status" aria-live="polite"></span></div>` });
}

function buildDemo(root) {
  const md = fs.readFileSync(path.join(root, 'docs', 'DEMO.md'), 'utf8');
  const [intro, ...parts] = md.split(/\n(?=## )/);
  const toc = [], main = [];
  for (const part of parts) {
    const nl = part.indexOf('\n');
    const title = part.slice(3, nl).trim(), id = slug(title);
    toc.push(`<li><a href="#${id}">${inline(title)}</a></li>`);
    main.push(`<section class="part" id="${id}"><h2>${inline(title)}</h2>${blocks(part.slice(nl + 1))}</section>`);
  }
  return renderPage({ title: 'SortedWMS Presenter Guide', eyebrow: 'SortedWMS · workflow demonstration', heading: 'Presenter guide', intro: blocks(intro.split('\n').slice(1).join('\n')), toc, main });
}

module.exports = { build, buildDemo, blocks, inline };
