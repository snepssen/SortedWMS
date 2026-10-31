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
| `operator` | `sorted-operator` | Operator | Receiving, mezzanine pick, VAL / kitting |
| `machine` | `sorted-machine` | Machine operator | Put-away, replenishment, transfers, pallet and block-lane moves |

The operator is on foot, at a station or with a handheld. The machine operator drives a reach truck or a high-level order picker. The technical account is the WMS technical department, not maintenance.

## What each role is for

- **Administrator.** Users, which role they have, the permission list for every role except administrator (that role always has every permission), system settings, and the audit log (warehouse journal plus sign-in events).
- **Manager / supervisor.** Shift KPIs, staff, task assignment, exceptions, approvals, and movement history for a person or a license plate.
- **Office.** Clients, items, ASNs, orders, packing notes, reports, and label printing.
- **Technical.** Auto-sort strategy and rules, default dimensions and capacity by location type, and the license-plate prefix and padding. Equipment and scanner/printer mode sit underneath that. This is not the maintenance role.
- **Operator.** On foot. Inbound receiving (a full pallet is issued `PAL` and `MASTER`), mezzanine picking, and VAL/kitting where each scan adds a component to a base product. Wedge, manual entry, and simulated scan all use the same field.
- **Machine operator.** Driving a reach truck or high-level order picker. The screen is the next move: put-away, replenishment, transfer, pallet move, block lane. Not a production-line screen.

The floor screens (`/admin`, `/handheld`, `/station`, `/desk`, `/loading`) stay. After sign-in the cookie is sent with them. A role that lacks the permission gets 403 rather than a silent change.

## Permissions

`server/permissions.js` is the list. A route names the permission it needs. Anything not listed needs `wms.read` for a GET and `wms.write` for a change. Operator and machine operator do not have `wms.write`; their posts are listed one by one (`scans.execute`, `counts.execute`, and so on).

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
- **Location profiles.** The technical role edits profiles and bulk-creates locations. Built-in profiles are high value, food/chilled, frozen, low value, and home/small maker. A profile sets storage (shelf/box stack, rack, or block stack), temperature, security, a put-away note, label text and capacity. A shelf needs a box count, a volume or a weight. A rack needs positions per level plus height, width and weight. A block stack needs a floor footprint and a stack height in pallets. Put-away refuses a move past that capacity, or records a warning when the profile says warn.
- **One shipment.** Staging a mixed order builds one delivery note and one load manifest for its pallets and cartons. Each holder is scanned onto the load. Dispatch is refused until every one is confirmed. Status runs staged, loaded, dispatched.
- **Backup.** `GET /api/backup` and `POST /api/backup` export and import the journal, snapshots and accounts. Only an administrator can do that.

## Still not in this version

- The GitHub Pages build does not check passwords. `app.html` there is a labelled demo with a role picker.
- No password-reset email. The administrator hands over the temporary password.
- No ERP or EDI connection. Orders and stock still come in through the API or CSV.
- Real scanners and printers are the wedge and the ZPL transport. There is no DataWedge installer and no USB claim.
- A seasonal override replaces the unit rate for those days. It does not scale the tier table. The card can add a percent or a fixed amount instead.
- The offline queue is on the handheld page. The role views in `/app` need a connection.
