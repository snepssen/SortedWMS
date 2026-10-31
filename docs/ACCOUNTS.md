# Accounts, roles and permissions

The server signs people in. The guided shift in the browser (`index.html`, GitHub Pages) does not: it has no database.

## Setup wizard

An administrator opens `/setup` after the first sign-in, and can open it again later. The wizard asks for a warehouse preset, which category features are on, and how locations are named. The hierarchy is Cell, Aisle, Bay, Position, Height. Skip a level the building does not have. Numbers, letters, letters-and-numbers, and words are all text. A colour is a word such as Red.

A new warehouse starts with temperature zones, lot and expiry, FEFO, and high-value plates off. Choosing a preset turns on the set that preset carries. The chilled distribution centre preset turns on temperature, lot, expiry and FEFO, and leaves high-value plates off. The high-value preset turns PAL and MASTER plates on. The example site applies `chilled-dc` and then sets `highValueSecurity`, so the demo seed can still issue plates. Unset flags stay off.

Worked examples the wizard can load:

- `01-03-12-2-04`
- `A-03-B12-2-D`
- `Garage-Left-Shelf3-Box2-Top`

Presets: chilled distribution centre (chilled and frozen zones), high-value, home garage, small maker.

## Run it

Node.js 22.13 or newer. No packages to install. macOS and Linux use the same commands.

```
npm test
npm run start:demo
```

Open `http://localhost:8080/login`. `npm start` builds the example site without the made-up pallets; the accounts are still created.

| Variable | Default | |
| --- | --- | --- |
| `SORTED_DB` | `data/sorted.db` | Warehouse journal, users and sessions. |
| `SORTED_ADMIN_USER` | `admin` | First administrator, only if that username does not exist yet. |
| `SORTED_ADMIN_PASSWORD` | `sorted-admin` | At least 8 characters. Printed at startup only when the default is still in use. |
| `SORTED_DEMO_USERS` | on | `0` skips the five demo accounts below. |
| `SORTED_TOKEN` | unset | Optional. A request with header `x-token` is a service administrator and does not need a cookie. |

Passwords are stored as scrypt hashes (`scrypt$N$r$p$salt$hash`). The session cookie is `sorted_session`, HttpOnly, 12 hours. The database stores the SHA-256 of the token, not the token.

## Demo accounts

Created when missing. Existing passwords are not reset.

| Username | Password | Role | Lands on |
| --- | --- | --- | --- |
| `admin` | `sorted-admin` | Administrator | Users, roles, settings, audit |
| `manager` | `sorted-manager` | Manager / supervisor | KPIs, staff, tasks, exceptions, locations, holders |
| `office` | `sorted-office` | Office | Clients, orders, inbound, outbound, reports |
| `tech` | `sorted-tech` | Technical | Auto-sort, location defaults, label series, hardware |
| `inbound` | `sorted-inbound` | Inbound | Receiving and put-away |
| `picker` | `sorted-picker` | Picker | Pick waves: pallet, box and bin picks; mezzanine; kitting |
| `stock` | `sorted-stock` | Stock / inventory | Counts, corrections, creating and deleting stock, checks, transfers, replenishment, Auto-Shift |

Floor roles follow the job, not the vehicle. Inbound, pickers and stock control can each be on foot or on a truck; what the truck is (reach truck, man-up, EPT, cart) is set on the truck. The technical account is the WMS technical department, not maintenance. Users who had the old Operator role became Pickers, and Machine operators became Inbound, the first time the server starts after the upgrade.

## What each role is for

- **Administrator.** Users, which role they have, the permission list for every role except administrator (that role always has every permission), system settings, and the audit log (warehouse journal plus sign-in events).
- **Manager / supervisor.** Shift KPIs, staff, task assignment, exceptions, approvals, and movement history for a person or a license plate.
- **Office.** Clients, items, ASNs, orders, packing notes, reports, and label printing.
- **Technical.** Auto-sort strategy and rules, default dimensions and capacity by location type, and the license-plate prefix and padding. Equipment and scanner/printer mode sit underneath that. This is not the maintenance role.
- **Inbound.** Receives deliveries (a full pallet is issued `PAL` and `MASTER`) and puts stock away: pallets into the racks, loose stock into bins. A truck with the inbound duty only gets receiving and put-away jobs.
- **Picker.** Picks in waves: whole pallets straight to the dock, whole boxes and opened-box pieces on a man-up, bin picks on an EPT or cart, all dropped at the post-pick lane. Also mezzanine picks and VAL/kitting. A truck with the picking duty only gets picks, check and label, and moves to the dock.
- **Stock / inventory.** Cycle counts, quantity corrections, creating and deleting stock with a reason, stock checks, location lookups, transfers, replenishment and Auto-Shift. A truck with the stock duty only gets Auto-Shift, counts and moves back into storage. Wedge, manual entry, and simulated scan all use the same field.
- **Trucks.** The manager sets each truck's duty (every job, inbound, picking, or stock and inventory) and equipment on the Floor screen. Assigning a person gives the truck that person's duty. A reach truck and a man-up reach every level; an EPT only takes jobs at ground level and no Auto-Shift; a cart takes no truck jobs. Process-station moves that are not for an order count as stock work. The demo trucks start on every job.

The floor screens (`/admin`, `/handheld`, `/station`, `/desk`, `/loading`) stay. After sign-in the cookie is sent with them. A role that lacks the permission gets 403 rather than a silent change.

## Permissions

`server/permissions.js` is the list. A route names the permission it needs. Anything not listed needs `wms.read` for a GET and `wms.write` for a change. Inbound, picker and stock do not have `wms.write`; their posts are listed one by one (`scans.execute`, `counts.execute`, and so on).

An administrator edits a role under **Roles**. The last active administrator cannot be demoted or disabled.

## Clients, items, locations, license plates, labels

- A **client** is the owner of the goods (Dairy Co, Noord Kaas, Pulse Drinks, and a kitting demo in the example). Archiving blocks new items, receipts and orders for that owner. Stock already in the building stays.
- An **item** has a unit of measure, pallet quantity, optional GTIN / barcodes, and length, width, height and weight of the stored unit (one pallet). Remove is refused once the item has stock, an order or a holder line; archive it instead.
- A **location** can be a zone, aisle, rack, level, bin, mezzanine pick face, block lane, or a **virtual** location. Virtual roles are consolidation (`CONSO00`, the `conso00` example) and staging (`STAGE01`). Capacity is height, width, depth (millimetres) and maximum weight (kilograms). Footprint may rotate; height may not. Missing numbers are not treated as zero. Codes are stored in uppercase.
- A **license plate** is the holder. The series are `PAL` (full pallet), `MASTER` (the parent label), `ST` (stock), `INB` (inbound) and `OUT` (outbound). The id is the prefix plus a zero-padded counter, default `PAL0000001`. Each warehouse keeps its own counters. A counter only moves forward, so a number stays retired once it has been issued. ST, INB and OUT track lower-value quantities and work with high-value plates off. A received full pallet is issued both a PAL and a MASTER when high-value plates are on, with that PAL under the MASTER.
- **Consolidation** at a virtual location such as `CONSO00` keeps one MASTER that already parents the PAL plates in the move. The earliest MASTER, by sequence number, survives. The consolidation step can name another of those MASTER plates and that one survives instead. Every other source MASTER is closed: status `retired`, `supersededBy` the survivor, and a `retired` movement. The surviving plate is one of the MASTER numbers already on the pallets. A retired number stays retired. A PAL with no MASTER, or a MASTER that does not already parent one of these PAL plates, is refused. The printed MASTER label lists the child PAL numbers under the MASTER id. An SSCC can still be printed as a second barcode.
- A **movement** stores the person, the plate, from-location, to-location, time, quantity and the event (`received`, `labelled`, `moved`, `consolidated`, `retired`, `picked`, `shipped`). Managers open this under History.
- **Labels** barcode the plate id. An SSCC is an optional second barcode. ZPL is the printer payload. `/api/labels/:id/html` is the page you print or save as PDF.
- **Kitting** is a bill of materials on a VAL station. A work order, or a sales-order line that names the kit, consumes one unit from each scanned component plate and counts the finished unit. The demo kit is a laptop plus an EU power plug.
- **Mezzanine picks** against a unit line reduce that line. The quantity leaves the pick face and waits, staged on the order, for the packing bench.
- **Packing** opens an `OUT` carton, scans the staged pick into it, and closes the carton with length, width, height and weight. Closing prints the OUT label and a packing slip. Dispatch moves the closed cartons to the order's shipping lane.
- **Pick faces** store a minimum, a trigger and a maximum. The default tops the face up to the maximum and splits that quantity off the source plate. A face set to whole-pallet mode moves one full pallet instead. Plate numbers use 7 digits unless that series sets a different pad (1 to 12).
- **Returns** are received against an order at a virtual return, quarantine or staging location, then graded restock, quarantine or scrap.
- **Warehouses.** `MAIN` is the site in the original journal. Further sites keep their own stock and plate counters. The header switches site. A user's site list, when set, is the only sites they can open. An empty list means every site. Administrators can open every site. A transfer ships onto the virtual `IN-TRANSIT` location. The destination receives it, and only then is the source plate closed. A refusal puts the quantity back on that same plate.
- **Sign-in.** An administrator reset sets a temporary password and signs the person out. The next sign-in must change it. Optional TOTP: the setup screen shows the secret once. Five wrong passwords lock the account for 15 minutes. Idle sessions end after 30 minutes (`SORTED_IDLE_MS` overrides that).
- **Feeds.** `/api/reports/availability.csv` and `/api/reports/availability.json` are the available-to-sell quantities. A reorder point on the item raises a low-stock row.
- **Billing.** A client rate card sets storage (pallet-day, location-day or cubic-metre-day), inbound (pallet or line), outbound (order, line or carton), VAL per unit, a monthly minimum, and a flat fee for dedicated space. Each charge is a flat rate, or volume tiers: all units at the band the quantity falls in, or graduated bands. The top of a band is included, and the last band has no upper limit. By default the tier quantity is the calendar month across versions; a card can count each version on its own instead. A season is a date range or months that repeat every year. It replaces the rate (the default), adds a percent, or adds a fixed amount per unit. Two seasons cannot cover the same charge on the same day. Dates are the warehouse's local days, including daylight saving. A billing period named with dates includes the first and last local day. Storage that crosses a season or a new rate card is split at local midnight. An inbound, outbound or VAL event uses the card in effect at its own time. The monthly minimum comes from the card in effect on the last day and is the full amount unless that card says to prorate it by the days in the month. Dedicated space is a cell, an aisle, a bay, a position, a height, or the whole building, charged once per invoice. `/api/reports/billing.html` is the printable invoice and `/api/reports/invoice.csv` is the same invoice with a tier, season and version on each line. Saving a card is `tariff.write` (office and manager by default) and the journal stores the user. A version is read-only once a later version exists, or once its effective date is before today in the warehouse timezone.
- **Place.** Each warehouse has a country (a two-letter code) and an IANA timezone. The setup wizard and Warehouse settings save them. The journal shows times in that timezone.
- **Client login.** The client role sees only the client named on the user. They add items (SKU, description, unit, dimensions, weight, barcode text, and food, frozen or high-value when the warehouse features allow it), edit them, and deactivate them. They see their stock and their orders. Client items are active immediately unless Warehouse settings require approval (`items.approve`, office and manager). Changes are journaled with the user.
- **Guided location setup.** The setup wizard asks how many sections (buildings or parts of one), whether each is rack or shelf, then per section how many aisles, bays, positions and levels, each with "what do you want to call it?". The first name sets the pattern: `01` gives 01, 02, 03; `A` gives A, B, C; `R1` or `Shelf 1` gives R1, R2 or Shelf1, Shelf2; `Floor, Middle, Top` names every one. One of something with no name stays out of the code, so a single wall of bins at home can be `Shelf1-Bin3-Top`. Racks become pallet slots and shelves become bins, each with its own default size. A later section can copy the one before. The answers are kept, so the wizard opens where it left off. The old range editor stays under Advanced.
- **Bins and small parts.** Loose stock on a bin or mezzanine location needs no license plate: a quantity per item, kept per batch and best-before when lot and expiry are on. A bin holds several items unless it is set to one item only. An item has a base unit (piece) and packs that hold a whole number of them (box = 100, case = 1000). Any quantity can be given in a pack, and a pack barcode puts in a whole pack. Put away, pick, move and count each have their own permission (`inbound.write`, `picks.execute`, `moves.execute`, `counts.execute`). A put that would pass the bin's weight limit is refused when the item has a weight per unit. A pick for an order takes the earliest best-before first and waits for packing under the bin code. A count that differs corrects the bin and keeps an adjustment. Loose stock counts in availability, low stock and pick-face top-ups, and a bin with stock cannot be deleted. The Bins screen finds an item, a pack barcode or a bin.
- **Renaming locations.** Locations → Rename locations gives one location a new code, or every location whose code starts the same way (`Garage-` to `G-`), with a preview first. Stock, plates, bin stock, open truck jobs, wave picks, checks and the post-pick setting follow; history keeps the codes as they were. The old codes keep scanning, so old labels work until the new ones are up; the screen links to the new labels and lists the old codes to drop once they are. Locations made on site (setup wizard, profiles, by hand) can be renamed; racks from the site file, the dock and the in-transit location cannot. A new location cannot take an old code that still scans, and the setup wizard skips them. `locations.write` (manager, technical, administrator).
- **Bin handheld.** `/bins` is a phone-sized screen for work on foot, with one scan field (and the camera button). The modes follow the person's permissions. **Pick**: wave bin picks one at a time in walking order; the picker claims each so nobody else walks to it, scans the bin, scans the item and confirms; "Not enough here" holds the bin for a stock check and the pick is planned again from other stock; "Later" gives it back. With pick waves off, Pick takes an order number and walks its piece lines bin by bin. **Put away**: scan an item or a box barcode, enter how many, and the screen suggests a bin that already holds the item and has room, else an empty one; scan the bin. **Move**: from bin, item, how many, to bin. **Count**: blind; scan the bin, then each item and its count; "Bin done" asks about anything booked there that was not counted. **Check**: scan a bin or an item.
- **Pick waves.** Racks and bins are worked by different people: a reach truck never gets a put-away, consolidation or pick job in a bin or on the mezzanine. A wave splits each piece line by the item's smallest pack. Whole packs are case picks from rack pallets for the man-up or high-level order picker, earliest best-before first; the pallet stays in its slot. The remainder is a bin pick for EPT and cart pickers when the bins hold all of it. When they do not, the man-up takes the remainder too and opens a box, so a small pick is never split between a bin and a box. 5100 screws in boxes of 5000: 5000 to the man-up, 100 from a bin. Open tasks reserve their stock for later waves; what neither can supply is listed as short. Office and manager plan and cancel waves (`orders.write`). The man-up confirms on **Case picks** and the bin picker on **Bins** (`picks.execute`), scanning the pallet, its slot or the bin. The picks are then packed by scanning the pallet SSCC or the bin code.
- **Stock checks and corrections.** Office, pickers and stock control can hold a location for a check, for example when a customer reports the wrong item from an order picked there. Until it is checked, nothing there is picked, allocated, transferred or moved out, and open wave picks there are planned again from other stock. Stock control releases it (stock is right) or corrects the item: the wrong pallet, plate or bin line goes out and the counted quantity of the right item comes in at the same location, on a new ST plate for a pallet or plate, as loose stock in a bin. The old plate number is retired. Stock control can also create or delete any item in any quantity, with a reason. `/api/reports/stock-changes.csv` lists every change by hand per day (counts, corrections, created and deleted stock) with the location, pallet, plate, person and correction number, so a wrong item shows as −64 of one item and +64 of the other under one correction.
- **Modules.** A site leaves out what it does not use, under "What do you use?" in the setup wizard: reach trucks (Auto dispatch, Auto-Shift, aisle limits, block lanes), pick waves, kitting, process stations, clients, 3PL billing (needs clients) and more warehouses. A warehouse that never chose has everything on; a preset chooses for a new one (home garage and small maker leave out trucks, waves and the 3PL parts). While a module is off its screens disappear, its changes are refused over the API with a message saying so, and its reads still answer. With trucks off nobody gets a truck job and Auto-Shift plans nothing; switching them off waits until no truck job is under way. **Simple screens** gives whoever signs in one short menu (bins and shelves, receiving, items, orders, packing, stock control, reports, users, settings, as far as their role allows), for a person running the place alone.
- **Location profiles.** The technical role edits profiles and bulk-creates locations. Built-in profiles are high value, food/chilled, frozen, low value, and home/small maker. A profile sets storage (shelf/box stack, rack, or block stack), temperature, security, a put-away note, label text and capacity. A shelf needs a box count, a volume or a weight. A rack needs positions per level plus height, width and weight. A block stack needs a floor footprint and a stack height in pallets. Put-away refuses a move past that capacity, or records a warning when the profile says warn.
- **One shipment.** Staging a mixed order builds one delivery note and one load manifest for its pallets and cartons. Each holder is scanned onto the load. Dispatch is refused until every one is confirmed. Status runs staged, loaded, dispatched.
- **Backup.** `GET /api/backup` and `POST /api/backup` export and import the journal, snapshots and accounts. Only an administrator can do that.

## Still not in this version

- The GitHub Pages build does not check passwords. `app.html` there is a labelled demo with a role picker.
- No password-reset email. The administrator hands over the temporary password.
- No ERP or EDI connection. Orders and stock still come in through the API or CSV.
- Serial numbers are not tracked.
- Real scanners and printers are the wedge and the ZPL transport. There is no DataWedge installer and no USB claim. Without them, the camera scans in Chrome and Edge, and label sheets print on A4 or Letter stickers or a small label printer (see HARDWARE.md).
- A seasonal override replaces the unit rate for those days. It does not scale the tier table. The card can add a percent or a fixed amount instead.
- The offline queue is on the handheld page. The role views in `/app` need a connection.
