# Roadmap

SortedWMS is an open-source warehouse system for any warehouse: a chilled distribution centre with reach trucks, a 3PL with clients and invoices, a small maker, or one person with a wall of bins at home. It sets its own standard, and is built and tested with made-up locations, items and stock only.

Last reviewed 15 November 2026, after a full function check and a comparison with OpenWMS.org. Both are in [OPENWMS-COMPARISON.md](OPENWMS-COMPARISON.md).

## Where it stands

- **For a manual warehouse the functions are there.** Against the 27 things OpenWMS.org lists, SortedWMS covers 17, covers 5 in part, and lacks 5. The 5 are all automation (PLC drivers, routing workflows) or platform (monitoring, many-node deployment).
- **What is missing is proof.** It has not run on a real handheld in a real aisle, and it has not run a real warehouse.
- **Phases 0 and 1 make it trustworthy. Phases 2 to 4 make it deeper. Phases 5 and 6 are decisions, not debts.**

Each item has a size: **S** is a day or two, **M** is about a week, **L** is several weeks. "Done when" is the test for crossing it off.

## Phase 0: fix and prove

Nothing else should start before these. They are small, and each one closes a known hole.

| # | Item | Size | Done when |
| --- | --- | --- | --- |
| 0.1 | **Check on real devices.** The bin handheld with no connection at all on a phone. The camera scanner with a real camera. A scanner gun on `/handheld`, `/keys` and the telnet terminal. A Zebra label printer on TCP 9100. | M | Each is tried, and what broke is fixed or written down in [HARDWARE.md](HARDWARE.md) |
| 0.2 | **A written shift.** One page that walks a person through a whole day on the sample 3PL: receive, put away, wave, pick, pack, load, count, return, invoice. Work it by hand once. | M | The page exists, and every step was done on the screens without the API |

## Phase 1: ready for a real warehouse

The goal is one real site running on it for a month.

| # | Item | Size | Done when |
| --- | --- | --- | --- |
| 1.1 | **Snapshots that do not rewrite what has not changed.** Measured on the load test: a snapshot is 11 MB and takes 67 ms, 120 ms at twice the size. Half of it is locations, which are not history, and no order in that test has shipped. Moving closed orders out would not help yet. Writing each record only when it changes would, and needs a way to know what a command touched. | L | A snapshot after 200 changes writes those changes, not the building |
| 1.2 | **Order entry and replay at size.** Done. A piece order no longer plans ground jobs again when no pallet has moved, and replenishment demand keeps only the oldest orders in a wave instead of sorting every open order. On 1,500 items and 1,500 pallets, adding an order was 0.37 ms with 3,000 open and 0.30 ms with 6,000; after the change, 0.12 ms and 0.04 ms. Replaying that journal went from 1.4 s to 0.29 s. | M | Adding an order costs the same with 3,000 open orders as with 6,000 |
| 1.3 | **Running it safely.** A page on HTTPS behind a reverse proxy, what to firewall, running as a service, and restoring on a new machine. | S | A stranger can follow it without asking |
| 1.4 | **The fields of each route.** [API.md](API.md) lists every route, its permission, roles and module, built from the route tables. It does not yet list what each body takes and each answer gives. | M | Each route in the page names its fields, still built by a test |
| 1.5 | **Security review.** Session handling, permissions per route, uploads, CSV formulas, webhook signatures, the telnet terminal. | M | Findings are fixed or listed |
| 1.6 | **Pilot.** One real warehouse, alongside what it uses now, for a month. | L | It ran the month, and every problem became an issue |
| 1.7 | **Import from another system.** Items, locations, stock and open orders as CSV exist. Add a dry run that reports what would be refused, and a cut-over checklist. | M | A pilot site moves its data in one evening |

## Phase 2: the floor, further

Auto mode and taking over pallets are what no other open WMS has. This phase widens that lead. The sequence follows [AUTOMATION-RESEARCH.md](AUTOMATION-RESEARCH.md); its first slice, demand-aware replenishment, is done.

| # | Item | Size | Done when |
| --- | --- | --- | --- |
| 2.1 | **Say why.** Auto records why a job was chosen and why waiting work is blocked: no stock, no truck with the equipment, a full aisle, an earlier step not finished. | M | An idle driver and a supervisor both see the reason |
| 2.2 | **Auto for people on foot.** Pickers and stock staff get their next task the way trucks do, by duty, zone and what they already carry. | L | A picker works a shift without choosing a task |
| 2.3 | **Interrupted and failed.** A job has states for "stopped half-way" and "could not be done", with a reason, as OpenWMS's transport orders have. | M | A pallet left in an aisle is a visible state, not a stale job |
| 2.4 | **Take over a single pallet.** Today only a pallet set down from a stack can be taken over. Let a driver hand over the one on the forks, with both scans recorded. | M | Shift change with a loaded truck needs no office |
| 2.5 | **Recover by itself.** On a shortage, a blocked location, a new receipt or a released hold, work that has not started is replanned. | L | The cases in the research note each have a test |
| 2.6 | **More waves at once.** Release independent waves together within a set limit. | M | Two zones pick at the same time without sharing stock |
| 2.7 | **Offline for trucks.** The bin handheld works without a connection. Give the truck handheld a queue for the scans that are safe to replay. | L | A truck in a dead corner loses no scan |
| 2.8 | **Compare policies in the demo.** Run the same day under two settings and report orders on time, empty travel and time blocked. | M | A setting can be chosen on numbers |

## Phase 3: warehouse functions still missing

None of these is in the code today. OpenWMS's public pages show almost none of them either; they are what larger operations ask a WMS for. Each is a module, off by default.

| # | Item | Size | Done when |
| --- | --- | --- | --- |
| 3.1 | **Units and conversions.** Each, inner, case and pallet per item, with a barcode per level, so a scan of a case books the right count. | L | Receiving, picking and counting accept any level |
| 3.2 | **Backorders and short shipment.** An order line that cannot be filled waits, ships short or cancels, by a rule per client. | M | Each rule has a test, and the confirmation says what happened |
| 3.3 | **Cross-docking.** A received pallet that an open order needs goes to the dock, not the rack. | M | It shows as its own job type in Auto |
| 3.4 | **Cart picking.** Several small orders on one cart, a tote per order, sorted by the scan. | L | One walk fills several orders with no sorting bench |
| 3.5 | **Zones.** Pick in zones and bring the parts together at packing. | M | An order split across two zones packs as one |
| 3.6 | **Carton choice.** Suggest the carton from item sizes and weights. | M | The packer sees a carton and can overrule it |
| 3.7 | **Dock appointments and yard.** Book a door and a time for a delivery or a collection, and see who is waiting. | M | Receiving windows in Auto follow the bookings |
| 3.8 | **Labour figures.** "Drivers this shift" exists. Add history per person and per task type, for planning, not scoring. | M | A supervisor can staff next week from last month |
| 3.9 | **Slotting advice.** Suggest moves that put fast items low and near, from the ABC classes. | M | A list of moves with the travel each one saves |
| 3.10 | **Goods that must stay apart.** Hazard classes and rules for what may not share an aisle or a pallet. | M | Put-away refuses a forbidden neighbour |
| 3.11 | **Catch weight.** Items sold by weight, weighed at receiving and at pick. | M | Stock and invoices carry the weighed amount |
| 3.12 | **Take a kit apart.** The reverse of a bill of materials. | S | Components return to stock with their lots |

## Phase 4: connections

| # | Item | Size | Done when |
| --- | --- | --- | --- |
| 4.1 | **An adapter kit.** What the four connectors share (polling, webhooks, mapping, retry, alerts) as one base, so a new one is a mapping and little else. | M | One existing connector is rebuilt on it with no change in behaviour |
| 4.2 | **One ERP.** OpenWMS keeps SAP, Dynamics and NetSuite adapters private. Choose the one the pilot site uses. | L | Items, orders and confirmations flow both ways |
| 4.3 | **Single sign-on.** OIDC as an optional module, with local accounts kept as the fallback. | M | A person signs in with the company account and gets the mapped role |
| 4.4 | **EDI.** Orders, despatch advice and receipts in EDIFACT, for retail customers of a 3PL. | L | A sample of each message goes round trip |
| 4.5 | **More shops and marketplaces.** Chosen by request. | M each | Each has the same four functions as Shopify |
| 4.6 | **Pallet freight.** Sendcloud covers parcels. Add booking a pallet carrier and printing its labels. | M | A loaded trailer has its consignment note |
| 4.7 | **An event feed.** The message log as MQTT or AMQP for systems that want a stream. | S | A subscriber gets every confirmation once |

## Phase 5: automation, if a site needs it

This is OpenWMS's home ground: PLC telegrams, transport orders for conveyors and cranes, routing changed while running. SortedWMS has none of it, on purpose. Start only when a real site with real equipment asks.

| # | Item | Size | Done when |
| --- | --- | --- | --- |
| 5.1 | **Decide.** Write down which equipment, and whether to build a driver or sit beside an existing material-flow controller, which could be OpenWMS itself. | S | A decision with its reasons |
| 5.2 | **Equipment as a holder.** A conveyor, lift or shuttle takes a job the way a truck does, and reports a pallet at a point. | L | The demo runs a conveyor between receiving and the racks |
| 5.3 | **A telegram driver.** TCP telegrams to a PLC, or OPC UA. | L | A simulated PLC asks where a pallet goes and gets an answer |
| 5.4 | **A routing table.** From this point, for this kind of pallet, go there. A table, not a workflow engine. | M | A route changes without a restart |
| 5.5 | **Driverless vehicles.** VDA 5050 for mobile robots. | L | One simulated vehicle takes Auto jobs |

## Phase 6: scale

Only when one install is not enough.

| # | Item | Size | Done when |
| --- | --- | --- | --- |
| 6.1 | **PostgreSQL for the journal**, if many sites or heavy reporting need it. | L | The same tests pass on both |
| 6.2 | **A standby.** A second machine that follows the journal and can take over. | L | Pulling the plug on the first loses no confirmed scan |
| 6.3 | **Hosted for many companies.** Separate data per company on one service. | L | Two companies cannot see each other by any route |
| 6.4 | **A native handheld app**, only if the web handheld's offline queue is not enough somewhere. | L | It does something the web screen cannot |
| 6.5 | **More languages.** German and French first. | S each | Every screen and document is translated |

## Not planned

- **Microservices.** One process is the point: no broker, no registry, nothing to orchestrate.
- **A workflow engine.** Rules are settings and tables.
- **A package manager for modules.** A module is a folder; nothing is downloaded.

## Done

**The floor**
- Reach-truck dispatch (Auto), aisle limits, one-way aisles, categories, block stacks, Auto-Shift, ground-level next-out pallets, receiving with GS1 labels, check and label, trailer loading.
- Stacked pickup with truck and door clearances, and taking over a pallet from another truck with one scan.
- Loose stock in bins and shelves: packs, mixed bins, put-away, pick, move and count, with the device camera as a scanner and label sheets for bins and items.
- Pick waves from a queue: whole pallets to the dock, whole boxes from the man-up, small picks from bins, an order dropped into the next wave when one is done or after a maximum wait.
- Replenishment that looks at the picks already promised, counts what is on its way, and says why it is blocked.
- Floor roles by duty (inbound, picker, stock), and truck equipment (reach, man-up, EPT, cart) that decides which jobs a truck can take.
- The bin handheld, which keeps working without a connection.

**Stock**
- Batch and best-before on every pick, with a minimum of days left per item or per order, recalls that find every customer, and a near-best-before list with write-off.
- Serial numbers, piece by piece and on whole pallets.
- Stock checks that hold a location, item corrections under one correction number, and a daily stock-change report.
- Returns: booked against what shipped, graded restock, hold or scrap, a few at a time.
- Renaming locations, with the old codes still scanning.
- Item photos for the office and the client, kept through backup and restore.

**The office and the building**
- Guided location setup, presets, and switchable modules with simple screens.
- Clients, items, orders, ASNs, cartons and packing slips, delivery notes, kits, replenishment, more warehouses per install with transfers, available-to-sell, 3PL rate cards and invoices, client logins.
- Client items: one item list per client (or the owner's list when there is a single client). The client keeps names, sizes and barcodes. Staff see them, flag a note, and carry out a request to take stock out. Fast and slow movers rank in the warehouse timezone and export to CSV. Off, item editing is unchanged and the rows stay.
- Bills of materials: a kitting task consumes the components and produces the kit.
- Delivery notes, pick lists, packing lists and client statements as A4 PDFs, written by the program itself.
- Low-stock alerts that go out when available stock reaches the reorder point: one alert until it recovers, a reminder if it stays low, webhooks, SMTP email, and the bell. A client only gets its own items. A daily digest uses the warehouse timezone. See [ALERTS.md](ALERTS.md).
- Item value in the warehouse currency, on the item form, client entry, imports and intake. ABC by value and the stock-value report use it. With high-value plates on, roles without the permission do not see the amount.
- Accounts with roles and editable permissions, TOTP, lockout, session timeouts, and the starting admin password changed at the first sign-in.
- A user-audit CSV for managers and administrators.
- English and Dutch. A person chooses a language; otherwise the warehouse default is used. Numbers, dates and money follow it, in the warehouse timezone. See [I18N.md](I18N.md).
- Cycle-count recount defaults: a new warehouse posts a difference of 2 pieces or 5% or less at once. Each class can set its own numbers. Warehouses still saved at 0 and 0% are moved to those defaults once.

**Running it**
- `./start.sh` with no Docker and no packages, daily backups and restore, sample warehouses, a journal that is both the audit trail and the way state is rebuilt.
- JSON backups that keep module state, and a restore that signs everyone out.
- Encrypted off-site backups: AES-256-GCM with a passphrase, a daily time or an interval in the warehouse timezone, retention of daily, weekly and monthly copies, and a folder, S3-compatible bucket or WebDAV target. A failure is journaled and, when Alerts is on, raised there. The file includes password hashes; the passphrase does not. See [BACKUPS.md](BACKUPS.md).
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
- A text terminal for scanner guns (telnet, ASCII, off until enabled). See [TERMINAL.md](TERMINAL.md).
- Connect a phone on the same network with a QR code. The session is bound to that device. See [PAIRING.md](PAIRING.md).
- The demo on GitHub Pages: a distribution centre for four clients worked by bots in every role on the real screens, on a clock you can pause or speed up. Each role's card points at what just happened that concerns it; take over any role and work it yourself.
- One light/dark setting (Auto, Light or Dark) for every screen, kept in the browser; Auto follows the device.
- Square, flat screens with instant press feedback, set in one place.
- A wiring test that calls every route and checks that every service is passed from `main()` to the server to the API.
- Refusals in plain words: an empty request is told what is missing, and a test keeps it so.
- Health figures and a metrics page for whoever watches an unattended install. See [HEALTH.md](HEALTH.md).
- Password rules: a shortest length, earlier passwords refused, and an optional age limit. See [ACCOUNTS.md](ACCOUNTS.md).
- Every route written down with its permission, roles and module, built from the route tables and kept current by a test. See [API.md](API.md).
- Restarts that load a snapshot without copying it twice, two snapshots kept, and a fallback when the newest cannot be read.
- Order entry stays flat as open orders grow. A piece order does not plan ground jobs again until a pallet moves, and the replenishment look-ahead only keeps the oldest orders in the wave.

**Connections** ([CONNECTIONS.md](CONNECTIONS.md))
- API keys per system, with a role, for one client or all; revoked at once.
- Shopify: paid orders in (webhook or poll, safe to send twice), SKU mapping, stock and tracking back. See [connectors/SHOPIFY.md](connectors/SHOPIFY.md).
- Orders and ASNs in: one intake, JSON or CSV, safe to send twice, the sender's reference carried through; and a drop folder.
- Confirmations out: goods received, orders shipped with pallets, cartons, batches and serials, returns, stock adjustments, in a numbered log a system reads from where it left off, or pushed to it by signed webhooks or an outbox folder.
- WooCommerce: processing orders in (webhook or poll, safe to send twice), SKU mapping, stock and tracking back. See [connectors/WOOCOMMERCE.md](connectors/WOOCOMMERCE.md).
- Etsy: paid unshipped receipts in (poll, and an optional signed webhook), OAuth with PKCE back to this WMS, SKU mapping, stock and tracking back. See [connectors/ETSY.md](connectors/ETSY.md).
- Sendcloud: a label from a packed shipment, carrier rules by client, country and weight, the PDF kept and a tracking line printed, tracking on the delivery note, signed status webhooks, return labels when Returns is on. See [connectors/SENDCLOUD.md](connectors/SENDCLOUD.md).

## Hardware it expects

- **Handheld scanners** running the web screens in the device browser, set to send Enter after each scan and to transmit the GS1 separator and symbology prefix. `/keys` checks a scanner's setup.
- **Label printers** taking ZPL over the network (TCP 9100), or the browser's print dialog.
- A phone or tablet camera works as a scanner on the bin handheld.

## Risks to say out loud

- A WMS that is down stops shipping. Whoever runs it needs hosting, backups (a local copy is built in; the off-site module sends an encrypted copy elsewhere) and someone on call.
- Food traceability (batch, best-before, recall) carries legal weight. The journal is the audit trail; it is not optional.
- Moving to SortedWMS from another system depends on what that system can export.
- It has not yet run a real warehouse. Until the pilot in phase 1, treat it as complete but unproven.
