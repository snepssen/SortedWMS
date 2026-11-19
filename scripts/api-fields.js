'use strict';

/*
 * Request and response fields for docs/API.md, read from the handlers.
 * A field is listed because a handler, a command, or the function they call
 * names it. The reference test checks a handler's own `b.field` reads against
 * this list, so a renamed field changes the page.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function patternsFrom(raw) {
  const text = raw.replace(/\\\//g, '/');
  if (text.includes('rename|revoke')) return ['/api/devices/paired/:id/rename', '/api/devices/paired/:id/revoke'];
  if (text.includes('remove|retry')) return ['/api/webhooks/:id/remove', '/api/webhooks/:id/retry'];
  const named = text.replace(/\(\?:[^)]*\)\??/g, '').replace(/\([^)]*\)/g, (bit) => {
    if (bit.includes('a-z')) return ':role';
    return ':id';
  });
  return [named];
}

function skipString(src, i) {
  const q = src[i];
  i++;
  while (i < src.length) {
    if (src[i] === '\\') { i += 2; continue; }
    if (q === '`' && src[i] === '$' && src[i + 1] === '{') {
      const end = closeOf(src, i + 1);
      i = end + 1;
      continue;
    }
    if (src[i] === q) return i;
    i++;
  }
  return src.length - 1;
}

function regexStart(src, i) {
  if (src[i] !== '/' || src[i + 1] === '/' || src[i + 1] === '*') return false;
  let j = i - 1;
  while (j >= 0 && /[ \t]/.test(src[j])) j--;
  if (j < 0) return true;
  return /[=(:,;!&|?{}\[\]~^]/.test(src[j]) || src.slice(Math.max(0, j - 5), j + 1).match(/(?:return|case|throw|else|typeof|void|in|of)$/);
}

function skipRegex(src, i) {
  i++;
  while (i < src.length) {
    if (src[i] === '\\') { i += 2; continue; }
    if (src[i] === '[') {
      i++;
      while (i < src.length && src[i] !== ']') {
        if (src[i] === '\\') i++;
        i++;
      }
    } else if (src[i] === '/') {
      i++;
      while (i < src.length && /[a-z]/i.test(src[i])) i++;
      return i - 1;
    }
    i++;
  }
  return src.length - 1;
}

function closeOf(src, open) {
  const pair = { '(': ')', '{': '}', '[': ']' };
  const want = pair[src[open]];
  if (!want) throw new Error('not an opener');
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "'" || c === '"' || c === '`') { i = skipString(src, i); continue; }
    if (c === '/' && src[i + 1] === '/') { const n = src.indexOf('\n', i); i = n < 0 ? src.length : n; continue; }
    if (c === '/' && src[i + 1] === '*') { const n = src.indexOf('*/', i + 2); i = n < 0 ? src.length : n + 1; continue; }
    if (regexStart(src, i)) { i = skipRegex(src, i); continue; }
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') {
      depth--;
      if (depth === 0) return i;
    }
  }
  throw new Error('unbalanced');
}

function splitTop(src) {
  const parts = [];
  let start = 0;
  let depth = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "'" || c === '"' || c === '`') { i = skipString(src, i); continue; }
    if (c === '/' && src[i + 1] === '/') { const n = src.indexOf('\n', i); i = n < 0 ? src.length : n; continue; }
    if (c === '/' && src[i + 1] === '*') { const n = src.indexOf('*/', i + 2); i = n < 0 ? src.length : n + 1; continue; }
    if (regexStart(src, i)) { i = skipRegex(src, i); continue; }
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') depth--;
    else if (c === ',' && depth === 0) {
      parts.push(src.slice(start, i).trim());
      start = i + 1;
    }
  }
  const last = src.slice(start).trim();
  if (last) parts.push(last);
  return parts;
}

function destructureFields(text) {
  const body = text.trim().replace(/^\{\s*/, '').replace(/\s*\}$/, '');
  const fields = [];
  const required = new Set();
  for (const part of splitTop(body)) {
    const t = part.trim();
    if (!t || t.startsWith('...')) continue;
    const name = /^([A-Za-z_][A-Za-z0-9_]*)/.exec(t);
    if (!name) continue;
    fields.push(name[1]);
    if (!t.includes('=')) required.add(name[1]);
  }
  return { fields, required };
}

function objectKeys(src, open) {
  const end = closeOf(src, open);
  const keys = [];
  let depth = 0;
  let expect = true;
  for (let i = open; i < end; i++) {
    const c = src[i];
    if (c === "'" || c === '"' || c === '`') { i = skipString(src, i); continue; }
    if (c === '/' && src[i + 1] === '/') { const n = src.indexOf('\n', i); i = n < 0 ? src.length : n; continue; }
    if (c === '/' && src[i + 1] === '*') { const n = src.indexOf('*/', i + 2); i = n < 0 ? src.length : n + 1; continue; }
    if (regexStart(src, i)) { i = skipRegex(src, i); continue; }
    if (c === '{' || c === '(' || c === '[') {
      if (c === '{' && depth === 1 && expect) {
        keys.push('…');
        i = closeOf(src, i);
        expect = false;
        continue;
      }
      depth++;
      continue;
    }
    if (c === '}' || c === ')' || c === ']') { depth--; continue; }
    if (depth === 1 && c === ',') { expect = true; continue; }
    if (depth === 1 && expect && /[A-Za-z_.]/.test(c)) {
      const m = src.slice(i).match(/^(?:\.\.\.([A-Za-z_][A-Za-z0-9_]*)|([A-Za-z_][A-Za-z0-9_]*)|'([^']+)'|"([^"]+)")/);
      if (m) {
        keys.push(m[1] ? `…${m[1]}` : (m[2] || m[3] || m[4]));
        i += m[0].length - 1;
        expect = false;
      }
    }
  }
  return keys;
}

function readFiles(dir) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) out.push(...readFiles(full));
    else if (name.endsWith('.js')) out.push(full);
  }
  return out;
}

function indexFunctions() {
  const byName = new Map();
  const files = [...readFiles(path.join(ROOT, 'server')), ...readFiles(path.join(ROOT, 'src')), ...readFiles(path.join(ROOT, 'modules'))];
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    const found = [];
    const re = /(?:function\s+([A-Za-z_][A-Za-z0-9_]*)|\.([A-Za-z_][A-Za-z0-9_]*)\s*=\s*function|(?:const|let|var)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:async\s*)?(?:function\s*)?|(?:^|\n)\s{0,8}([A-Za-z_][A-Za-z0-9_]*))\s*\(/g;
    let m;
    while ((m = re.exec(src))) {
      const name = m[1] || m[2] || m[3] || m[4];
      if (!name || ['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'else'].includes(name)) continue;
      const paren = m.index + m[0].length - 1;
      let paramsEnd;
      try { paramsEnd = closeOf(src, paren); } catch { continue; }
      const after = /^\s*(=>|\{)/.exec(src.slice(paramsEnd + 1));
      if (!after) continue;
      const params = src.slice(paren + 1, paramsEnd);
      let body = '';
      let bodyStart = paramsEnd + 1 + after.index;
      try {
        if (after[1] === '{') {
          const end = closeOf(src, bodyStart + after[0].indexOf('{'));
          body = src.slice(bodyStart, end + 1);
        } else {
          const expr = paramsEnd + 1 + after.index + after[0].length;
          body = src.slice(expr, expr + 400);
        }
      } catch { continue; }
      found.push({ name, params, body, file, src });
    }
    for (const fn of found) {
      const list = byName.get(fn.name) || [];
      list.push(fn);
      byName.set(fn.name, list);
    }
  }
  return byName;
}

function commandMap() {
  const src = fs.readFileSync(path.join(ROOT, 'server', 'commands.js'), 'utf8');
  const map = new Map();
  const re = /\n {4}([A-Za-z_][A-Za-z0-9_]*): (?:async )?\(([^)]*)\) =>/g;
  let m;
  while ((m = re.exec(src))) {
    const at = m.index + m[0].length;
    let body = '';
    try {
      if (src[at] === '{') {
        const end = closeOf(src, at);
        body = src.slice(at, end + 1);
        re.lastIndex = end;
      } else {
        const end = expressionEnd(src, at);
        body = src.slice(at, end);
        re.lastIndex = end;
      }
    } catch { continue; }
    map.set(m[1], { params: m[2], body });
  }
  return map;
}

function expressionEnd(src, i) {
  let depth = 0;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === "'" || c === '"' || c === '`') { i = skipString(src, i); continue; }
    if (c === '/' && src[i + 1] === '/') { const n = src.indexOf('\n', i); i = n < 0 ? src.length : n; continue; }
    if (c === '/' && src[i + 1] === '*') { const n = src.indexOf('*/', i + 2); i = n < 0 ? src.length : n + 1; continue; }
    if (regexStart(src, i)) { i = skipRegex(src, i); continue; }
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') depth--;
    else if (c === ',' && depth === 0) return i;
  }
  return src.length;
}

function callsOf(src, lead) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const at = src.indexOf(lead, i);
    if (at < 0) break;
    const nameAt = at + lead.length;
    const name = /^([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(src.slice(nameAt));
    if (!name) { i = nameAt; continue; }
    const paren = nameAt + name[0].length - 1;
    try {
      const end = closeOf(src, paren);
      out.push({ name: name[1], args: splitTop(src.slice(paren + 1, end)) });
      i = end + 1;
    } catch { i = paren + 1; }
  }
  return out;
}

function objectFields(fn, param) {
  if (!fn || !param) return { fields: [], required: new Set() };
  const fields = [];
  const required = new Set();
  const add = (name) => { if (name && !fields.includes(name)) fields.push(name); };
  const params = splitTop(fn.params);
  const direct = params.find((p) => {
    const left = p.replace(/=[\s\S]*$/, '').trim();
    return left === param;
  });
  if (direct && direct.trim().startsWith('{')) {
    const parsed = destructureFields(direct.replace(/=[\s\S]*$/, ''));
    return parsed;
  }
  // The param might itself be the destructure, passed by position.
  if (param.trim().startsWith('{')) {
    const parsed = destructureFields(param);
    return parsed;
  }
  const body = fn.body;
  for (const m of body.matchAll(new RegExp(`\\b${param}\\.([A-Za-z_][A-Za-z0-9_]*)`, 'g'))) add(m[1]);
  for (const m of body.matchAll(new RegExp(`['"]([A-Za-z_][A-Za-z0-9_]*)['"]\\s+in\\s+${param}\\b`, 'g'))) add(m[1]);
  if (body.includes(`${param}[key]`) || body.includes(`key in ${param}`)) {
    for (const m of body.matchAll(/\['([^']+)'\s*,\s*'[^']+'\]/g)) add(m[1]);
    for (const m of body.matchAll(/Object\.entries\(([A-Za-z_][A-Za-z0-9_]*)\)/g)) {
      const decl = fn.src.match(new RegExp(`(?:const|let|var) ${m[1]} = \\{([^}]+)\\}`));
      if (decl) for (const key of decl[1].matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*:/g)) add(key[1]);
    }
  }
  const spread = body.match(new RegExp(`(?:const|let)\\s+([A-Za-z_][A-Za-z0-9_]*)\\s*=\\s*\\{[\\s\\S]{0,200}?\\.\\.\\.\\(?${param}\\b`));
  if (spread) {
    for (const m of body.matchAll(new RegExp(`\\b${spread[1]}\\.([A-Za-z_][A-Za-z0-9_]*)`, 'g'))) add(m[1]);
  }
  return { fields, required };
}

function pickFn(list, hint) {
  if (!list || !list.length) return null;
  if (hint) {
    const hit = list.find((fn) => fn.file.endsWith(hint));
    if (hit) return hit;
  }
  return list.slice().sort((a, b) => b.body.length - a.body.length)[0];
}

function commandFields(cmd, fns) {
  const body = cmd.body;
  const fields = [];
  const required = new Set();
  const add = (name, reqd) => {
    if (!name || name === 'length') return;
    if (!fields.includes(name)) fields.push(name);
    if (reqd) required.add(name);
  };
  for (const m of body.matchAll(/req\(\s*a\.([A-Za-z_][A-Za-z0-9_]*)\s*,\s*'([A-Za-z_][A-Za-z0-9_]*)'/g)) add(m[2], true);
  for (const m of body.matchAll(/\ba\.([A-Za-z_][A-Za-z0-9_]*)/g)) add(m[1], false);
  const rows = [];
  for (const m of body.matchAll(/\br\.([A-Za-z_][A-Za-z0-9_]*)/g)) if (!rows.includes(m[1]) && m[1] !== 'length') rows.push(m[1]);
  for (const call of callsOf(body, 'wh.')) {
    const target = pickFn(fns.get(call.name));
    if (!target) continue;
    const params = splitTop(target.params);
    call.args.forEach((arg, i) => {
      const trimmed = arg.trim();
      const passes = /(?:^|[^\w.])a(?:$|[^\w.])/.test(trimmed) || trimmed.includes('...a');
      if (!passes) return;
      const param = params[i];
      if (!param) return;
      const left = paramHead(param);
      const read = left.startsWith('{') ? destructureFields(left) : objectFields(target, left);
      for (const name of read.fields) add(name, false);
    });
  }
  return { fields, required, rows };
}

function responseKeys(src, allowArrow) {
  const keys = [];
  const add = (list) => { for (const k of list) if (k !== 'status' && !keys.includes(k)) keys.push(k); };
  const take = (at) => {
    const brace = src.indexOf('{', at);
    if (brace < 0) return false;
    try {
      const found = objectKeys(src, brace);
      if (found.includes('error')) return false;
      if (found.length) add(found);
      return found.length > 0;
    } catch { return false; }
  };
  const re = /return\s*\{|send\(\s*20[01]\s*,\s*\{/g;
  let m;
  let saw = false;
  while ((m = re.exec(src))) saw = take(m.index) || saw;
  if (saw || !allowArrow) return keys;
  const arrow = /=>\s*\(\s*\{/.exec(src);
  if (arrow) take(arrow.index);
  return keys;
}

function handlerSources() {
  const api = fs.readFileSync(path.join(ROOT, 'server', 'api.js'), 'utf8');
  const map = new Map();
  const re = /on\('(GET|POST)', '([^']*)',/g;
  let m;
  while ((m = re.exec(api))) {
    const paren = api.lastIndexOf('(', m.index + 3);
    try {
      const end = closeOf(api, paren);
      const args = api.slice(paren + 1, end);
      const parts = splitTop(args);
      const src = parts.slice(2).join(', ');
      map.set(`${m[1]} ${m[2]}`, src);
      re.lastIndex = end;
    } catch { /* leave the route without a source */ }
  }
  const index = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');
  const lines = index.split('\n');
  const starts = [];
  for (let i = 0; i < lines.length; i++) {
    if (/pathname === '|pathname\.match\(/.test(lines[i]) && /^ {6}/.test(lines[i])) starts.push(i);
  }
  for (let s = 0; s < starts.length; s++) {
    const from = starts[s];
    const to = s + 1 < starts.length ? starts[s + 1] : Math.min(lines.length, from + 40);
    const chunk = lines.slice(from, to).join('\n');
    const exact = chunk.match(/req\.method === '(GET|POST)'[\s\S]*?pathname === '(\/api\/[^']+)'/);
    if (exact) {
      map.set(`${exact[1]} ${exact[2]}`, chunk);
      continue;
    }
    const rx = chunk.match(/pathname\.match\(\/\^([^$]+)\$\//);
    const http = (chunk.match(/req\.method === '(GET|POST)'/) || [])[1] || 'POST';
    if (!rx) continue;
    for (const pattern of patternsFrom(rx[1])) map.set(`${http} ${pattern}`, chunk);
  }
  return map;
}

let cached = null;
function library() {
  if (cached) return cached;
  cached = { fns: indexFunctions(), commands: commandMap(), handlers: handlerSources() };
  return cached;
}

function paramHead(param) {
  const t = String(param || '').trim();
  if (t.startsWith('{')) {
    try { return t.slice(0, closeOf(t, 0) + 1); } catch { return t; }
  }
  return t.replace(/\s*=\s*[\s\S]*$/, '').trim();
}

function passesWhole(arg) {
  const trimmed = String(arg || '').trim();
  return trimmed === 'b' || trimmed === 'body' || trimmed === 'b || {}' || trimmed === 'body || {}'
    || /^\{\s*\.\.\.\s*b(?:ody)?\b/.test(trimmed);
}

function mentionsBody(value) {
  return /\bb(?:ody)?\.[A-Za-z_]/.test(value) || /(?:^|[^\w.])(?:b|body)(?:$|[^\w.])/.test(value);
}

function absorbObject(arg, cmd, fns, add, rowNotes, markWhole) {
  for (const name of destructureFields(arg).fields) {
    const value = argFieldValue(arg, name);
    if (!mentionsBody(value)) continue;
    if (value === 'b' || value === 'body' || /listOf\s*\(\s*b\s*\)/.test(value)) {
      const read = commandFields(cmd, fns);
      if (/listOf\s*\(/.test(value)) {
        add(name, false);
        if (read.rows.length) rowNotes.push(read.rows);
        else for (const n of read.fields) if (n !== name && n !== 'rows') add(n, read.required.has(n));
      } else {
        const nested = read.fields.filter((n) => n !== name);
        if (!nested.length && !read.rows.length) markWhole();
        for (const n of nested) add(n, read.required.has(n));
        if (read.rows.length) rowNotes.push(read.rows);
      }
    } else add(name, false);
  }
}

function describe(method, pattern) {
  const { fns, commands, handlers } = library();
  const src = handlers.get(`${method} ${pattern}`) || '';
  const pathFields = [...pattern.matchAll(/:([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]);
  const query = unique([
    ...[...src.matchAll(/\bq\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]),
    ...[...src.matchAll(/searchParams\.get\('([^']+)'\)/g)].map((m) => m[1]),
  ]);
  const direct = unique([...src.matchAll(/\bb(?:ody)?\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]));
  const body = [];
  const required = new Set();
  const rowNotes = [];
  const add = (name, reqd) => {
    if (!name || ['length', 'then'].includes(name)) return;
    if (!body.includes(name)) body.push(name);
    if (reqd) required.add(name);
  };
  for (const name of direct) add(name, false);

  let whole = false;
  const absorb = (read) => {
    if (!read.fields.length && !read.rows.length) whole = true;
    for (const name of read.fields) add(name, read.required.has(name));
    if (read.rows.length) rowNotes.push(read.rows);
  };
  for (const call of runCalls(src)) {
    const cmd = commands.get(call.name);
    const arg = (call.args[0] || '').trim();
    if (!cmd) {
      if (passesWhole(arg)) whole = true;
      continue;
    }
    if (passesWhole(arg)) absorb(commandFields(cmd, fns));
    else if (arg.startsWith('{')) absorbObject(arg, cmd, fns, add, rowNotes, () => { whole = true; });
    else absorb(commandFields(cmd, fns));
  }
  for (const [lead, hint] of [['auth.', '/auth.js'], ['outbox.', '/outbox.js'], ['sendcloud.', '/sendcloud.js']]) {
    for (const call of callsOf(src, lead)) {
      const target = pickFn(fns.get(call.name), hint);
      if (!target) continue;
      const params = splitTop(target.params);
      call.args.forEach((arg, i) => {
        if (!passesWhole(arg)) return;
        const param = params[i];
        if (!param) return;
        const left = paramHead(param);
        const read = left.startsWith('{') ? destructureFields(left) : objectFields(target, left);
        if (!read.fields.length) whole = true;
        for (const name of read.fields) add(name, read.required.has(name));
      });
    }
  }

  const expand = (keys, file) => {
    const out = [];
    for (const k of keys) {
      if (!k.startsWith('…')) { if (k !== '…' && !out.includes(k)) out.push(k); continue; }
      const name = k.slice(1);
      const fn = (fns.get(name) || []).find((item) => item.file === file);
      const inner = fn ? responseKeys(fn.body) : [];
      if (!inner.length) { if (!out.includes(k)) out.push(k); continue; }
      for (const item of inner) if (item !== '…' && !out.includes(item)) out.push(item);
    }
    return out;
  };
  let response = expand(responseKeys(src, true), path.join(ROOT, 'server', 'api.js'));
  const forward = src.match(/^\s*(?:async\s*)?\([^)]*\)\s*=>\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
  if (!response.length && forward && !['run', 'wh', 'Object', 'Math', 'JSON'].includes(forward[1])) {
    const target = pickFn(fns.get(forward[1]));
    if (target) response = expand(responseKeys(target.body), target.file);
    if (!response.length) response = [`result of ${forward[1]}`];
  }
  if (!response.length) {
    for (const [lead, hint] of [['auth.', '/auth.js'], ['outbox.', '/outbox.js'], ['sendcloud.', '/sendcloud.js']]) {
      for (const call of callsOf(src, lead)) {
        const target = pickFn(fns.get(call.name), hint);
        if (!target) continue;
        const keys = expand(responseKeys(target.body), target.file);
        if (keys.length) response = keys;
      }
    }
  }
  for (const m of src.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*(b|body)\s*[,)]/g)) {
    if (['mentionsValue', 'ownClient', 'listOf', 'String', 'Number', 'Boolean', 'Array', 'run'].includes(m[1])) continue;
    if (body.length) continue;
    const target = pickFn(fns.get(m[1]));
    if (!target) { whole = true; continue; }
    const param = splitTop(target.params)[0];
    if (!param) { whole = true; continue; }
    const left = paramHead(param);
    const read = left.startsWith('{') ? destructureFields(left) : objectFields(target, left);
    if (!read.fields.length) whole = true;
    for (const name of read.fields) add(name, read.required.has(name));
  }

  if (!response.length) {
    for (const call of callsOf(src, 'wh().')) {
      const target = pickFn(fns.get(call.name));
      if (!target) continue;
      const keys = expand(responseKeys(target.body), target.file);
      if (keys.length) response = keys;
    }
  }
  if (!response.length) {
    const names = [];
    const mapFn = src.match(/\.map\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)/);
    if (mapFn) names.push(mapFn[1]);
    const mapCall = src.match(/\.map\(\s*\([^)]*\)\s*=>\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
    if (mapCall) names.push(mapCall[1]);
    const returned = src.match(/return\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
    if (returned) names.push(returned[1]);
    for (const name of names) {
      const target = pickFn(fns.get(name));
      if (!target) continue;
      const keys = expand(responseKeys(target.body), target.file);
      if (keys.length) { response = keys; break; }
    }
  }
  if (!response.length) {
    const only = src.match(/^\s*\([^)]*\)\s*=>\s*[A-Za-z_][A-Za-z0-9_]*\.([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
    if (only) {
      const target = pickFn(fns.get(only[1]));
      const keys = target ? expand(responseKeys(target.body), target.file) : [];
      if (keys.length) response = keys;
    }
  }
  if (!response.length) {
    for (const call of runCalls(src)) {
      const cmd = commands.get(call.name);
      if (!cmd) continue;
      const keys = responseKeys(cmd.body, true);
      if (keys.length) response = keys;
    }
  }
  if (!response.length && /(?:^|[^\w.])run\(/.test(src)) response = ['the command result'];
  if (/\.csv/.test(pattern) || /text\/csv/.test(src)) response = ['csv'];
  if (/\.pdf/.test(pattern) || /application\/pdf/.test(src)) response = ['pdf'];
  if (!response.length) response = ['the handler\'s value'];

  return {
    src,
    path: pathFields,
    query,
    body,
    required: [...required],
    whole: whole && body.length === 0,
    rows: rowNotes[0] || [],
    response,
    direct,
  };
}

function runCalls(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const at = src.indexOf('run(', i);
    if (at < 0) break;
    if (at > 0 && /[A-Za-z0-9_]/.test(src[at - 1])) { i = at + 4; continue; }
    try {
      const end = closeOf(src, at + 3);
      const args = splitTop(src.slice(at + 4, end));
      const name = (args[0] || '').replace(/^'|'$/g, '');
      if (/^[A-Za-z_]/.test(name)) out.push({ name, args: args.slice(1) });
      i = end + 1;
    } catch { i = at + 4; }
  }
  return out;
}

function argFieldValue(objectSrc, field) {
  const inner = objectSrc.trim().replace(/^\{/, '').replace(/\}$/, '');
  for (const part of splitTop(inner)) {
    const m = part.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([\s\S]+)$/);
    if (m && m[1] === field) return m[2].trim();
    if (!m && part.trim() === field) return field;
  }
  return '';
}

function unique(list) {
  return [...new Set(list)];
}

function requestText(info) {
  const bits = [];
  if (info.path.length) bits.push(`path ${info.path.join(', ')}`);
  if (info.query.length) bits.push(`query ${info.query.join(', ')}`);
  if (info.body.length) {
    const shown = info.body.map((name) => (info.required.includes(name) ? `${name}*` : name)).join(', ');
    bits.push(`body ${shown}`);
  } else if (info.whole) bits.push('body (whole)');
  if (info.rows.length) bits.push(`each row ${info.rows.join(', ')}`);
  return bits.join('; ') || '—';
}

function responseText(info) {
  const keys = [];
  let spread = false;
  for (const k of info.response) {
    if (k.startsWith('…')) spread = true;
    else if (k !== '…' && !keys.includes(k)) keys.push(k);
  }
  if (spread) keys.unshift("the record's own fields");
  return keys.join(', ') || '—';
}

function attach(rows) {
  for (const row of rows) {
    const info = describe(row.method, row.pattern);
    row.fields = info;
    row.request = requestText(info);
    row.response = responseText(info);
  }
  return rows;
}

function indexRoutePatterns() {
  const index = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');
  const out = [];
  for (const m of index.matchAll(/pathname\.match\(\/\^([^$]+)\$\//g)) {
    const http = 'POST';
    for (const pattern of patternsFrom(m[1])) out.push(`${http} ${pattern}`);
  }
  return out;
}

module.exports = { attach, describe, handlerSources, indexRoutePatterns, requestText, responseText, library, destructureFields, commandFields };
