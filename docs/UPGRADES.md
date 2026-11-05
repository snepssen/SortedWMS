# Data upgrades

The SQLite file remembers how far its schema has come.

- **Core** steps live in `server/upgrades.js`. The version is `schemaVersion` in the `meta` table.
- **Module** steps are declared on each module (`upgrades: [{ version, id, up(db) }]`). The version is `moduleVersion:<id>` in `meta`, so two modules can both have a version 1.
- A step runs when its version is newer than the one recorded. Running the server again, or importing the same backup again, does not apply it a second time.
- Steps still have to be safe to run twice. Importing a backup from before a step can rewind the counter, and the step then runs again. Use `CREATE TABLE IF NOT EXISTS` and `INSERT … ON CONFLICT DO NOTHING`.

## When they run

1. **Start.** `Store` opens the file, applies anything pending, then loads the snapshot and replays the journal.
2. **Backup import.** After the imported rows are committed, the same runner runs. An old export has no `schemaVersion`, so it catches up.

The start log looks like this when there is something to do:

```
Data upgrades: backup sorted-2026-11-05-101500.db before 3 step(s), schema 0 -> 3
Data upgrades: core 1 baseline
Data upgrades: core 2 extra-sites
Data upgrades: core 3 upgrade-log
Data upgrades: now at schema 3
```

When the file is already current, the log is one line: `Data upgrades: schema 3, nothing pending`.

## Backup and rollback

Before the first pending step, a file database is copied with `VACUUM INTO` into the backup folder (`data/backups`, or `SORTED_BACKUP_DIR`). An in-memory database has nothing to copy; the log says so.

Every pending step runs in one transaction, and each one is written to `upgrade_log`. If a step throws, the transaction is rolled back. The database is as it was before this run, and the copy taken beforehand stays in the backup folder. The error names the step and the backup file.

Nothing here deletes warehouse data. A module that is switched off keeps its rows; its upgrade steps still run, so the data is current when the module is switched on again.

## Adding a step

Add an object to `CORE_STEPS`, or to a module's `upgrades` list, with the next integer version. Do not renumber a step that has already shipped: a database that recorded version 3 will skip anything numbered 3 or lower.

```javascript
{
  version: 4,
  id: 'holder-note',
  up(db) {
    const have = db.prepare('PRAGMA table_info(journal)').all().some((c) => c.name === 'note');
    if (!have) db.exec('ALTER TABLE journal ADD COLUMN note TEXT');
  },
}
```

Module steps are collected from each module and handed to the same runner. The file format is in [MODULES.md](MODULES.md).
