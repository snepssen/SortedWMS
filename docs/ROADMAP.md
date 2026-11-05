# Roadmap

SortedWMS is an open-source warehouse system for any warehouse: a chilled distribution centre with reach trucks, a 3PL with clients and invoices, a small maker, or one person with a wall of bins at home. It sets its own standard, and is built and tested with made-up locations, items and stock only.

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
- Cycle-count recount defaults: a new warehouse posts a difference of 2 pieces or 5% or less at once. Each class can set its own numbers. Warehouses still saved at 0 and 0% are moved to those defaults once.

**Running it**
- `./start.sh` with no Docker and no packages, daily backups and restore, sample warehouses, a journal that is both the audit trail and the way state is rebuilt.
- Versioned data upgrades on start and on backup import: core steps, then each module's own steps, a backup taken first, a log of every step, and a rollback if a step fails. See [UPGRADES.md](UPGRADES.md).
- A module manifest per feature in `modules/`: id, dependencies, conflicts, permissions, routes, menu entries, settings and its own data upgrades. A third-party folder (`SORTED_MODULES`) is loaded the same way, with no network install. See [MODULES.md](MODULES.md).
- Per warehouse, a module that is off answers 404 on a read and 403 on a write, drops out of the menus and the handheld, and hides its permissions. Enabling offers to turn dependencies on. Disabling checks what still needs it and keeps the data. Managers and administrators have a Modules page. Presets, including a small 3PL, map onto the modules.
- ABC cycle counts: class A/B/C by velocity or value, a daily list in the warehouse timezone, blind counts, and a recount plus supervisor approval before a large variance changes stock.
- A Reports page for the office and a client-scoped copy: stock, ageing, movements by holder, volumes, cycle time, pick and count accuracy, location use, and best-before when lots are on. Each table filters and exports CSV in the warehouse timezone.
- A split replenishment leaves an explicit return task for the machine operator, shown on the handheld and in the task list, instead of putting the remainder away at the moment of the drop.
- A load test (`npm run load-test`); everyday work does not slow down as history grows, and an import of 1,000 orders takes milliseconds.
- Categories added one by one, like items; a new building starts with one, General.
- Items without a best-before (tools, hardware), received without one even where lots and expiry are on.
- Bins refilled straight from a rack pallet, keeping its batch and best-before.
- The demo on GitHub Pages: a distribution centre for four clients worked by bots in every role on the real screens, on a clock you can pause or speed up. Each role's card points at what just happened that concerns it; take over any role and work it yourself.
- One light/dark setting (Auto, Light or Dark) for every screen, kept in the browser; Auto follows the device.

**Connections** ([CONNECTIONS.md](CONNECTIONS.md))
- API keys per system, with a role, for one client or all; revoked at once.
- Orders and ASNs in: one intake, JSON or CSV, safe to send twice, the sender's reference carried through; and a drop folder.
- Confirmations out: goods received, orders shipped with pallets, cartons, batches and serials, returns, stock adjustments, in a numbered log a system reads from where it left off, or pushed to it by signed webhooks or an outbox folder.

## Next

In order of priority:

1. **Check on real devices.** The bin handheld opened with no connection at all on a phone, and the camera scanner with a real camera. Both are tested in a browser only.
2. **A4 documents as PDF.** Delivery notes, packing slips and loading lists print from the browser today.
3. **Smaller snapshots.** History stays in the saved state; with a year of it a snapshot takes about 0.16 s to write, every 200 changes. Old history could move out of the snapshot into its own table.

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
