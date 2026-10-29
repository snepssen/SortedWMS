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
- **Kitting** is a bill of materials on a VAL station. The demo kit is a laptop plus an EU power plug: scan the base, then the component.

## Still not in this version

- The static Pages demo does not sign in.
- No password-reset email, no second factor, and no roles beyond these six.
- No ERP or EDI connection. Orders and stock still come in through the API or CSV.
- Packing is a note plus the existing check-and-label step, not a carton-level pack bench.
- Replenishment creates one move to a rack or bin. It does not keep a min/max on every pick face.
- Real scanners and printers are the wedge and the ZPL transport. There is no DataWedge installer and no USB claim.
- No returns, billing, multi-warehouse, or offline queue beyond the handheld's existing retry.
