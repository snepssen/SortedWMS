# From prototype to a standalone WMS

The prototype holds the rules: Auto dispatch, aisle limits, categories, FEFO, receiving, check & label, Auto-Shift. A WMS the floor runs on also needs everything around those rules to be dependable. This is the path.

## 1. Load the real site (needs the location table)

- **Location table** → import as CSV: code (`38-02-0-10`), category, and anything blocked. Aisle, bay, side (odd/even), level and position follow from the code. Add each aisle's one-way direction and which cell it is in.
- **Relabelling (optional):** the proposed names (`AA03C2`: cell, rack, bay, level, position) are generated from the same table. New rack labels can be printed on the label printers, and both barcodes keep working during the changeover.
- **Item master** → item number, EAN/GTIN, category, cases per pallet, minimum days left to ship.
- **Opening stock** → SSCC, item, batch, expiry, quantity, location, blocked yes/no.

At this stage the prototype can run **next to the current WMS as an advisor**, without changing anything on the floor:
- which pallets stand in the wrong category after a template change
- which next-out pallets are up high
- which batches are spread over several bays
- how picks would be allocated by expiry date

That's a low-risk way to prove the rules on real data.

## 2. Server and database

The demo keeps everything in the browser. For real use:
- **Server + database** (for example Node.js with PostgreSQL) as the single source of truth. Every scan goes through the server, so two handhelds can never take the same pallet or slot.
- **Logins per driver and coordinator**, and an **audit log of every scan** (who moved which SSCC from where to where, when).
- **Batch traceability:** for a recall, answer "which customers got batch X" in one query.
- Backups, and a plan for when the server or Wi-Fi is down.

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

- What is printed in brackets under each of the 3 barcodes on the supplier label? For example (02)…(37)… on top, (15)…(10)… in the middle, (00)… at the bottom. That decides whether the scanner can read item, batch and date from it.
- Do suppliers send a pallet list (by email, EDI or on the delivery note) that could be loaded before the truck arrives? Then the bottom barcode alone is enough.
- Is the minimum days to ship per item only, or does it differ per customer?
- Which end does each aisle enter from, and is it the same for every aisle or alternating?
- Which aisles are in which cell, and which side of each aisle gets the first rack letter?
- Does each order have to be checked and labelled, or only some customers?
- How many reach trucks per shift, and who works which category?
