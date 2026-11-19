# Cut-over

How to move a warehouse onto SortedWMS in one evening. The daily inbox ([CONNECTIONS.md](CONNECTIONS.md)) is for orders and ASNs after you are live. This page is the one-time load: locations, items, stock on hand, and orders that are still open.

Do the dry run on the afternoon before. Do the real load when the old system has stopped sending.

## What each import takes

Send `{ "rows": [ … ] }` to the route. The same body with `"dryRun": true` (or `?dry=1` on the address) changes nothing and returns `{ "dryRun": true, "accepted": …, "refused": …, "errors": [ … ] }`. A row that would be refused is named in `errors`. The warehouse and the journal stay as they were.

| Route | A row needs | Dry run reports |
| --- | --- | --- |
| `POST /api/import/locations` | `code`, and any of `category`, `blocked`, `check` | A code that is not a location, or a check digit that is not two digits |
| `POST /api/import/items` | `itemNo`, `name`, `category`, `palletQty` | A missing item number, an item that already exists, or a row the warehouse would refuse |
| `POST /api/import/stock` | `code`, `itemNo`, `qty`, and the pallet's `sscc`, `batch`, `expiry` when you have them | A row that cannot be put away, named with its location |
| `POST /api/import/orders` | `orderId`, `customer`, `lane`, `itemNo`, and `pallets` or `units` | An order that cannot be opened. One bad line refuses that whole order and the other orders still count |

An item that already exists is left as it is, unless the row carries a `value`, which updates that amount only. Locations only update a code that is already on the map. Generate or build the locations before the location import.

## The afternoon before

1. Take a backup: `./start.sh backup`. Confirm the file is in `data/backups`, or that the off-site copy succeeded.
2. Dry-run locations, then items, then stock, then open orders. Fix the spreadsheet until `refused` is 0. A dry run does not reserve the numbers, so two dry runs of the same file say the same thing.
3. Agree the moment the old system stops. Orders taken after the export, and receipts after the stock count, will not be in the file.

## The evening

1. Stop the old system from sending orders, receipts and stock changes. Write down the last order number and the last receipt.
2. Take another backup.
3. Import for real, in this order, without `dryRun`: locations, items, stock, open orders. Each answer is the normal import result, not the dry-run report. Orders come back as `{ "added", "errors" }`. Items come back as how many were taken.
4. Check the floor against the file. Item count, a few pallet locations, and the open-order list. A number that does not match is a reason to restore the backup and stop, not to type over it.
5. Point the other system at SortedWMS ([CONNECTIONS.md](CONNECTIONS.md)) and send one order as a test. Receive one delivery if the night has one.
6. Keep the backup from step 2 until the next day's work has gone through without a correction you cannot explain.

Restore, if you need it, is in [BACKUPS.md](BACKUPS.md). Everyone signs in again after a restore.
