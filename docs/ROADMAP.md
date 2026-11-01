# Roadmap

SortedWMS is a warehouse system for any warehouse: a chilled distribution centre with reach trucks, a 3PL with clients and invoices, a small maker, or one person with a wall of bins at home. It is built and tested with made-up locations, items and stock. There is no plan here for deploying it at any particular site.

## Done

**The floor**
- Reach-truck dispatch (Auto), aisle limits, one-way aisles, categories, block stacks, Auto-Shift, ground-level next-out pallets, receiving with GS1 labels, check and label, trailer loading.
- Loose stock in bins and shelves: packs, mixed bins, put-away, pick, move and count, with the device camera as a scanner and label sheets for bins and items.
- Pick waves from a queue: whole pallets to the dock, whole boxes from the man-up, small picks from bins, an order dropped into the next wave when one is done or after a maximum wait.
- Floor roles by duty (inbound, picker, stock), and truck equipment (reach, man-up, EPT, cart) that decides which jobs a truck can take.
- The bin handheld, which keeps working without a connection.

**Stock**
- Batch and best-before on every pick, with a minimum of days left per item or per order, recalls that find every customer, and a near-best-before list with write-off.
- Serial numbers, piece by piece and on whole pallets.
- Stock checks that hold a location, item corrections under one correction number, and a daily stock-change report.
- Returns: booked against what shipped, graded restock, hold or scrap, a few at a time.
- Renaming locations, with the old codes still scanning.

**The office and the building**
- Guided location setup, presets, and switchable modules with simple screens.
- Clients, items, orders, ASNs, cartons and packing slips, delivery notes, kits, replenishment, more warehouses per install with transfers, available-to-sell, 3PL rate cards and invoices, client logins.
- Accounts with roles and editable permissions, TOTP, lockout, session timeouts, and the starting admin password changed at the first sign-in.

**Running it**
- `./start.sh` with no Docker and no packages, daily backups and restore, sample warehouses, a journal that is both the audit trail and the way state is rebuilt.
- A load test (`npm run load-test`); everyday work does not slow down as history grows.

## Next

In the order I would take them:

1. **Faster order imports.** A new order takes about 5 ms because the ground-level placement is re-planned after each one; a CSV of 2,000 orders takes about 9 s, and the server waits meanwhile. An import could plan once at the end, as a new command so that replaying old journals is unchanged.
2. **Connections.** Orders in from a shop or ERP (file drop or API), ASNs in from suppliers, and goods received and shipped back out. Today orders and ASNs come in by CSV or the API one at a time.
3. **Check on real devices.** The bin handheld opened with no connection at all on a phone, and the camera scanner with a real camera. Both are tested in a browser only.
4. **A4 documents as PDF.** Delivery notes, packing slips and loading lists print from the browser today.
5. **Smaller snapshots.** History stays in the saved state; with a year of it a snapshot takes about 0.16 s to write, every 200 changes. Old history could move out of the snapshot into its own table.

## Later

- PostgreSQL for the journal if many sites or heavy reporting ever need it.
- A native handheld app only if the web handheld's offline queue is not enough somewhere.

## Hardware it expects

- **Handheld scanners** running the web screens in the device browser, set to send Enter after each scan and to transmit the GS1 separator and symbology prefix. `/keys` checks a scanner's setup.
- **Label printers** taking ZPL over the network (TCP 9100), or the browser's print dialog.
- A phone or tablet camera works as a scanner on the bin handheld.

## Risks to say out loud

- A WMS that is down stops shipping. Whoever runs it needs hosting, backups (built in, but copy them elsewhere) and someone on call.
- Food traceability (batch, best-before, recall) carries legal weight. The journal is the audit trail; it is not optional.
- Moving to SortedWMS from another system depends on what that system can export.
