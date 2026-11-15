# Health and figures

Three addresses tell someone outside whether an install is well. None of them changes anything.

| Address | Who | What |
| --- | --- | --- |
| `GET /api/health` | Anyone | `{ "ok": true, "auth": true }`. The server answers. Nothing else is given away. |
| `GET /api/health/figures` | A login or API key with `settings.read` | The figures below as JSON, and a list of problems in words. |
| `GET /api/metrics` | The same | The same numbers as plain text in the Prometheus format. |

For a monitor, make an API key with a role that has `settings.read` (see [CONNECTIONS.md](CONNECTIONS.md)) and send it with each request.

## The figures

```json
{
  "ok": true,
  "status": "ok",
  "problems": [],
  "at": 1794737364591,
  "uptimeSeconds": 5400,
  "journal": { "rows": 14904, "lastId": 14904, "lastAt": 1794737300000 },
  "snapshot": { "at": 1794737200000, "journalId": 14800, "bytes": 2188310, "behind": 104 },
  "database": { "bytes": 9361408 },
  "backup": { "on": true, "count": 14, "lastAt": 1794700000000, "lastBytes": 9300000, "ageHours": 10.4 },
  "webhooks": { "on": true, "count": 2, "waiting": 0, "failing": 0 },
  "printQueue": 0
}
```

- **journal**: how many changes have been written, and when the last one was.
- **snapshot**: when the state was last saved whole, how large it was, and how many changes have been written since. A snapshot is written every 200 changes.
- **database**: the size of the database file and its write-ahead log. Absent for a database in memory.
- **backup**: the local daily copies. `on` is false when `SORTED_BACKUPS=0`.
- **webhooks**: how many are registered, how many messages still wait, and how many keep failing.
- **printQueue**: labels waiting for a printer.

`status` is `ok` or `attention`. It is `attention` when `problems` has a line in it:

| Problem | When |
| --- | --- |
| There is no backup yet | Backups are on and the folder is empty |
| The newest backup is N hours old | The newest copy is more than 36 hours old |
| The last snapshot is N changes behind the journal | More than 1,000 changes since the last snapshot |
| N snapshots could not be read at the last start | The newest snapshot was damaged; an older one or the journal was used instead |
| Webhook N has failed M times in a row | Five or more failures in a row, with the last error |

Off-site backups, shop connections and low stock raise their own alerts when Alerts is on (see [ALERTS.md](ALERTS.md)); they are not repeated here.

## The metrics

```
# HELP sortedwms_up The server answers.
# TYPE sortedwms_up gauge
sortedwms_up 1
# HELP sortedwms_problems Things that need attention; see /api/health/figures for the words.
# TYPE sortedwms_problems gauge
sortedwms_problems 0
```

| Name | Meaning |
| --- | --- |
| `sortedwms_up` | Always 1 when it answers |
| `sortedwms_problems` | Number of lines in `problems` |
| `sortedwms_uptime_seconds` | Seconds since the server started |
| `sortedwms_journal_rows` | Changes in the journal |
| `sortedwms_journal_last_change_timestamp_seconds` | When the last change was written |
| `sortedwms_snapshot_timestamp_seconds`, `sortedwms_snapshot_bytes`, `sortedwms_snapshot_behind_changes` | The last snapshot |
| `sortedwms_database_bytes` | The database file and its log |
| `sortedwms_backups`, `sortedwms_backup_last_timestamp_seconds`, `sortedwms_backup_last_bytes` | Local backups |
| `sortedwms_webhooks`, `sortedwms_webhook_messages_waiting`, `sortedwms_webhooks_failing` | Webhooks |
| `sortedwms_print_queue` | Labels waiting for a printer |

A line is left out when there is nothing to measure: no backup lines with backups off, no webhook lines on an install without the outbox.

Two alerts cover most of it: `sortedwms_up` missing for a few minutes, and `sortedwms_problems > 0`.
