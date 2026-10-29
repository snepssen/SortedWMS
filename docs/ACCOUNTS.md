# Accounts, roles and permissions

The server signs people in. The guided shift in the browser (`index.html`, GitHub Pages) does not: it has no database.

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
| `tech` | `sorted-tech` | Technician | Equipment, faults, maintenance, hardware |
| `operator` | `sorted-operator` | Operator | Put-away, picking, moves, counts, the task queue |
| `machine` | `sorted-machine` | Machine operator | The line: jobs, status, errors |

The operator view is laid out for a handheld width. The machine operator view follows one station (the press, in the demo, which starts with an open fault).

## What each role is for

- **Administrator.** Users, which role they have, the permission list for every role except administrator (that role always has every permission), system settings, and the audit log (warehouse journal plus sign-in events).
- **Manager / supervisor.** Shift KPIs, who is on the books, assigning a person to a handheld, urgent jobs, exceptions, and approval of releases. Also locations (with dimensions and capacity) and holders.
- **Office.** Clients (add, edit, archive), items, ASNs and other inbound, orders, a packing note, dispatch status, reports and CSV, pallet and master labels.
- **Technician.** Equipment, faults, the maintenance log, and scanner/printer mode.
- **Operator.** The task queue and a scan field. A fast burst of keys ending in Enter is a wedge scan. Typing it is manual entry. **Simulate scan** sends the code the current job is waiting for, marked as simulated.
- **Machine operator.** One machine: queue, SOP, status, and errors. The same three scan sources.

The floor screens (`/admin`, `/handheld`, `/station`, `/desk`, `/loading`) stay. After sign-in the cookie is sent with them. A role that lacks the permission gets 403 rather than a silent change.

## Permissions

`server/permissions.js` is the list. A route names the permission it needs. Anything not listed needs `wms.read` for a GET and `wms.write` for a change. Operator and machine operator do not have `wms.write`; their posts are listed one by one (`scans.execute`, `counts.execute`, and so on).

An administrator edits a role under **Roles**. The last active administrator cannot be demoted or disabled.

## Clients, items, locations, holders, labels

- A **client** is the owner of the goods (Dairy Co, Noord Kaas, Pulse Drinks in the example). Archiving blocks new items, receipts and orders for that owner. Stock already in the building stays.
- An **item** has a unit of measure, pallet quantity, optional GTIN / barcodes, and length, width, height and weight of the stored unit (one pallet). Remove is refused once the item has stock, an order or a holder line; archive it instead.
- A **location** can be a zone, aisle, rack, level, bin or block lane. Capacity is height, width, depth (millimetres) and maximum weight (kilograms). Footprint may rotate; height may not. Missing numbers are not treated as zero, so old rack slots with no capacity keep working. A structural rack (the frame) does not hold a pallet; a bin does.
- A **holder** is a pallet, crate or tote. It has a location and contents (loose units, or a stock SSCC).
- A **pallet label** and a **master label** carry a GS1-128 SSCC. ZPL is the printer payload. `/api/labels/:id/html` is the page you print or save as PDF.

## Still not in this version

- The static Pages demo does not sign in.
- No password-reset email, no second factor, and no roles beyond these six.
- No ERP or EDI connection. Orders and stock still come in through the API or CSV.
- Packing is a note plus the existing check-and-label step, not a carton-level pack bench.
- Replenishment creates one move to a rack or bin. It does not keep a min/max on every pick face.
- Real scanners and printers are the wedge and the ZPL transport. There is no DataWedge installer and no USB claim.
- No returns, billing, multi-warehouse, or offline queue beyond the handheld's existing retry.
