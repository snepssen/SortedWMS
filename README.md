# SortedWMS

A working prototype of a reach-truck WMS for a chilled warehouse: yoghurt, cheese and (soon) protein drinks.

**Try the demo: https://snepssen.github.io/SortedWMS/**. It's a simulated shift that runs in the browser, on a computer or a phone.

To run it locally, open `index.html` in a browser. No install or server needed.

**Try the handheld and office screens: https://snepssen.github.io/SortedWMS/wms.html**. These are the real WMS screens with made-up stock. On Pages there's no server, so the WMS runs inside the browser and changes stay in that browser. A button scans whatever the handheld asks for, since a computer has no scanner.

To run the actual WMS (server, handheld screens, office screens), see [Running the WMS](#running-the-wms) below.

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

### Working without Auto
Each handheld has a mode bar. Auto is the default; the others are for when a driver works on their own:

| Mode | What the driver does |
| --- | --- |
| **Pick** | Scan (or tap) an order number. That order's picks then come one by one, still FEFO and still 2 scans each. |
| **Put-away** | Scan a pallet at the dock or a station. The system picks the slot with the normal slotting rules; scan the slot to drop. |
| **Transfer** | Scan a pallet, then the location it now stands at. That's it. |
| **Find** | Scan a pallet or a location: where is it, what's in it, can it ship. |

**Transfer is for corrections.** When a pallet stands somewhere other than the system thinks (someone put it in the wrong spot, or the old system lost a move), the driver records where it really is, in two scans:
- If the system had another pallet in that rack spot, that one goes on the **location unknown** list in the office. Scanning it anywhere in Transfer mode puts it back on the map.
- A planned pick for the moved pallet now picks it from where it really stands. Planned Auto-Shift and put-away jobs for it are re-planned.
- If it now stands in a location of the wrong category, a relocation job is created.
- Every transfer is logged with who did it and when.

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
- **Older stock is buried in a block lane.** The newer pallets in front are moved to another lane by trucks that are otherwise idle.

Put-away uses the same slotting rules from the start. It prefers a free position next to the same batch. It sends the next-out pallet low and later batches higher, to keep the ground free. Blocked stock goes to the top.

### Block stacks (cheese crate pallets)
Crate pallets stand on the floor in block lanes, 6 high. The system knows the stacking order.
- Each lane holds one item. Up to two batches can share a lane (a setting; 1 = strict).
- A second batch goes in front of the first. If its best-before is the same or earlier, it ships first anyway, so the system prefers that over opening an empty lane. If it's later, it would bury older stock, so the system only does that when no lane fits better, and it flags the lane (⚠ on the board, a warning in the log).
- A lane is filled from the back and emptied from the front.
- A truck is only sent to the pallet it can actually lift: the top of the front-most stack. A pick for a buried pallet waits until the pallets in front of it have gone.
- **Buried older stock** can be handled two ways (a setting, both on by default):
  - *Dig out when idle:* Auto-Shift moves the newer pallets in front to another lane, never to one where they'd bury something else. These jobs only go to a truck with nothing else to do.
  - *Pick the newer first:* orders take the pallets standing in front of the older batch, so normal picking uncovers it. The customer gets the fresher pallet.
- FEFO applies to what can be reached: picks take the earliest best-before among the pallets trucks can actually lift.
- One truck per lane at a time (a setting).

### Process floor: pallets through stations
Some pallets go through a process before they ship or go back into storage:
- **Pallet change:** the hydraulic press flips the load onto a new pallet and back, then it's sealed with foil. A new pallet label prints at the station.
- **Crates off + foil:** crates removed, load wrapped.
- **Hole forming:** plate press (plate on) → warm room for a set time → plate press (plate off) → back into storage.

A process is a **route** of stations. It can be set on an order line ("pallet change before shipping") or started by the coordinator. Every step is tracked:
- **Moves** between storage, stations and shipping lanes are Auto jobs for the reach trucks: two scans, as always.
- **At a work station** the operator scans the pallet to start and scans it again when done. The station screen shows the SOP and a timer against the standard time. There's nothing to tick off.
- **In a dwell room** (the warm room) the system holds the clock. When the time is up it creates the move out and flags it urgent. There are no timers on team leaders' phones.
- **The process log** records every step: pallet, station, actual time and standard time. Each pallet keeps its own trail.

### Receiving desk (two operators)
For deliveries that need keyboard work, two people receive at a desk:
1. The person at the keyboard reads the call-out from the screen: **BATCH**, **PALLET**, **GS1**.
2. The person with the scanner scans that label.
3. Anything without a usable barcode (e.g. a quantity missing from the label) is typed in.

The pallet is registered as soon as it's complete, and its put-away goes to the trucks straight away. Deliveries can be announced for the desk or for a truck handheld at the dock.

### Labels
Checking a picked pallet sends a 4×6" shipping label to the label printer at that shipping lane. The label is ZPL, the language most networked thermal label printers accept on port 9100. It carries the customer, order, item, batch, best-before date, a label barcode the driver scans to confirm it's on, and the GS1-128 SSCC.

## Running the WMS

The server is the real thing: one source of truth for every handheld, desk and office screen. It needs Node.js 22.13 or newer and nothing else (no packages to install; the database is SQLite built into Node).

```
npm start              # an empty warehouse from server/site.example.json
npm run start:demo     # the same, with made-up stock, 4 handhelds and 2 orders to try it with
```

Then open, on the same network:
- **`/handheld`** on the Android scanners. Enter the handheld ID once; the scanner sends Enter after each scan. The screen keeps the scan field focused and hides the on-screen keyboard (⌨ brings it back).
- **`/admin`** in the office: floor overview, jobs (urgent, cancel, release), location template ranges, find, office transfers, location unknown list, stock per item, minimum days to ship, batch trace (which customers got batch X), orders, deliveries, imports from Excel/CSV, audit trail, dispatch settings, label printer status.
- **`/`** the demo simulation.

Settings, through environment variables:

| Variable | Default | |
| --- | --- | --- |
| `PORT` | 8080 | |
| `SORTED_DB` | `data/sorted.db` | The database file. Back this file up. |
| `SORTED_SITE` | `server/site.example.json` | The site: layout, cells, categories, template ranges, block lanes, stations, routes, desks, items, printer addresses. Read once, when the database is first created. |
| `SORTED_TOKEN` | none | If set, every API call needs it (handheld and office ask for it once). |

**How it keeps state.** Every change (each scan, each office action) is a command written to the database with its time and who did it, before the answer goes back. On restart the server loads the latest snapshot and replays the commands after it, which rebuilds exactly the same warehouse. That list of commands is also the **audit trail** in the office: who moved which pallet, from where to where, and when.

**Label printers.** Map each printer name to its address in the site file (`"LP-OUT-01": "10.0.4.51:9100"`). Labels are sent as ZPL over TCP port 9100 as soon as they're created; the office Settings tab shows what was sent and what failed.

## Files

| File | What it is |
| --- | --- |
| `src/engine.js` | The WMS rules: stock, locations, orders, receiving, dispatch, Auto-Shift. No dependencies; runs in a browser or Node. |
| `src/gs1.js` | Reads GS1-128 pallet labels, checks SSCC/GTIN check digits. |
| `src/labels.js` | ZPL shipping and pallet labels. |
| `server/index.js` | The WMS server: JSON API, handheld and office pages, clock tick, printing. |
| `server/store.js` | The database: command journal (audit trail), snapshots, replay on start. |
| `server/commands.js` | Every change that can be made, as a journaled command. |
| `server/site.example.json` | Example site set-up; copy and edit for the real warehouse. |
| `server/public/` | `handheld.html` (Android scanners) and `admin.html` (office). |
| `server/print.js` | Sends ZPL to network label printers. |
| `server/seed.js` | Made-up stock for `npm run start:demo`. |
| `server/api.js` | The API routes and screen views; used by the server, and in the browser on Pages. |
| `server/local.js` | The WMS running in the browser for GitHub Pages: the journal is kept in browser storage. |
| `index.html` | The demo: floor and block stacks, handhelds, process floor and receiving desk, coordinator tabs, job queue, stock. |
| `test/` | Tests for every rule above. Run with `npm test` (Node 18+). |
| `scripts/build-pages.js` | Builds the GitHub Pages site into `_site/`: the simulated shift, plus the handheld and office screens (`wms.html`) (`npm run build:pages`). |
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

**Location template by range.** Categories are set on a whole selection at once, not one location at a time: `AA01A1` → `AZ43F3` is cheese, `BB01A1` → `BZ43F3` is yoghurt. A range can be written in either naming, and partly: `AA` → `AD` means those whole racks, `31` → `34` whole aisles. The office sees a preview first (how many locations change, how many pallets will need to move), then applies it. Pallets left in the wrong category get Auto-Shift relocation jobs straight away.

The demo has aisles 31–38. The real list comes with the location table. The demo's items, customers, suppliers and stock are made up.
