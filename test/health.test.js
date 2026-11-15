const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Store } = require('../server/store');
const { Printers } = require('../server/print');
const { createServer } = require('../server/index');
const { createAuth } = require('../server/auth');
const { createHealth, BACKUP_LATE_HOURS, WEBHOOK_FAILING } = require('../server/health');

const site = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'site.json'), 'utf8'));
const HOUR = 3600000;

function found(store, itemNo = 'W1001') {
  const code = Object.values(store.wh.locations).find((l) => l.kind === 'rack' && !l.sscc && !l.reservedBy && l.category === store.wh.items[itemNo].category).code;
  store.exec('createStock', { code, itemNo, qty: 5, reason: 'found' }, 'stock');
}

test('figures: the journal, the last snapshot and how far it is behind', () => {
  const store = new Store({ site });
  try {
    let t = 1_800_000_000_000;
    const health = createHealth({ store, now: () => t, started: t });
    const before = health.figures();
    assert.equal(before.ok, true);
    assert.equal(before.status, 'ok');
    assert.deepEqual(before.problems, []);
    assert.equal(before.backup.on, false, 'no backup service: nothing to report, and no complaint');
    assert.equal(before.webhooks.on, false);
    assert.equal(before.database.bytes, null, 'a database in memory has no file');

    found(store);
    found(store);
    t += 90_000;
    const after = health.figures();
    assert.equal(after.journal.rows, before.journal.rows + 2);
    assert.equal(after.snapshot.behind, after.journal.lastId - (after.snapshot.journalId || 0));
    assert.equal(after.uptimeSeconds, 90);

    store.snapshot();
    const snapped = health.figures();
    assert.equal(snapped.snapshot.behind, 0);
    assert.equal(snapped.snapshot.journalId, snapped.journal.lastId);
    assert.ok(snapped.snapshot.bytes > 1000);
  } finally { store.close(); }
});

test('problems: no backup, a stale backup and a webhook that keeps failing are said in words', () => {
  const store = new Store({ site });
  try {
    const t = 1_800_000_000_000;
    let list = [];
    let hooks = [];
    const health = createHealth({ store, now: () => t, backups: { list: () => list }, outbox: { list: () => hooks } });

    assert.deepEqual(health.figures().problems, ['There is no backup yet']);

    list = [{ file: 'sorted-a.db', bytes: 4096, at: t - 2 * HOUR }];
    const fresh = health.figures();
    assert.equal(fresh.status, 'ok');
    assert.equal(fresh.backup.count, 1);
    assert.equal(fresh.backup.ageHours, 2);

    list = [{ file: 'sorted-a.db', bytes: 4096, at: t - (BACKUP_LATE_HOURS + 4) * HOUR }];
    assert.match(health.figures().problems[0], /newest backup is 40 hours old/);

    list = [{ file: 'sorted-a.db', bytes: 4096, at: t - HOUR }];
    hooks = [
      { id: 1, waiting: 3, failures: WEBHOOK_FAILING - 1, lastError: 'timeout' },
      { id: 2, waiting: 7, failures: WEBHOOK_FAILING + 7, lastError: 'HTTP 500' },
    ];
    const f = health.figures();
    assert.equal(f.status, 'attention');
    assert.equal(f.webhooks.count, 2);
    assert.equal(f.webhooks.waiting, 10);
    assert.equal(f.webhooks.failing, 1, 'one failure is a blip; several in a row is a problem');
    assert.deepEqual(f.problems, [`Webhook 2 has failed ${WEBHOOK_FAILING + 7} times in a row: HTTP 500`]);
  } finally { store.close(); }
});

test('metrics: the same numbers as plain text a monitor can scrape', () => {
  const store = new Store({ site });
  try {
    const t = 1_800_000_000_000;
    const health = createHealth({ store, now: () => t, started: t - 60_000, backups: { list: () => [{ file: 'a.db', bytes: 2048, at: t - HOUR }] } });
    const text = health.metrics();
    assert.match(text, /^# HELP sortedwms_up /);
    assert.match(text, /\nsortedwms_up 1\n/);
    assert.match(text, /\nsortedwms_uptime_seconds 60\n/);
    assert.match(text, /\nsortedwms_problems 0\n/);
    assert.match(text, /\n# TYPE sortedwms_journal_rows counter\n/);
    assert.match(text, /\nsortedwms_backup_last_bytes 2048\n/);
    assert.match(text, new RegExp(`\\nsortedwms_backup_last_timestamp_seconds ${(t - HOUR) / 1000}\\n`));
    assert.doesNotMatch(text, /sortedwms_webhooks/, 'no webhook service: no webhook lines');
    assert.doesNotMatch(text, /sortedwms_database_bytes/, 'no file: no size');
    assert.ok(text.endsWith('\n'));
    for (const line of text.trim().split('\n')) assert.match(line, /^(# (HELP|TYPE) sortedwms_\w+ .+|sortedwms_\w+ -?\d+(\.\d+)?)$/, line);
  } finally { store.close(); }
});

test('over HTTP: /api/health stays public and bare; the figures and the metrics need settings.read', async () => {
  const store = new Store({ site });
  const auth = createAuth(store.db);
  auth.ensureDemoUsers();
  const server = createServer({ store, printers: new Printers({}), auth });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (p, cookie) => fetch(base + p, { headers: cookie ? { cookie } : {} });
  const login = async (username) => {
    const res = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password: `sorted-${username}` }) });
    return (res.headers.getSetCookie()[0] || '').split(';')[0];
  };
  try {
    const open = await get('/api/health');
    assert.equal(open.status, 200);
    assert.deepEqual(await open.json(), { ok: true, auth: true }, 'the public answer gives nothing away');
    assert.equal((await get('/api/health/figures')).status, 401);
    assert.equal((await get('/api/metrics')).status, 401);

    const picker = await login('picker');
    assert.equal((await get('/api/health/figures', picker)).status, 403);
    assert.equal((await get('/api/metrics', picker)).status, 403);

    const manager = await login('manager');
    const figures = await get('/api/health/figures', manager);
    assert.equal(figures.status, 200);
    const body = await figures.json();
    assert.equal(body.ok, true);
    assert.ok(body.journal.rows >= 0);
    assert.ok('behind' in body.snapshot);

    const metrics = await get('/api/metrics', manager);
    assert.equal(metrics.status, 200);
    assert.match(metrics.headers.get('content-type'), /^text\/plain/);
    assert.match(await metrics.text(), /\nsortedwms_up 1\n/);
  } finally {
    await new Promise((r) => server.close(r));
    store.close();
  }
});
