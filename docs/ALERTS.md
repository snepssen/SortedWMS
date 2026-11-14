# Low-stock alerts

The reorder list (`/api/alerts/low-stock` and `/api/alerts/low-stock.csv`) and the messages use one check: **available** stock, which is on hand minus allocated, held and reserved. An item is on the list when that available quantity is at or below its reorder point. The list and the CSV show on hand and available side by side. This used to compare on-hand stock, so an item can now be listed while pallets are still in the building if some of that stock is already allocated, held or reserved. The reorder point is the same field on the item.

Switching the module off stops new messages. The history stays.

## When a message is sent

For each item, in each warehouse:

- **stock.low** when available stock drops to the reorder point or below. The same level is not sent again until it recovers.
- **stock.recovered** when it has stayed above the reorder point for the quiet period (minutes, default 30). A dip back under the line before that ends does not send another low alert and does not send the recovery.
- A **reminder** while it stays low, after the reminder interval (hours, default 24).

Turn on **Also per pick face** to do the same for each pick face, using the quantity at that face and the item's reorder point. That is a separate alert from the warehouse total.

A client only ever gets the items that belong to them.

## Channels

- **Webhooks and the outbox.** The events are `stock.low`, `stock.recovered` and `stock.digest`. They are signed the same way as goods received and orders shipped. A webhook for one client only gets that client's messages.
- **Email.** SMTP with no extra packages: STARTTLS or SMTPS, and AUTH PLAIN or AUTH LOGIN. The password is saved beside the database in `alert-secrets.json` (or `SORTED_SMTP_PASSWORD`) and is never shown again, logged, or put in an export.
- **The bell.** Users with “See low-stock alerts” get an in-app note. A client login only sees its own.

Everything that is sent is written to the alert log on the Alerts page.

## Digest and quiet hours

**As it happens** sends at the moment the level crosses. **Daily digest** holds the stock alerts and sends one message at a time of day in the warehouse timezone, including daylight saving. Quiet hours (for example 22:00 to 06:00, local) hold instant alerts until the window ends. A test message, a backup failure and a shop sync note are not held.

## Who receives them

Warehouse addresses get every alert. Each client has its own addresses, and a client login can subscribe on the Alerts page for its own items only. The message text comes from the English and Dutch catalogs, in the warehouse language.

## Backup failures

When the off-site backups module is also on, a failed backup calls `alerts.raise` with `{ type: 'backup.failed', summary, site, at }`. The summary does not contain the passphrase or target credentials. The same channels send it, and it is journaled.

## Shop sync

Shopify, WooCommerce and Etsy call `alerts.raise` with `{ type: 'shop.sync', summary, site, at }` when a sync fails. The next successful sync for that shop sends one recovery, with the summary starting `Recovered:`. The note is not held for the digest or for quiet hours, and a client login does not see it. Sendcloud uses the same type for a label that could not be bought, once that module is on.
