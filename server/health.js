/*
 * Health figures: what someone watching an unattended install needs to know.
 *
 * /api/health stays public and says only that the server answers.
 * /api/health/figures (settings.read) gives the figures below as JSON, with a
 * list of problems in words. /api/metrics gives the same numbers as plain text
 * in the Prometheus exposition format, for a monitor that scrapes.
 *
 * Nothing here changes anything, and nothing is kept: every figure is read
 * when it is asked for.
 */
'use strict';

const fs = require('node:fs');

const HOUR = 3600000;
// The daily copy runs once a day; a day and a half without one is a miss.
const BACKUP_LATE_HOURS = 36;
// A snapshot is written every 200 changes; far more than that means it stopped.
const SNAPSHOT_LATE = 1000;
// A webhook backs off after each failure; this many in a row is no longer a blip.
const WEBHOOK_FAILING = 5;

function createHealth({ store, backups = null, outbox = null, now = () => Date.now(), started = now() } = {}) {
  const one = (sql) => { try { return store.db.prepare(sql).get() || {}; } catch (e) { return {}; } };

  function fileBytes(file) {
    if (!file || file === ':memory:') return null;
    let total = 0;
    for (const f of [file, `${file}-wal`]) {
      try { total += fs.statSync(f).size; } catch (e) { /* no such file: nothing to add */ }
    }
    return total;
  }

  function figures() {
    const t = now();
    const problems = [];

    const j = one('SELECT COUNT(*) AS n, MAX(id) AS last, MAX(t) AS at FROM journal');
    const journal = { rows: Number(j.n || 0), lastId: Number(j.last || 0), lastAt: j.at ? Number(j.at) : null };

    const s = one('SELECT journal_id AS id, t, LENGTH(state) AS bytes FROM snapshots ORDER BY id DESC LIMIT 1');
    const snapshot = s.t
      ? { at: Number(s.t), journalId: Number(s.id), bytes: Number(s.bytes || 0), behind: Math.max(0, journal.lastId - Number(s.id)) }
      : { at: null, journalId: null, bytes: null, behind: journal.lastId };
    if (snapshot.behind > SNAPSHOT_LATE) problems.push(`The last snapshot is ${snapshot.behind} changes behind the journal`);
    const skipped = (store.snapshotSkipped || []).length;
    if (skipped) problems.push(`${skipped} snapshot${skipped === 1 ? '' : 's'} could not be read at the last start; the journal filled the gap`);

    const database = { bytes: fileBytes(store.file) };

    let backup = { on: false, count: 0, lastAt: null, lastBytes: null, ageHours: null };
    if (backups) {
      let list = [];
      try { list = backups.list(); } catch (e) { problems.push(`The backup folder cannot be read: ${e.message}`); }
      const newest = list[0] || null;
      backup = {
        on: true,
        count: list.length,
        lastAt: newest ? Math.round(newest.at) : null,
        lastBytes: newest ? newest.bytes : null,
        ageHours: newest ? Math.round(((t - newest.at) / HOUR) * 10) / 10 : null,
      };
      if (!newest) problems.push('There is no backup yet');
      else if (backup.ageHours > BACKUP_LATE_HOURS) problems.push(`The newest backup is ${Math.round(backup.ageHours)} hours old`);
    }

    let webhooks = { on: false, count: 0, waiting: 0, failing: 0 };
    if (outbox) {
      let list = [];
      try { list = outbox.list(); } catch (e) { problems.push(`Webhooks cannot be read: ${e.message}`); }
      const failing = list.filter((w) => w.failures >= WEBHOOK_FAILING);
      webhooks = {
        on: true,
        count: list.length,
        waiting: list.reduce((n, w) => n + (w.waiting || 0), 0),
        failing: failing.length,
      };
      for (const w of failing) problems.push(`Webhook ${w.id} has failed ${w.failures} times in a row: ${w.lastError || 'no answer'}`);
    }

    const wh = store.wh || {};
    const printQueue = Array.isArray(wh.printQueue) ? wh.printQueue.length : 0;

    return {
      ok: true,
      status: problems.length ? 'attention' : 'ok',
      problems,
      at: t,
      uptimeSeconds: Math.max(0, Math.round((t - started) / 1000)),
      journal,
      snapshot,
      database,
      backup,
      webhooks,
      printQueue,
    };
  }

  /** The same figures as plain text, one number per line, for a monitor that scrapes. */
  function metrics() {
    const f = figures();
    const lines = [];
    const put = (name, help, value, type = 'gauge') => {
      if (value === null || value === undefined || Number.isNaN(Number(value))) return;
      lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`, `${name} ${Number(value)}`);
    };
    const seconds = (ms) => (ms ? Math.round(ms / 1000) : null);
    put('sortedwms_up', 'The server answers.', 1);
    put('sortedwms_problems', 'Things that need attention; see /api/health/figures for the words.', f.problems.length);
    put('sortedwms_uptime_seconds', 'Seconds since the server started.', f.uptimeSeconds);
    put('sortedwms_journal_rows', 'Changes in the journal.', f.journal.rows, 'counter');
    put('sortedwms_journal_last_change_timestamp_seconds', 'When the last change was written.', seconds(f.journal.lastAt));
    put('sortedwms_snapshot_timestamp_seconds', 'When the last snapshot was written.', seconds(f.snapshot.at));
    put('sortedwms_snapshot_bytes', 'Size of the last snapshot.', f.snapshot.bytes);
    put('sortedwms_snapshot_behind_changes', 'Changes written since the last snapshot.', f.snapshot.behind);
    put('sortedwms_database_bytes', 'Size of the database file and its write-ahead log.', f.database.bytes);
    put('sortedwms_backups', 'Local backups kept.', f.backup.on ? f.backup.count : null);
    put('sortedwms_backup_last_timestamp_seconds', 'When the newest local backup was made.', seconds(f.backup.lastAt));
    put('sortedwms_backup_last_bytes', 'Size of the newest local backup.', f.backup.lastBytes);
    put('sortedwms_webhooks', 'Webhooks registered.', f.webhooks.on ? f.webhooks.count : null);
    put('sortedwms_webhook_messages_waiting', 'Messages not yet delivered to a webhook.', f.webhooks.on ? f.webhooks.waiting : null);
    put('sortedwms_webhooks_failing', 'Webhooks that have failed several times in a row.', f.webhooks.on ? f.webhooks.failing : null);
    put('sortedwms_print_queue', 'Labels waiting for a printer.', f.printQueue);
    return `${lines.join('\n')}\n`;
  }

  return { figures, metrics };
}

module.exports = { createHealth, BACKUP_LATE_HOURS, SNAPSHOT_LATE, WEBHOOK_FAILING };
