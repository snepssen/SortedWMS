# Changelog

## Stacked pickup

A reach truck can lift pallets that stand on each other in one go. Each pallet keeps its own job and drop. After the first pallet, scan the next one where it stood. Scanning a location drops whichever pallet goes there, in any order. Scanning a pallet on the forks makes it the next drop.

How high a stack can be is set under Settings → Dispatch: **Highest stack on a truck (mm)**, the clearance of the truck or the dock door. Each pallet counts as the empty pallet (default 144 mm) plus its goods height from the item card, scaled for a part pallet. An item without a height can't go in a stack. The default is 0, which keeps one pallet at a time.

Unstacking needs no scan: a pallet that was set down stays on the truck's load. When another truck scans it, that truck takes the job over with one scan. The first truck's screen then says "…123456 taken over by R2" and shows its next drop, so the pallet doesn't just vanish. A single pallet on the forks still can't be taken over.

## Cycle-count recount defaults

New warehouses recount when a count is off by more than 2 pieces or more than 5%. Each class can set its own quantity and percent. A blank class uses the warehouse numbers. Both at 0 still means every difference waits for a recount and approval.

Warehouses that already had both thresholds saved as 0 and 0% are moved to 2 and 5% by the ABC module upgrade `abc-recount-defaults`. That is the old default, which treated every difference as large. Set both back to 0 after the upgrade if every difference should wait.
