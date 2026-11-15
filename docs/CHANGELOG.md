# Changelog

## Alerts answer again

Every `/api/notify` route answered "alerts is not defined": a merge had dropped the alerts service from the API and from the server that builds it. The bell, the alert settings, the test send and subscriptions work again.

A new test calls every route with an empty request and fails when one names something its file never declared. A second checks that every service the API takes is passed by the server, and every service the server takes is passed by `main()`. The API lists its routes for that test.

## Square, flat screens

Every screen has square corners, no drop shadows and stronger borders. Corners, depth and the code typeface are set once in `server/public/ui.css` (`--r`, `--shadow`, `--mono`); each screen reads them, so the look changes in one place. The greys are neutral and darker where they draw a border, in light and dark.

A button inverts for as long as it is pressed. Table headers, field captions, KPI captions and tags are small capitals; a tick box keeps the spelling of what it names. KPI numbers use the code typeface. An answer to a scan carries a solid edge in its own colour.

Printed labels and the command card keep their corners.

## JSON backups keep module state

JSON exports include persistent module tables alongside the original version-1 fields. Imports restore shop mappings, shipment retry state, alerts and other installed module data together with warehouse history. They clear newer module rows absent from the export, validate table and column names and binary values, and roll back on database constraint failures. Older version-1 exports still import without retaining unrelated newer module state. Photo bytes remain in `.db` and encrypted backups.

All restore formats invalidate existing sessions, MFA challenges and pairing attempts, including those saved in the backup. Users can sign in again with their restored credentials. Backup creation leaves current logins alone.

## Photos survive a backup restore

Plain, encrypted local and off-site backups include item image bytes as well as photo metadata. Restoring on a new machine works without the original photo directory, and the restored images survive another backup. Missing or damaged source images fail the backup before old copies are pruned. Restoring also clears the secondary warehouse cache so open screens use restored state immediately.

User audit exports remove password, token and similar fields inside nested objects and arrays as well as top-level fields.

## Restore the merged module wiring

Item photos, bills of materials and the user audit keep their engine installers, role permissions and office navigation together after the merges. Photos can be uploaded again, office users can build kits, and managers and administrators can open the audit export. The audit follows the selected warehouse and its local timezone; account sign-in events remain shared. Client logins without a linked client cannot read photos or statements.

The Pages build includes the BOM and photo metadata installers. Build checks load the emitted browser scripts, consume components into a kit and replay the result in a second page.

## A4 documents

Delivery notes, pick lists, packing lists and client statements can be A4 PDFs. The writer is in the program itself. Dates use the warehouse timezone. Label printers keep their text rules.

## Sendcloud on the module list

Sendcloud is in the core module list again, so its upgrade runs once and the registry tests match the modules on disk. The settings screen, the API, and the signed status webhook are wired on the server. A failed label still raises `shop.sync`.

## Shop sync alerts

Alerts accept `shop.sync`. A failed Shopify, WooCommerce or Etsy sync raises one, and the next successful sync for that shop raises one recovery. The note is not held for the digest or for quiet hours. A client login does not see it. Sendcloud uses the same type for a label that could not be bought.

The three shop connectors had left two copies of the tracking command, and the second copy had swallowed the alert command, so the server did not start. There is one tracking command again, and one hook after a command. The Dutch alert lines that the merge had dropped are back.

## Reorder list uses available stock

`/api/alerts/low-stock` and its CSV use the same available-stock check as the alerts: on hand minus allocated, held and reserved. The list and the CSV show both on hand and available. An item can now appear while stock is still in the building, if enough of it is already allocated, held or reserved. Previously the list compared on-hand stock only.

## Stacked pickup

With a stack height configured, Auto and Transfer (Move on the text terminal) can lift stacked pallets with transport jobs, including dock put-away. A pallet without a transport job still uses the pallet/location correction in Transfer. Each pallet keeps its own job and drop. After the first pallet, scan the next one where it stood. Scanning a location drops whichever pallet goes there, in any order. Scanning a pallet on the forks makes it the next drop.

How high a stack can be is set under Settings → Dispatch: **Highest stack on a truck (mm)**, the clearance of the truck or the dock door. Each pallet counts as the empty pallet (default 144 mm) plus its goods height from the item card, using the full goods height even for a part pallet. An item without a height can't go in a stack. The default is 0, which keeps one pallet at a time.

Under **Truck and door clearances**, enter a lower limit for a truck or for travel between two locations through a named door. Use `*` for all routes to or from one location. The warehouse limit still applies. A proposed stack must fit for either drop order, and an override drop is checked against its route.

Stock check shows the last five available movements for a scanned pallet, including pickups, handoffs and drops. New handoffs identify both trucks. Existing records appear when available.

Unstacking needs no scan: a pallet that was set down stays on the truck's load. When another truck scans it, that truck takes the job over with one scan. The first truck's screen then says "…123456 taken over by R2" and shows its next drop, so the pallet doesn't just vanish. A single pallet on the forks still can't be taken over.

## Cycle-count recount defaults

New warehouses recount when a count is off by more than 2 pieces or more than 5%. Each class can set its own quantity and percent. A blank class uses the warehouse numbers. Both at 0 still means every difference waits for a recount and approval.

Warehouses that already had both thresholds saved as 0 and 0% are moved to 2 and 5% by the ABC module upgrade `abc-recount-defaults`. That is the old default, which treated every difference as large. Set both back to 0 after the upgrade if every difference should wait.
