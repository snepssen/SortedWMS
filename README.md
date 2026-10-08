# SortedWMS

A working prototype of a reach-truck WMS for a chilled warehouse: yoghurt, cheese and (soon) protein drinks.

**Try the demo: https://snepssen.github.io/SortedWMS/**. It's a simulated shift that runs in the browser, on a computer or a phone.

To run it locally, open `index.html` in a browser. No install or server needed.

**Guided scenarios:** `walkthrough.html` has five selectable workflows. Each uses the existing engine with isolated, in-memory stock and a fixed demonstration clock. Switching or restarting a scenario starts fresh without resetting the free-play WMS.

- **Receiving to shipping (22 steps):** protein drinks through partitioning, receiving, Auto put-away, FEFO allocation, damage replacement, pallet change, check & label, shipping and batch trace.
- **Auto-Shift & partitioning (8 steps):** bring the next-out yoghurt pallet down, change its location's partition, then relocate it into yoghurt storage.
- **Manual work & corrections (17 steps):** choose one of two orders, pick and label it, put away a dock pallet, correct a misplaced pallet, and recover stock displaced onto the location-unknown list. A pending pick follows the corrected location.
- **Temperature & quality holds (12 steps):** receive a yoghurt pallet, record an out-of-range temperature, store it on hold, allocate eligible replacement stock, record a follow-up, and release it with a review reason. The example limits are demonstration values, not product requirements.
- **Batch recall & traceability (22 steps):** identify an earlier shipped recipient, hold ready and uncollected stock, replace an uncollected pick from another batch, catch a late receipt, and release the batch without clearing an independent temperature hold.

Switch between Admin, Office, Scanner and Station to inspect the same warehouse state, including jobs, stock, corrections and the audit. These are demonstration views, not access-controlled roles. Browser labels are generated but are not sent to a printer. Trailer loading verification and the broader refrigerated workflows remain future work.

For a local preview of the guided shift, run `npm run build:pages`, then serve `_site/` with a static HTTP server. The guided shift needs HTTP to load the example site configuration.

**Try the handheld and office screens: https://snepssen.github.io/SortedWMS/wms.html**. These are the real WMS screens with made-up stock. On Pages there's no server, so the WMS runs inside the browser and changes stay in that browser. A button scans whatever the handheld asks for, since a computer has no scanner.

To run the actual WMS (server, handheld screens, office screens), see [Running the WMS](#running-the-wms) below.

The demo site is rebuilt and published automatically on every push (`.github/workflows/pages.yml`): it runs the tests, wraps the page with `scripts/build-pages.js` and deploys to GitHub Pages. One-time setup: in the repo's **Settings → Pages**, set **Source** to **GitHub Actions**.

## What it does

### Auto
Drivers don't pick work from a menu. The moment they finish a job, the next one is on the handheld. The order:

1. **Urgent jobs:** flagged by the coordinator, or waiting longer than the "jump the queue" time (default 20 min). Auto-Shift jobs never jump the queue on their own.
2. **Job type,** in the coordinator's order. Default: Pick › Check & label › Receiving › Put-away › Auto-Shift.
3. **Nearest job** within the same type (can be switched off; then oldest first).

**Auto also handles whatever the driver scans.** Drivers scan pallets the screen didn't ask for all the time: the one in the way, one that looks wrong, one they recognise. Auto decides on the spot:

| The scanned pallet… | Auto says |
| --- | --- |
| has a job this truck can do (a pick, a ground move, a relocation) | **Pick it**: the truck takes that job, the pallet counts as picked up, and the job it was showing goes back to the queue |
| needs moving and has no job yet (wrong category location, or standing at the dock) | **Relocate it** / **Put it away**: a job is made and the truck takes it |
| has nothing to do | The truck **stays empty and holds it**: the next location scan records where it really stands (a correction transfer, nothing else to tap). Scanning it again moves it (Auto-Shift). *Move it* and *Let it go* buttons do the same by tap. |
| is lost (on the location-unknown list) | Held: one location scan puts it back on the map |
| is on another truck's job | Says whose; nothing changes |

While carrying, scanning a pallet or an item only shows stock information; scanning the pallet on the forks says where it goes, for when the driver has forgotten. An item number or EAN scanned in Auto shows the stock check. Auto does everything, so drivers rarely need another mode.

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
- **Temperature checks and quality holds:** Stock & trace in the office records a pallet's measured temperature, the limits used, an inspection note and the operator. Out-of-range readings create a separate quality hold. In-range follow-ups do not clear it; release requires a recorded reason and leaves independent damage blocks intact. Uncollected picks get replacement stock, and shipment checks eligibility again before removing any pallets. These are recorded spot checks, not continuous temperature monitoring or a physical quarantine-zone workflow.
- **Batch recalls:** The office's Batch recalls view previews stock and shipped recipients for an exact item and batch, then records a reasoned hold. The rule catches later receipts and opening-stock imports, replaces uncollected picks only with eligible stock, and blocks checking and final shipment even after labels were confirmed. A carried pallet may still be dropped safely. Affected orders remain in the report after replacement; shortage lines are not automatically refilled. Release records a decision without clearing temperature or damage holds. History survives replay and permits a new hold after release. Customer contact, return tracking, disposal and physical quarantine are not implemented; this is a demonstrator, not a certified recall system.

### Working without Auto
Each handheld has a mode bar. Auto is the default; the others are for when a driver works on their own:

| Mode | What the driver does |
| --- | --- |
| **Pick** | Scan (or tap) an order number. That order's picks then come one by one, still FEFO and still 2 scans each. |
| **Put-away** | Scan a pallet at the dock or a station. The system picks the slot with the normal slotting rules; scan the slot to drop. |
| **Transfer** | Scan a pallet, then the location it now stands at. That's it. |
| **Stock check** | Scan anything. A **pallet**: where it is and **where it belongs** (on the forks: where it's going; lost: where it was last). A **location**: what's in it. An **item** (item number, EAN or the label's GS1 barcode): every pallet of it with location and SSCC, next to ship first. The same check is in the office page. |

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

### Gloves on: the command card
The warehouse is chilled, so drivers wear gloves and the handheld's touch screen and small keys are a nuisance. Every button on the handheld therefore has a barcode on a **command card**: printed from the office (Settings → Command card), laminated, one per truck.

| Scan | Does |
| --- | --- |
| `CMD-AUTO` `CMD-PICK` `CMD-PUTAWAY` `CMD-TRANSFER` `CMD-STOCK` `CMD-PAUSE` | Switch mode (not with a pallet on the forks) |
| `CMD-MISSING` `CMD-DAMAGED` `CMD-BLOCKED` | Report a problem on the current job. **Scan twice** to confirm |
| `CMD-FULL` | Receiving: full pallet quantity |
| `CMD-DONE` | Receiving: close the delivery. **Scan twice** to confirm |
| `CMD-MOVE` | Move the held pallet |
| `CMD-CANCEL` | Undo whatever is half-done: a report waiting for its confirm, a held pallet, a transfer, a stock check |

Anything that changes stock is confirmed by scanning the same code again within 30 seconds; any other scan cancels it. There are no pop-ups: the screen shows an amber *Confirm* card, and the buttons work the same way (tap twice). A report that isn't possible right now (no job, pallet on the forks) says why straight away. A quantity other than a full pallet is typed on the keypad into the scan field, followed by Enter.

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
- **`/keys`** on a new scanner, once: a key test. It shows every key press (key, code, keyCode), whether the Back key reaches the page, and how scans arrive (as key presses or as pasted text, with the symbology prefix and the GS1 separator if the scanner sends them), with a summary to copy. It needs no server: on Pages it's `keys.html`.
- **`/card`**: the command card to print (also under Settings in the office).
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
| `src/barcode.js` | Code 128 as SVG, for the command card. |
| `server/index.js` | The WMS server: JSON API, handheld and office pages, clock tick, printing. |
| `server/store.js` | The database: command journal (audit trail), snapshots, replay on start. |
| `server/commands.js` | Every change that can be made, as a journaled command. |
| `server/site.example.json` | Example site set-up; copy and edit for the real warehouse. |
| `server/public/` | `handheld.html` (Android scanners), `admin.html` (office), `card.html` (the command card, at `/card`) and `keys.html` (key test for a new scanner, at `/keys`). |
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
