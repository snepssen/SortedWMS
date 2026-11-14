# Off-site backups

The server keeps a copy of the database in `data/backups`, once a day, newest 14 (`SORTED_BACKUP_KEEP`, `SORTED_BACKUP_DIR`, or `SORTED_BACKUPS=0` to turn the whole local copy off). That copy is a plain database file until you choose otherwise. The **Off-site backups** module encrypts a copy of the same kind and sends it somewhere else.

Open **Backups** as an administrator (or the same page on the simple menu). The page shows the last success or failure, the next run, the files on each target, and **Back up now**.

Switching the module off stops new copies. It does not delete ones already sent.

## What is in the file

The encrypted file is the whole database, taken with SQLite `VACUUM INTO` while the floor keeps working. It includes users and their **password hashes**, the same as the local `.db` copy and the JSON export from Settings. It does not include the passphrase, and it does not include S3 or WebDAV credentials.

Treat a backup like the live database. Anyone who can decrypt it can read the hashes.

## The local daily copy

Three choices, on the Backups page:

| Local daily copy | What is written in `data/backups` |
| --- | --- |
| Plain file | `sorted-….db`, as before. This is the default. |
| Encrypted file | `sorted-….db.enc`, with the same passphrase as the off-site copy. The file is decrypted once after it is written, to check it. |
| Off | Nothing new. |

The plain file stays the default for an install that has no encrypted target, and it stays on after you add a target. The page offers the other two choices only after a target is configured **and** one upload has been verified (size and hash, and the test decrypt when that is on). Choosing one does not delete anything.

If the last target is removed, or there has never been a verified upload, the plain copy runs again even if the saved choice is Encrypted or Off. That way an upgrade, or a target that is not ready, cannot leave the warehouse with no backup.

**Remove old plain copies** deletes `sorted-….db` in the backup folder. It does nothing unless you confirm, on the page or with `{ "confirm": true }` on `POST /api/offsite/prune-plain`. Encrypted files, and the live database, are left in place. Nothing in the schedule calls this.

## Passphrase

AES-256-GCM. The key comes from the passphrase with scrypt (N = 16384, r = 8, p = 1), and every file has its own salt and IVs. A short sealed check opens only with the right passphrase. If that opens and the database does not, the file was altered.

The header starts with `SWBK` and a version byte. Version 1 is the only one this release reads.

The passphrase comes from one of these, and the environment wins:

- `SORTED_BACKUP_PASSPHRASE`
- A passphrase saved under Backups

The saved passphrase is written to `offsite-secrets.json` next to the database, mode `0600` where the system allows it. It is not in the warehouse journal, not in the JSON export, not in the encrypted file, and not in the log. The page says whether one is set. It never shows it again. Leave the field blank to keep the saved one. **Remove saved passphrase** clears only the saved one.

A passphrase needs 8 to 1024 characters. It is not accepted on the command line, so it does not show up in the process list.

## Schedule and retention

The clock is the warehouse timezone, including daylight saving.

- **Daily.** A time such as `02:30`. One run after that time each local day. A failure is tried again after 15 minutes, until one succeeds.
- **Every few hours.** A whole number from 1 to 168, counted from the last success.

Retention keeps the newest file in each of the last N local days, the last N ISO weeks, and the last N calendar months. A file that fills any of those stays. The counts are set on the page (0 to 100). The stamp in the file name is the warehouse's local time: `sorted-2026-11-14-023000.db.enc`.

## Targets

No extra packages. Credentials are saved next to the passphrase, with the same never-shown-again rule. A blank credential field leaves the saved one in place.

1. **Folder.** A path on this machine: a disk, a USB stick, or a mounted network share. The file is written under a temporary name and renamed into place.
2. **S3.** Any store that speaks Signature Version 4: AWS S3, Backblaze B2, MinIO, Wasabi. Give the endpoint, bucket, region, an optional prefix, and whether the store wants path-style URLs (MinIO usually does). The access key and secret go in the headers, not in the URL. HTTP is allowed for a store on the warehouse network; use HTTPS everywhere else.
3. **WebDAV.** For example Nextcloud. The address must be HTTPS. The user and password are sent as basic authentication.

After each upload the file is read back. The size and the SHA-256 have to match. Tick **Decrypt once after upload** to also open the copy with the passphrase and check that it is a database. That is off unless you turn it on.

## Restore

**On the page.** Restore on a file downloads it, decrypts it, copies the current database aside, and replaces the warehouse. Data upgrades then run, the same steps as a start or a backup import. People may need to sign in again.

**On the command line.** With SortedWMS stopped:

```
SORTED_BACKUP_PASSPHRASE='…' ./start.sh restore sorted-2026-11-14-023000.db.enc
```

The passphrase is the environment variable, or the one saved in `offsite-secrets.json` beside the database. It is not printed. A plain `.db` file still restores the old way. After the file is in place, the data upgrades run before the command finishes. Start SortedWMS again to use it.

A new machine does not have the saved passphrase. Set `SORTED_BACKUP_PASSPHRASE` there.

## Failures

A failed run is written to the off-site log and to the audit log. The text does not include the passphrase or credentials. The page shows the last failure.

When the **Alerts** module is installed and switched on, the same failure calls `alerts.raise` with `{ type: 'backup.failed', summary, site, at }`. The summary is the same redacted text. If Alerts is missing or switched off, the failure is still journaled and nothing else is sent.
