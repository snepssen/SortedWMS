# SortedWMS

A working prototype of a reach-truck WMS for a chilled warehouse: yoghurt, cheese and (soon) protein drinks.

**Try the demo: https://snepssen.github.io/SortedWMS/**. It's a simulated shift that runs in the browser, on a computer or a phone.

To run it locally, open `index.html` in a browser. No install or server needed.

The demo site is rebuilt and published automatically on every push (`.github/workflows/pages.yml`): it runs the tests, wraps the page with `scripts/build-pages.js` and deploys to GitHub Pages. One-time setup: in the repo's **Settings → Pages**, set **Source** to **GitHub Actions**.

## What it does

### Auto
Drivers don't pick work from a menu. The moment they finish a job, the next one is on the handheld. The order:

1. **Urgent jobs:** flagged by the coordinator, or waiting longer than the "jump the queue" time (default 20 min). Auto-Shift jobs never jump the queue on their own.
2. **Job type,** in the coordinator's order. Default: Pick › Check & label › Receiving › Put-away › Auto-Shift.
3. **Nearest job** within the same type (can be switched off; then oldest first).

Each truck is set to the **categories its operator works** (yoghurt, cheese, protein drinks), and only gets jobs in those. Trucks can also be set to *Auto-Shift only* or *Paused*.

**No more than 2 reach trucks in one aisle** (adjustable). A third truck gets work elsewhere. A driver carrying a pallet towards a full aisle waits at the entry and is let in when a truck leaves.

**One-way aisles.** With the switch on, trucks are routed with the driving-direction signs. "Nearest job" means nearest by the route a truck may actually drive. A bay just behind the truck means going round, so a job further ahead in the same aisle comes first. The handheld says which end to enter an aisle from. The entry end of each aisle is a setting (it alternates by default).

### Stock rules
- **Pallets are identified by SSCC**, with item, batch, expiry date and quantity.
- **Categories never mix.** Every rack location carries a category from the location template. Put-away and Auto-Shift only use locations of the pallet's category.
- **First expired, first out.** Shipping orders take whole pallets with the earliest expiry first, and the oldest received first on a tie.
- **Minimum days left to ship, set by the manager per item.**
  - A pallet with fewer days left can't be picked. That's checked every day, so stock drops out on its own as it ages.
  - Short-dated pallets are put away on upper levels.
  - Raising the minimum swaps any planned picks onto good pallets.
  - The manager can let a single short pallet ship anyway (e.g. a customer accepts it).
- **Blocked stock never ships.** That covers pallets reported damaged, or expired on arrival. The coordinator can release them.

### Every job is as few inputs as possible
| Job | Inputs |
| --- | --- |
| Put-away, pick, Auto-Shift | 2 scans: the pallet (or its location), then the drop location |
| Check & label | 2 scans: the picked pallet, then the new shipping label once it's on |
| Receiving, supplier label + delivery list | **1 scan**: the bottom barcode (SSCC) |
| Receiving, 3-barcode supplier label | 3 scans, any order: top (item + count), middle (best-before + batch), bottom (SSCC) |
| Receiving, no usable label | batch → best-before → item → SSCC (4 scans) + 1 tap for quantity |

An SSCC or a known EAN is recognised whenever it's scanned, whatever field is next. If the label and the delivery list disagree, the driver is told and nothing is registered.

The scanner sends its own Enter. A wrong scan explains what's wrong and changes nothing.

Picking a different pallet with the **same item, batch and expiry** is accepted and swapped automatically. If a pallet is **missing or damaged**, the system allocates the next one by expiry date straight away. The problem job is held for the coordinator.

### Auto-Shift (rack-to-rack)
The system picks the slot, and the driver scans twice. Jobs are created when:

- **The location template changes.** Pallets now standing in a location of another category are relocated to their own category.
- **A pallet ships next.** For every item, the next pallet(s) out (by expiry) are brought down to ground level, so a pick never waits on a high reach. The number per item is a setting.
- **The same batch is apart.** A pallet standing alone is moved next to the rest of its item, batch and expiry, in the same bay level: positions 10, 40 and 70 between the rack legs.
- **A driver starts one.** An idle driver scans any pallet; the system picks the slot.

Put-away uses the same slotting rules from the start. It prefers a free position next to the same batch. It sends the next-out pallet low and later batches higher, to keep the ground free. Blocked stock goes to the top.

### Labels
Checking a picked pallet sends a 4×6" shipping label to the label printer at that shipping lane. The label is ZPL, the language most networked thermal label printers accept on port 9100. It carries the customer, order, item, batch, best-before date, a label barcode the driver scans to confirm it's on, and the GS1-128 SSCC.

## Files

| File | What it is |
| --- | --- |
| `src/engine.js` | The WMS rules: stock, locations, orders, receiving, dispatch, Auto-Shift. No dependencies; runs in a browser or Node. |
| `src/gs1.js` | Reads GS1-128 pallet labels, checks SSCC/GTIN check digits. |
| `src/labels.js` | ZPL shipping and pallet labels. |
| `index.html` | The demo: floor, handhelds, coordinator tabs, job queue, stock. |
| `test/` | Tests for every rule above. Run with `npm test` (Node 18+). |
| `scripts/build-pages.js` | Builds the demo site for GitHub Pages into `_site/` (`npm run build:pages`). |
| `docs/ROADMAP.md` | What it takes to go from this prototype to a standalone WMS. |

## Locations

Every location has two names, and both barcodes scan. The coordinator chooses which one the screens show.

**On the racks today:** `38-02-0-10` = aisle 38, bay 02, height 0, position 10.
- Odd bays are on one side of the aisle and even bays on the other, so bay 13 faces bay 14.
- Height 0 is the ground, 1–4 above it.
- Positions 10/40/70 run left to right between the rack legs.

**Proposed:** `AA03C2` = cell A, rack A, bay 03, level C, position 2 (the format used at Syncreon).
- The first letter is the warehouse cell. The second is the rack, lettered in a line across the cell: the racks facing each other across the first aisle are A and B, then C and D.
- Bays count 01–10 front to back on every rack, whatever the one-way direction, so the number tells you how deep in the aisle you are. Facing racks share bay numbers (AA07 faces AB07).
- Level A is the ground, up to E. Positions 1–3 run left to right between the rack legs.
- On the floor it's said "A3C2", with the cell assumed. The sticker scans the full `AA03C2`. A driver can also type the short form; the system takes the cell the truck is in.

Because both names scan, the racks can be relabelled one aisle at a time while everything keeps working. The Locations tab shows the old → new list.

The demo has aisles 31–38. The real list comes with the location table. The demo's items, customers, suppliers and stock are made up.
