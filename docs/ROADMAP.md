# From prototype to a standalone WMS

The prototype holds the rules: Auto dispatch, aisle limits, categories, FEFO, receiving, check & label, Auto-Shift. A WMS the floor runs on also needs everything around those rules to be dependable. This is the path.

## 1. Load the real site (needs the location table)

- **Location table** → import as CSV: code (`38-02-0-10`), category, and anything blocked. Aisle, bay, side (odd/even), level and position follow from the code. Add each aisle's one-way direction and which cell it is in.
- **Relabelling (optional):** the proposed names (`AA03C2`: cell, rack, bay, level, position) are generated from the same table. New rack labels can be printed on the label printers, and both barcodes keep working during the changeover.
- **Item master** → item number, EAN/GTIN, category, cases per pallet, minimum days left to ship, and whether it's stored in racks or block stacks.
- **Block lanes** → lane, number of stacks, stack height, category.
- **Stations and routes** → each station (machine, operators, standard minutes, SOP text) and each process route (stations in order, warm-room times).
- **Opening stock** → SSCC, item, batch, expiry, quantity, location, blocked yes/no.

At this stage the prototype can run **next to the current WMS as an advisor**, without changing anything on the floor:
- which pallets stand in the wrong category after a template change
- which next-out pallets are up high
- which batches are spread over several bays
- how picks would be allocated by expiry date

That's a low-risk way to prove the rules on real data.

## 2. Server and database

**Done (`server/`):**
- A server as the single source of truth. Every scan goes through it, so two handhelds can never take the same pallet or slot.
- SQLite database with an append-only journal: every change with its time and operator. It is both the audit trail and how the state is rebuilt after a restart (snapshots every 200 changes keep restarts fast).
- Handheld screens for Android scanners (Auto, Pick, Put-away, Transfer, Find) and the office screens.
- Batch traceability: "which customers got batch X" on the Stock & trace tab.
- Location template by range, correction transfers with a location-unknown list, imports for the location table, items and opening stock.
- ZPL to network label printers.

**Still to do:**
- Backups of the database file, and a plan for when the server or Wi-Fi is down.
- If many sites or heavy reporting come later: the same journal on PostgreSQL.

**Done since the prototype:**
- Sign-in with scrypt password hashes and cookie sessions. Six roles (administrator, manager / supervisor, office, technical, operator on foot, machine operator on a truck or order picker). See [ACCOUNTS.md](ACCOUNTS.md).
- License plates PAL, MASTER, ST, INB and OUT, with a counter per warehouse that only moves forward. Consolidation reuses the earliest MASTER already on those pallets unless the operator names another of them; the other source MASTER plates are retired and their numbers stay retired. The printed MASTER label lists the child PAL numbers. Food features and high-value plates start off and come on through a preset. Virtual locations include consolidation and staging. Every move records the person, plate, from, to, time and quantity.
- Scanner input as a keyboard wedge, manual entry, or a simulated scan. Printers as ZPL over the network, a browser print/PDF page, or a simulated device. The handheld keeps scans while offline and sends them in order later; a refusal holds the scans behind it.
- Unit sales lines picked on a mezzanine, kit work orders that consume a bill of materials, carton packing with dimensions, weight, an OUT label and a packing slip, and dispatch of those cartons.
- Pick-face minimum, trigger and maximum, with a replenishment move in the machine-operator queue.
- Returns received against an order and graded restock, quarantine or scrap.
- More than one warehouse per install, a site switcher, per-user site access, and transfers between sites. Plate counters stay on the site that issued them.
- Administrator password reset with a forced change, optional TOTP, lockout after failed sign-ins, and an idle session timeout.
- Available-to-sell CSV and JSON, low-stock alerts, and a 3PL billing export (pallet-days and moves).
- The GitHub Pages build of `/app` is a labelled demo with a role picker. It does not check passwords.
- One dispatch document for a mixed pallet and carton order, with load scans and the statuses staged, loaded and dispatched.
- Replenishment to a maximum in units, splitting the source plate, plus a whole-pallet mode. Default plate padding is 7 and is set per series.
- Inter-warehouse transfer through an in-transit location. A refusal returns the original plate.
- A per-client 3PL tariff and printable period invoices. Backup and restore of the journal and accounts.
- Volume tiers (all units at the tier rate, or graduated bands), seasonal overrides and surcharges, and rate-card versions. A period that crosses a boundary is split at midnight UTC. The invoice names the tier, season and version on each line. Older versions stay read-only in the journal.

## 3. Hardware

- **Android handheld scanners.** The handheld screens can run as a web app in the device browser. Set the scanner to:
  - send Enter after each scan
  - transmit the GS1 FNC1 separator (ASCII 29) and the symbology prefix, so a GS1-128 pallet label is read in one scan

  A native app is only needed if offline scanning in Wi-Fi dead spots becomes a requirement.
- **Label printers:** ZPL over the network (TCP port 9100), one per shipping lane, plus one at receiving for pallets that arrive without a usable SSCC label.
- **Network printers (A4):** delivery notes and loading lists as PDF.

## 4. Connections

- **Orders in:** from the customer order system or ERP (file drop or API).
- **Deliveries in:** advance shipping notices from suppliers, so receiving can check SSCCs against what was announced.
- **Out:** goods received and shipped back to finance/ERP.

## 5. Pilot, then switch over

1. A pilot on one category, e.g. protein drinks when they arrive: a new category with no history to migrate.
2. Run it in parallel with the current system for a few weeks, and compare stock counts daily.
3. Move yoghurt and cheese over once the counts agree.

## Risks to say out loud

- A WMS stops shipping when it's down. It needs hosting, backups and someone on call, not just a developer.
- Food traceability (batch, expiry, recall) carries legal weight. The audit log isn't optional.
- Getting data out of the current system (locations, items, stock) depends on what it can export, and on the company's permission.

## Questions for the floor

- The ZT421 printers: 203 or 300 dpi, which label size is loaded, and direct thermal or with a ribbon? (The configuration label shows the first.)
- Does A-ware Packaging send a delivery list (ASN) with batch and best-before per SSCC? Their labels carry neither as a barcode, so without a list both are typed.
- For each supplier, does the label count cases or consumer units? A-ware Packaging counts pots (960 = 80 cases), A-ware Kruibeke counts trays (96).
- Can the MC9401s be set up with one DataWedge profile for the WMS (Enter after each scan, GS1-128 on)? Run `/keys` on one to check.

- What is printed in brackets under each of the 3 barcodes on the supplier label? For example (02)…(37)… on top, (15)…(10)… in the middle, (00)… at the bottom. That decides whether the scanner can read item, batch and date from it.
- Do suppliers send a pallet list (by email, EDI or on the delivery note) that could be loaded before the truck arrives? Then the bottom barcode alone is enough.
- Is the minimum days to ship per item only, or does it differ per customer?
- Which end does each aisle enter from, and is it the same for every aisle or alternating?
- Which aisles are in which cell, and which side of each aisle gets the first rack letter?
- Does each order have to be checked and labelled, or only some customers?
- How many reach trucks per shift, and who works which category?
- How many block lanes and how many stacks deep? Can a lane be worked from both ends (that would let older stock out without digging)?
- The process steps not seen yet: which stations, standard times, warm-room times, and does a pallet change always need a new pallet label?
