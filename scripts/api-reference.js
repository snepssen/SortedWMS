#!/usr/bin/env node
/*
 * Builds docs/API.md: every route the server answers, the permission it needs,
 * the roles that have that permission on a new install, and the module that
 * owns it. Nothing is written by hand, so it cannot go stale:
 *
 *   npm run api-reference        write docs/API.md
 *
 * test/api-reference.test.js fails when docs/API.md is not what this builds.
 *
 * The routes come from three places, which together are all of them:
 *   - the API's own route list (server/api.js)
 *   - the permission rules (server/permissions.js)
 *   - the routes the server answers itself: sign-in, users, keys, webhooks
 *     (server/index.js), read from its source
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const fields = require('./api-fields');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'API.md');

function collect() {
  const { Store } = require('../server/store');
  const { Printers } = require('../server/print');
  const { createApi } = require('../server/api');
  const { RULES, DEFAULTS, ROLE_IDS, PERMISSIONS, permissionFor } = require('../server/permissions');
  const registry = require('../modules/registry');

  const site = JSON.parse(fs.readFileSync(path.join(ROOT, 'server', 'site.blank.json'), 'utf8'));
  const store = new Store({ site });
  let listed;
  try { listed = createApi({ store, printers: new Printers({}) }).routes(); } finally { store.close(); }

  const seen = new Map();
  const add = (method, pattern) => {
    if (!pattern.startsWith('/api/') || !['GET', 'POST'].includes(method)) return;
    const key = `${method} ${pattern}`;
    if (!seen.has(key)) seen.set(key, { method, pattern });
  };
  for (const r of listed) add(r.method, r.pattern);
  for (const [method, pattern] of RULES) add(method, pattern);
  const index = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');
  for (const m of index.matchAll(/req\.method === '(GET|POST)' && url\.pathname === '(\/api\/[^']+)'/g)) add(m[1], m[2]);

  const permName = Object.fromEntries(PERMISSIONS);
  const roles = ROLE_IDS.filter((id) => DEFAULTS[id]);
  const rows = [...seen.values()].map(({ method, pattern }) => {
    // A sample address for this pattern, to ask the same questions the server asks of a real one.
    const sample = pattern.replace(/:(\w+)/g, 'x').replace(/\.\*$/, '');
    const access = permissionFor(method, sample);
    const module = registry.routeModule(method, sample) || null;
    const who = access.public ? [] : roles.filter((id) => (DEFAULTS[id] || []).includes(access.permission));
    return { method, pattern, public: access.public, permission: access.permission || null, permissionName: permName[access.permission] || null, roles: who, allRoles: who.length === roles.length, module };
  });
  rows.sort((a, b) => a.pattern.localeCompare(b.pattern) || a.method.localeCompare(b.method));
  fields.attach(rows);
  return { rows, roles };
}

function group(pattern) {
  return pattern.split('/')[2].replace(/\..*$/, '');
}

function build() {
  const { rows } = collect();
  const groups = new Map();
  for (const row of rows) {
    const g = group(row.pattern);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(row);
  }
  const lines = [
    '# API reference',
    '',
    'Every route the server answers. This page is built from the route tables by `npm run api-reference`; a test fails when it is out of date. Do not edit it by hand.',
    '',
    `${rows.length} routes: ${rows.filter((r) => r.method === 'GET').length} read, ${rows.filter((r) => r.method === 'POST').length} change something. ${rows.filter((r) => r.public).length} need no sign-in.`,
    '',
    '## How to call it',
    '',
    '- **Sign in** with the session cookie from `POST /api/login`, or send an API key as `Authorization: Bearer swk_…` or `X-Api-Key: swk_…`. Keys are made under Connections; see [CONNECTIONS.md](CONNECTIONS.md).',
    '- **Bodies and answers are JSON**, except the routes ending in `.csv` or `.pdf`.',
    '- **A refusal** answers `400` with `{ "error": "…" }` in plain words. `401` means not signed in, `403` means the role lacks the permission, and `404` on a read means no such route or a module that is off.',
    '- **A route in a module that is off** answers `404` on a read and `403` on a change. See [MODULES.md](MODULES.md).',
    '- **Sending the same change twice**: a change with an `x-request-id` header is carried out once; the second answer is the first again.',
    '',
    '## Reading the tables',
    '',
    '- **Permission** is what the route needs. A role\'s permissions can be edited, so **Roles** shows a new install. An administrator always has every permission.',
    '- **Module** is the module that must be on. Empty means the route is always there.',
    '- `:id` and the like are parts of the address you fill in. **Request** names them again under `path`.',
    '- **Request** is read from the handler and from the command or function it calls. A star means the command refuses to run without that field (`req`). `query` is the query string. `body (whole)` means the handler accepts the JSON as it stands and names no keys. `each row` is a field of a row inside `rows`.',
    '- **Response** is the JSON keys of a successful answer, read from the handler or from the function it returns directly. `the record\'s own fields` is a spread of the stored record. `the handler\'s value` means the code builds the answer without naming the keys in an object. `the command result` means the route returns whatever the command returns. A refusal is `{ "error" }` on every route and is not repeated here. `csv` and `pdf` are files, not JSON.',
    '',
  ];
  for (const g of [...groups.keys()].sort()) {
    lines.push(`## ${g}`, '', '| Method | Route | Permission | Roles | Module | Request | Response |', '| --- | --- | --- | --- | --- | --- | --- |');
    for (const r of groups.get(g)) {
      const perm = r.public ? 'none, no sign-in' : `\`${r.permission}\``;
      const who = r.public ? 'anyone' : r.allRoles ? 'every role' : r.roles.join(', ') || 'administrator';
      const cell = (text) => String(text || '—').replace(/\|/g, '/').replace(/\n/g, ' ');
      lines.push(`| ${r.method} | \`${r.pattern}\` | ${perm} | ${who} | ${r.module || ''} | ${cell(r.request)} | ${cell(r.response)} |`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

if (require.main === module) {
  const text = build();
  fs.writeFileSync(OUT, text);
  console.log(`Wrote ${path.relative(ROOT, OUT)} (${text.split('\n').filter((l) => /^\| (GET|POST) /.test(l)).length} routes)`);
}

module.exports = { build, collect, OUT, fields };
