# Changelog

## Shopify

A warehouse can connect one or more Shopify shops, per client or for the whole building. Paid orders that are not yet fulfilled come in by a signed webhook or by polling, through the same intake as every other system, so sending one twice does not book it twice. Shop SKUs map to items, including a suggestion when the SKU or barcode already matches. Available stock (on hand minus allocated, held and reserved, then minus a per-shop buffer) is sent back, once per burst, and waits longer each time Shopify asks the warehouse to slow down. A shipped order sends its tracking number and carrier back. The access token and webhook secret are saved beside the database and are never shown again. See [connectors/SHOPIFY.md](connectors/SHOPIFY.md).

## Stacked pickup

With a stack height configured, Auto and Transfer (Move on the text terminal) can lift stacked pallets with transport jobs, including dock put-away. A pallet without a transport job still uses the pallet/location correction in Transfer. Each pallet keeps its own job and drop. After the first pallet, scan the next one where it stood. Scanning a location drops whichever pallet goes there, in any order. Scanning a pallet on the forks makes it the next drop.

How high a stack can be is set under Settings → Dispatch: **Highest stack on a truck (mm)**, the clearance of the truck or the dock door. Each pallet counts as the empty pallet (default 144 mm) plus its goods height from the item card, using the full goods height even for a part pallet. An item without a height can't go in a stack. The default is 0, which keeps one pallet at a time.

Under **Truck and door clearances**, enter a lower limit for a truck or for travel between two locations through a named door. Use `*` for all routes to or from one location. The warehouse limit still applies. A proposed stack must fit for either drop order, and an override drop is checked against its route.

Stock check shows the last five available movements for a scanned pallet, including pickups, handoffs and drops. New handoffs identify both trucks. Existing records appear when available.

Unstacking needs no scan: a pallet that was set down stays on the truck's load. When another truck scans it, that truck takes the job over with one scan. The first truck's screen then says "…123456 taken over by R2" and shows its next drop, so the pallet doesn't just vanish. A single pallet on the forks still can't be taken over.

## Cycle-count recount defaults

New warehouses recount when a count is off by more than 2 pieces or more than 5%. Each class can set its own quantity and percent. A blank class uses the warehouse numbers. Both at 0 still means every difference waits for a recount and approval.

Warehouses that already had both thresholds saved as 0 and 0% are moved to 2 and 5% by the ABC module upgrade `abc-recount-defaults`. That is the old default, which treated every difference as large. Set both back to 0 after the upgrade if every difference should wait.
