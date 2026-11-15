# Function check and comparison with OpenWMS.org

Checked on 15 November 2026 against SortedWMS commit `a77a543` (main at `8e00585` plus the square-screens change). OpenWMS.org was read from its public pages on the same day: the [main repository](https://github.com/openwms/org.openwms), the [project site](https://openwms.github.io/org.openwms/) and the pages of its public services. The roadmap that follows from this is in [ROADMAP.md](ROADMAP.md).

## Part 1: function check of SortedWMS

### What was run

| Check | Result |
| --- | --- |
| Test suite (`npm test`) | 464 of 464 pass, 86 test files, 39 seconds |
| Load test (`npm run load-test`) | Completes. 2,000 orders at 3.9 ms each, 1,000 more by CSV in 10 ms, 15 waves with 868 tasks confirmed in 0.56 s, every list endpoint under 110 ms |
| Pages build (`npm run build:pages`) | Builds 21 entries |
| Every API route, read as manager, office and picker on the 3PL sample | No 5xx. Roles are refused where they should be (8, 19 and 35 routes answer 403) |
| Every API route, called with an empty GET and an empty POST as manager | One fault, below. The rest answer with a validation message |
| Every page (`/login`, `/app`, `/admin`, `/handheld`, `/bins`, `/station`, `/desk`, `/loading`, `/keys`, `/setup`, `/card`, `/pair`) | All answer 200 |
| The 13 manager tabs in `/app`, clicked one by one | All draw, no script errors |
| Handheld: set-up, idle job, a refused scan. Bins: a pick job | Work as described |

### What is not covered by this check

- **Real devices.** The offline bin handheld and the camera scanner have still only run in a desktop browser. This is the first item on the roadmap for a reason.
- **Outside systems.** Shopify, WooCommerce, Etsy, Sendcloud, SMTP, S3 and WebDAV are tested against stand-ins. No call left the machine.
- **Printers and scanner guns.** ZPL output and the telnet terminal are tested as text, not on hardware.
- **Write flows through the screens.** Receiving, put-away, picking, loading and counting were exercised by the test suite, not clicked through by hand.
- **Modules off in the 3PL sample** (food, lots, quarantine, stations, terminal, demo) were covered by their tests only.

### Faults found

1. **The alerts API is disconnected.** `/api/notify`, `/api/notify/inbox`, `/api/notify/read`, `/api/notify/settings`, `/api/notify/subscribe` and `/api/notify/test` all answer `400 {"error":"alerts is not defined"}`. `createApi` in `server/api.js` lost its `alerts` parameter in a merge, and `createServer` in `server/index.js` no longer passes it. The alert engine itself still runs and its 9 tests pass, because they call it directly. The effect: the bell stays empty, alert settings cannot be read or saved, and the test send does nothing. Every office page asks `/api/notify/inbox` on each refresh and gets the error.
2. **Three validation messages print `undefined`.** An empty request to `/api/boms`, `/api/items` or `/api/reports/invoice` answers "Unknown item undefined", "Unknown category undefined" or "Unknown client undefined". Cosmetic.
3. **`docs/ROADMAP.md` was out of date.** A4 PDFs were listed as next and had shipped. Item photos, bills of materials and the user audit were missing from the done list. Fixed in the new roadmap.

The first fault was fixed on the same day, with the test described next. It was the third merge regression of this kind (see "Restore the merged module wiring" and "Shop sync alerts" in the changelog). `test/wiring.test.js` now calls every route and checks that each service is passed along, which would have caught this one.

### Function by function

Each module has its own tests. The count is the number of tests in the files that name it.

| Area | Functions | Tests | State |
| --- | --- | --- | --- |
| Dispatch and trucks | Auto mode, Auto-Shift, aisle limits, one-way aisles, block stacks, duties, equipment, stacked pickup, handoff between trucks | engine 29, stacked 12, manual 12, duties 5, logic 9 | Works |
| Receiving | ASNs, GS1 supplier labels, check and label, receiving desk, serials on pallets | supplier-labels 8, gs1 5, plates 7, pallet-serials 5 | Works |
| Bins | Put-away, pick, move, count, refill from a rack pallet, offline queue, camera | bins 8, bin-handheld 4, offline-queue 2, scan-queue 2 | Works in a browser; unproven on a phone |
| Waves and replenishment | Pallet, box and small picks, queue, demand-aware replenishment, return task | waves 10, replenishment-demand 13, return-move 2 | Works |
| Stock control | Stock checks, corrections, counts, ABC cycle counts, recount and approval | stockcheck 14, counts 12, corrections 4, abc 3, recount-defaults 2 | Works |
| Traceability | Lots, best-before, FEFO, recalls, serials, quarantine, quality hold | lots 7, recall 6, serials 6, quarantine 9, quality 5 | Works |
| Outbound | Orders, cartons, packing, trailer loading, delivery notes, A4 PDFs, closing | loading 14, closing 6, documents 2, order-import 2 | Works |
| Returns, kitting, stations | Graded returns, kits, bills of materials, process stations | returns 7, bom 6, process 16 | Works |
| 3PL | Clients, client logins, rate cards, invoices, item value | tariff 8, client-portal 1, customers 2, item-value 3 | Works |
| Connections | API keys, intake, outbox, webhooks, drop folder, three shops, Sendcloud | connections 3, intake 5, outbox 4, shopify 2, woocommerce 2, etsy 2, sendcloud 2, shop-worker 4 | Works against stand-ins |
| Alerts | Low stock, reminders, digest, webhooks, email, bell | alerts 9, wiring 2 | Works since the fix below; the API was disconnected when checked |
| Accounts and security | Roles, permissions, TOTP, lockout, first password, pairing, user audit | auth 4, security 3, first-password 2, pairing 4, user-audit 3 | Works |
| Running it | Journal, snapshots, upgrades, backups, off-site backups, modules, presets | upgrades 4, backup-offsite 9, photo-backups 3, modules 6, registry 6, wizard 7 | Works |
| Screens and languages | Every screen, themes, English and Dutch, text terminal, demo | screens 7, operator-screens 3, theme 2, i18n 3, terminal 6, demo 7, pages-build 3 | Works |

## Part 2: OpenWMS.org

### What it is

OpenWMS.org describes itself as "a free to use and extensible Warehouse Management System (WMS) with a Material Flow Control (MFC) system for automatic and manual warehouses". It began in 2005 and has been Spring Boot microservices since 2016. It now targets Java 25 and Spring Boot 4.1, with RabbitMQ for events and a BPMN engine (Flowable, Camunda or Activiti) for routing decisions. It runs on Kubernetes. It names BMW Group, Scheppach, a US health agency and General Electric as users. The main repository has 764 stars and 5,270 commits.

It is a kit for integrators. A project picks services, writes BPMN workflows and adapters, and deploys them. It is not something a warehouse installs and uses on the same day.

### How much of it is public

The main repository lists 31 components. 14 are public. 17 are marked Private or Private Preview, and those include most of the warehouse functions:

| Public | Private or private preview |
| --- | --- |
| Service registry, configuration, gateway | Enterprise gateway, auth service |
| UAA (users, roles, grants), preferences | Printing, translation |
| Unit-of-measure library, test library | Inventory, picking, putaway, shipping |
| Common service (locations, location groups, transport units, placing rules) | WMS tasks, partners, trucks, orchestrator |
| OSIP TCP/IP driver for PLCs | OPC UA driver, transaction service |
| Common tasks | SAP, Dynamics and NetSuite adapters |
| Transportation (transport orders), routing (BPMN) | |
| Receiving, movements | |

So the public OpenWMS is strongest in automation: locations and transport units, transport orders, routing and the PLC driver. Its inventory, picking, putaway and shipping cannot be read, so their depth cannot be compared. Where the table below says "private", that is what it means.

The public pages are also thin. The receiving page, for example, says that announced and blind receipts are supported and that quantities or whole transport units can be captured, and little else. Transport order states (created, initialized, started, interrupted, failed, cancelled, finished) come from the source reading in [AUTOMATION-RESEARCH.md](AUTOMATION-RESEARCH.md).

## Part 3: side by side

| # | OpenWMS component | What it does there | SortedWMS | Verdict |
| --- | --- | --- | --- | --- |
| 1 | UAA | Users, roles, grants, password history, multi-tenant, OAuth2/OIDC auth server | Roles with editable permissions, TOTP, lockout, session timeouts, API keys, device pairing. No single sign-on, no password history | Partial |
| 2 | Preferences | Settings per user, role or module | Settings per warehouse and per person (language, theme) | Covered |
| 3 | Printing (private) | Label and document printing | ZPL over TCP 9100, label sheets, A4 PDFs, print queue | Covered |
| 4 | Translation (private preview) | Translated texts | English and Dutch, per person, with local numbers, dates and money | Covered |
| 5 | Unit-of-measure library | Typed units and conversion | Pieces and packs. No case/inner/each conversion, no weight or volume units | Partial |
| 6 | Locations and location groups | Locations in groups, with infeed and outfeed state | Locations, aisles, zones, guided set-up, renames with old codes, aisle limits, one-way aisles, holds | Covered |
| 7 | Transport units, types, placing rules | Which carrier may stand on which location | License plates with SSCC, categories, location profiles, block stacks, stack heights and clearances | Covered |
| 8 | OSIP TCP/IP driver | Telegrams to and from PLCs | None | Missing |
| 9 | OPC UA driver (private preview) | Machine connectivity | None | Missing |
| 10 | Transaction service (private preview) | Log of business transactions | The journal: every change, the audit trail, and the way state is rebuilt | Covered |
| 11 | Tasks | Work items for people | Task list, exceptions, return tasks | Covered |
| 12 | Transportation | Transport orders for automated equipment, with a state machine | Auto mode dispatches human-driven trucks. No orders to automated equipment, no interrupted or failed states | Partial |
| 13 | Routing | BPMN workflows answer each PLC request with the next target | None, by design. Process stations route pallets between manual stations | Missing |
| 14 | Receiving | Announced and blind receipts, by quantity or by transport unit | ASNs, GS1 supplier labels in one to three scans, check and label, receiving desk, best-before and serials at the door | Covered |
| 15 | Inventory (private preview) | Stock | Stock by pallet and bin, lots, serials, holds, quarantine, available-to-sell, recalls | Covered |
| 16 | Picking (private) | Picking | Waves of pallets, boxes and small picks, FEFO, minimum days left, bin picks | Covered |
| 17 | Movements | Manual moves: inbound, outbound, replenishment, reconciliation, in groups | Put-away, move, replenish, count, transfer, with a scan at each end | Covered |
| 18 | Partners (private preview) | Business partners | Clients, client logins, customers | Covered |
| 19 | Trucks (private preview) | Trucks | Trucks with equipment and duty, Auto-Shift, shift figures | Covered |
| 20 | Shipping (private preview) | Shipping | Cartons, packing slips, trailer loading, delivery notes, Sendcloud labels and tracking | Covered |
| 21 | Putaway (private) | Putaway strategy | Automatic slot choice by category, height and next-out | Covered |
| 22 | ERP adapters (private) | SAP, Dynamics, NetSuite | One intake for orders and ASNs, a numbered log of confirmations, webhooks, folders. Three shop connectors. No ERP adapter | Partial |
| 23 | Operator web app (COP) | Office screens | `/app` by role, `/admin`, client portal, reports | Covered |
| 24 | Handheld app (Roma, Flutter) | Native mobile app | Web handheld, offline for bins, camera scanning, text terminal for guns. No native app | Covered |
| 25 | Monitoring | Grafana, Kibana, Spring Boot Admin | `/api/health` only when checked. Since then: health figures and a Prometheus metrics page ([HEALTH.md](HEALTH.md)); no dashboards or log search | Partial since |
| 26 | Deployment | Kubernetes, several nodes, cloud or on site | One process, one SQLite file | Missing |
| 27 | Multi-tenancy | Tenants across the services | Several warehouses and several clients on one install. No isolated tenants | Partial |

Left out of the count: the service registry, configuration server, gateway and orchestrator. They exist because OpenWMS is many processes. SortedWMS is one.

**The count: 17 covered, 5 partial, 5 missing, of 27.** All five that are missing are automation (8, 9, 13) or platform (25, 26). No warehouse function that OpenWMS lists is absent from SortedWMS.

### Only in SortedWMS

None of these appear in OpenWMS's public pages.

- **Auto mode.** The handheld gives a truck its next job by itself, chosen by duty, equipment, aisle limits, one-way aisles and urgency. OpenWMS's transport orders are for conveyors and cranes; its manual warehouses use plain movements.
- **Taking over a pallet from another operator.** A pallet set down from a stack stays on the first truck's load; a second truck takes the job with one scan, and the first screen says who took it.
- **Stacked pickup** with truck and door clearances, each pallet keeping its own job and drop.
- **Scan-first handheld.** Built for gloves in a cold store: a scan does the step, with no Scan, Enter, Enter.
- **Offline bin handheld**, camera scanning, a text terminal for scanner guns, and phone pairing by QR code.
- **Food traceability in the open:** batch, best-before, FEFO, minimum days left per customer, recalls that find every customer, temperature and quality holds.
- **3PL in the open:** rate cards, tiers, seasons, invoices, client logins, low-stock alerts per client.
- **Shop connectors:** Shopify, WooCommerce, Etsy, and Sendcloud labels.
- **Runs with nothing but Node.** `./start.sh`, no packages, no Docker, sample warehouses, presets from a home bin wall to a distribution centre, modules switched per warehouse.
- **Operations built in:** versioned upgrades with rollback, daily backups, encrypted off-site backups, a load test, a live demo worked by bots.

### Only in OpenWMS

- **Automated material flow.** PLC telegrams, transport orders for conveyors and cranes, routing that can be changed while running.
- **Scale.** Many nodes, a message broker, per-service databases, Kubernetes.
- **Enterprise sign-in.** OAuth2 and OIDC, multi-tenant.
- **ERP adapters** for SAP, Dynamics and NetSuite (private).
- **Twenty years of production use** in large warehouses. SortedWMS has not yet run a real one.

## Part 4: how far from done

It depends on which finish line.

**As a WMS for a manual warehouse** (a bin wall, a maker, a 3PL, a reach-truck distribution centre): the functions are there. Measured against OpenWMS's list, nothing a manual warehouse needs is missing, and several things go further than OpenWMS shows in public. What is missing is proof, not features:

1. It has never run on a real handheld in a real aisle.
2. It has never run a real warehouse for a month.
3. Merges have broken wiring three times. A wiring test now guards against a fourth.
4. Snapshots and restart time have not been tried with years of history.

Until those four are closed it is a complete program that is not yet a proven one.

**As a WMS that a larger operation would choose**, some functions common in commercial systems are absent (searched for in the code, not found): cross-docking, backorders, unit conversions, cluster and zone picking, cartonisation, dock appointments and yard, labour reporting beyond the shift table, slotting advice, hazardous-goods segregation, catch weight, single sign-on, ERP adapters, EDI. OpenWMS's public pages show none of these either, except unit conversion, sign-on and the private ERP adapters.

**As a controller for an automated warehouse**: not started, on purpose. This is OpenWMS's home ground. It is a separate decision, not a gap to close by default.
