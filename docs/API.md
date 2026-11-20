# API reference

Every route the server answers. This page is built from the route tables by `npm run api-reference`; a test fails when it is out of date. Do not edit it by hand.

359 routes: 137 read, 222 change something. 9 need no sign-in.

## How to call it

- **Sign in** with the session cookie from `POST /api/login`, or send an API key as `Authorization: Bearer swk_…` or `X-Api-Key: swk_…`. Keys are made under Connections; see [CONNECTIONS.md](CONNECTIONS.md).
- **Bodies and answers are JSON**, except the routes ending in `.csv` or `.pdf`.
- **A refusal** answers `400` with `{ "error": "…" }` in plain words. `401` means not signed in, `403` means the role lacks the permission, and `404` on a read means no such route or a module that is off.
- **A route in a module that is off** answers `404` on a read and `403` on a change. See [MODULES.md](MODULES.md).
- **Sending the same change twice**: a change with an `x-request-id` header is carried out once; the second answer is the first again.

## Reading the tables

- **Permission** is what the route needs. A role's permissions can be edited, so **Roles** shows a new install. An administrator always has every permission.
- **Module** is the module that must be on. Empty means the route is always there.
- `:id` and the like are parts of the address you fill in. **Request** names them again under `path`.
- **Request** is read from the handler and from the command or function it calls. A star means the command refuses to run without that field (`req`). `query` is the query string. `body (whole)` means the handler accepts the JSON as it stands and names no keys. `each row` is a field of a row inside `rows`.
- **Response** is the JSON keys of a successful answer, read from the handler or from the function it returns directly. `the record's own fields` is a spread of the stored record. `the handler's value` means the code builds the answer without naming the keys in an object. `the command result` means the route returns whatever the command returns. A refusal is `{ "error" }` on every route and is not repeated here. `csv` and `pdf` are files, not JSON.

## abc

| Method | Route | Permission | Roles | Module | Request | Response |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/abc` | `counts.execute` | administrator, manager, stock | abc | query status, class | the handler's value |
| GET | `/api/abc.csv` | `counts.execute` | administrator, manager, stock |  | — | csv |
| POST | `/api/abc/:id/approve` | `counts.approve` | administrator, manager | abc | path id | the command result |
| POST | `/api/abc/:id/count` | `counts.execute` | administrator, manager, stock | abc | path id; body qty, reason | the command result |
| POST | `/api/abc/:id/recount` | `counts.execute` | administrator, manager, stock | abc | path id; body qty, reason | the command result |
| POST | `/api/abc/:id/reject` | `counts.approve` | administrator, manager | abc | path id; body reason | the command result |
| POST | `/api/abc/class` | `counts.approve` | administrator, manager | abc | body itemNo*, class | the command result |
| GET | `/api/abc/classes` | `counts.execute` | administrator, manager, stock | abc | — | basis, classify, windowDays, items, locations |
| GET | `/api/abc/mine` | `counts.execute` | administrator, manager, stock | abc | — | line |
| POST | `/api/abc/plan` | `counts.execute` | administrator, manager, stock | abc | — | the command result |
| POST | `/api/abc/settings` | `counts.approve` | administrator, manager | abc | body frequency, classThresholds, windowDays, basis, classify, thresholdQty, thresholdPercent, maxPerDay, blind | the command result |

## aisles

| Method | Route | Permission | Roles | Module | Request | Response |
| --- | --- | --- | --- | --- | --- | --- |
| POST | `/api/aisles/:aisle/cell` | `settings.write` | administrator |  | path aisle; body cell | the command result |
| POST | `/api/aisles/:aisle/direction` | `settings.write` | administrator | trucks | path aisle; body enterFrom | the command result |

## alerts

| Method | Route | Permission | Roles | Module | Request | Response |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/alerts/low-stock` | `reports.read` | administrator, manager, office, stock, client |  | — | the handler's value |
| GET | `/api/alerts/low-stock.csv` | `reports.read` | administrator, manager, office, stock, client |  | — | csv |

## auth-log

| Method | Route | Permission | Roles | Module | Request | Response |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/auth-log` | `audit.read` | administrator, manager |  | query limit | the handler's value |

## backup

| Method | Route | Permission | Roles | Module | Request | Response |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/backup` | `settings.write` | administrator |  | — | the handler's value |
| POST | `/api/backup` | `settings.write` | administrator |  | body journal, users | journal, users, schema |

## backups

| Method | Route | Permission | Roles | Module | Request | Response |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/backups` | `settings.write` | administrator |  | — | file, bytes, at |
| POST | `/api/backups` | `settings.write` | administrator |  | — | file, bytes |

## best-before

| Method | Route | Permission | Roles | Module | Request | Response |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/best-before` | `stock.read` | every role | lots | query days | on, days, rows |

## bins

| Method | Route | Permission | Roles | Module | Request | Response |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/bins` | `stock.read` | every role | bins | query item, itemNo | total, bins |
| GET | `/api/bins/:code` | `stock.read` | every role | bins | path code | itemNo, name, qty, unit, batch, expiry, clientId, packs, code, kind, mixed, weightKg, maxWeightKg, lines |
| POST | `/api/bins/:code/mode` | `locations.write` | administrator, manager, technician | bins | path code; body mixed | the command result |
| POST | `/api/bins/count` | `counts.execute` | administrator, manager, stock | bins | body loc*, itemNo, code, counted, unit, reason, serials, batch, expiry, by | the command result |
| POST | `/api/bins/move` | `moves.execute` | administrator, manager, stock | bins | body from*, to*, itemNo, code, qty, unit, batch, serials, by | the command result |
| POST | `/api/bins/put` | `inbound.write` | administrator, manager, office, inbound | bins | body loc*, itemNo, code, qty, unit, batch, expiry, serials, by, event, note | the command result |
| POST | `/api/bins/refill` | `replenish.execute` | administrator, manager, stock | bins | body loc*, sscc*, qty, by | the command result |
| GET | `/api/bins/suggest` | `stock.read` | every role | bins | query item, qty | itemNo, name, unit, serialized, lots, best, others |
| POST | `/api/bins/take` | `picks.execute` | administrator, manager, picker | bins | body loc*, itemNo, code, qty, unit, batch, expiry, orderId, serials, by, event, to, at | the command result |

## blocked

| Method | Route | Permission | Roles | Module | Request | Response |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/blocked` | `wms.read` | administrator, manager, office, technician, inbound, picker, stock |  | — | pallets, locations |

## boms

| Method | Route | Permission | Roles | Module | Request | Response |
| --- | --- | --- | --- | --- | --- | --- |
| POST | `/api/boms` | `bom.write` | administrator, manager, office | bom | body itemNo, lines | the command result |
| POST | `/api/boms/build` | `bom.write` | administrator, manager, office | bom | body itemNo, qty, loc, serials, by | the command result |

## cartons

| Method | Route | Permission | Roles | Module | Request | Response |
| --- | --- | --- | --- | --- | --- | --- |
| POST | `/api/cartons/:id/close` | `outbound.write` | administrator, manager, office, picker |  | path id | the command result |
| POST | `/api/cartons/:id/pack` | `outbound.write` | administrator, manager, office, picker |  | path id; body code, qty, serials | the command result |
| GET | `/api/cartons/:id/slip.html` | `orders.read` | administrator, manager, office, picker, client |  | path id | contentType, raw |

## categories

| Method | Route | Permission | Roles | Module | Request | Response |
| --- | --- | --- | --- | --- | --- | --- |
| POST | `/api/categories` | `settings.write` | administrator |  | body code*, name | the command result |

## checks

| Method | Route | Permission | Roles | Module | Request | Response |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/checks` | `stock.read` | every role |  | — | the handler's value |
| POST | `/api/checks` | `stock.check` | administrator, manager, office, picker, stock |  | body loc*, itemNo, orderId, note, by | the command result |
| POST | `/api/checks/:id/close` | `stock.adjust` | administrator, manager, stock |  | path id; body id*, outcome, note, by | the command result |

## client-items

| Method | Route | Permission | Roles | Module |
| --- | --- | --- | --- | --- |
| GET | `/api/client-items` | `items.read` | administrator, manager, office, inbound, picker, stock, client | client-items |
| POST | `/api/client-items` | `items.write` | administrator, manager, office, client | client-items |
| POST | `/api/client-items/:itemNo` | `items.write` | administrator, manager, office, client | client-items |
| POST | `/api/client-items/:itemNo/archive` | `items.write` | administrator, manager, office, client | client-items |
| POST | `/api/client-items/:itemNo/flag` | `client-items.flag` | administrator, manager, office, inbound, stock | client-items |
| POST | `/api/client-items/:itemNo/remove` | `items.write` | administrator, manager, office, client | client-items |
| POST | `/api/client-items/:itemNo/resolve` | `items.write` | administrator, manager, office, client | client-items |
| GET | `/api/client-items/movers` | `items.read` | administrator, manager, office, inbound, picker, stock, client | client-items |
| GET | `/api/client-items/movers.csv` | `items.read` | administrator, manager, office, inbound, picker, stock, client | client-items |
| GET | `/api/client-items/removals` | `items.read` | administrator, manager, office, inbound, picker, stock, client | client-items |
| POST | `/api/client-items/removals` | `items.write` | administrator, manager, office, client | client-items |
| POST | `/api/client-items/removals/:id/cancel` | `items.write` | administrator, manager, office, client | client-items |
| POST | `/api/client-items/removals/:id/confirm` | `client-items.remove` | administrator, manager, office, stock | client-items |
| POST | `/api/client-items/removals/:id/start` | `client-items.remove` | administrator, manager, office, stock | client-items |

## clients

| Method | Route | Permission | Roles | Module | Request | Response |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/clients` | `clients.read` | administrator, manager, office, client | clients | query archived | the record's own fields, items, pallets, qty, tariffVersions |
| POST | `/api/clients` | `clients.write` | administrator, manager, office | clients | body id, name, contact, email, phone, notes | the command result |
| GET | `/api/clients/:id` | `clients.read` | administrator, manager, office, client | clients | path id | the record's own fields, items, pallets, qty, tariffVersions, itemList, stock |
| POST | `/api/clients/:id` | `clients.write` | administrator, manager, office | clients | path id; body id*, name, storageRate | the command result |
| POST | `/api/clients/:id/archive` | `clients.write` | administrator, manager, office | clients | path id | the command result |
| POST | `/api/clients/:id/restore` | `clients.write` | administrator, manager, office | clients | path id | the command result |
| POST | `/api/clients/:id/space` | `tariff.write` | administrator, manager, office | billing | path id; body spaces | the command result |
| POST | `/api/clients/:id/tariff` | `tariff.write` | administrator, manager, office | billing | path id; body clientId*, effectiveFrom, versionId | the command result |

## config

| Method | Route | Permission | Roles | Module | Request | Response |
| --- | --- | --- | --- | --- | --- | --- |
| POST | `/api/config` | `settings.write` | administrator |  | body (whole) | the command result |

## consolidate

| Method | Route | Permission | Roles | Module | Request | Response |
| --- | --- | --- | --- | --- | --- | --- |
| POST | `/api/consolidate` | `holders.write` | administrator, manager, inbound, stock |  | body pals*, at*, master | the command result |

## counts

| Method | Route | Permission | Roles | Module | Request | Response |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/counts` | `wms.read` | administrator, manager, office, technician, inbound, picker, stock |  | — | open, done, accuracy, results |

## customers

| Method | Route | Permission | Roles | Module | Request | Response |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/customers` | `wms.read` | administrator, manager, office, technician, inbound, picker, stock |  | — | name, notes |
| POST | `/api/customers` | `wms.write` | administrator, manager, office |  | body customer, notes | the command result |

## deliveries

| Method | Route | Permission | Roles | Module | Request | Response |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/deliveries` | `inbound.read` | administrator, manager, office, inbound |  | — | the record's own fields, list, hasList |
| POST | `/api/deliveries` | `inbound.write` | administrator, manager, office, inbound |  | body id*, supplier*, category*, pallets, list, at, asn, clientId, expectedAt | the command result |

## desks

| Method | Route | Permission | Roles | Module | Request | Response |
| --- | --- | --- | --- | --- | --- | --- |
| POST | `/api/desks/:id/enter` | `scans.execute` | administrator, manager, office, inbound, picker, stock |  | path id; body field, value | the command result |
| POST | `/api/desks/:id/start` | `scans.execute` | administrator, manager, office, inbound, picker, stock |  | path id; body deliveryId | the command result |

## devices

| Method | Route | Permission | Roles | Module | Request | Response |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/devices` | `wms.read` | administrator, manager, office, technician, inbound, picker, stock | trucks | — | the handler's value |
| POST | `/api/devices` | `tasks.assign` | administrator, manager | trucks | body id*, mode, categories | the command result |
| GET | `/api/devices/:id` | `wms.read` | administrator, manager, office, technician, inbound, picker, stock | trucks | path id | result of deviceView |
| POST | `/api/devices/:id/categories` | `tasks.assign` | administrator, manager | trucks | path id; body categories | the command result |
| POST | `/api/devices/:id/duty` | `tasks.assign` | administrator, manager | trucks | path id; body duty | the command result |
| POST | `/api/devices/:id/equipment` | `tasks.assign` | administrator, manager | trucks | path id; body equipment | the command result |
| POST | `/api/devices/:id/finish-receiving` | `scans.execute` | administrator, manager, office, inbound, picker, stock | trucks | path id | the command result |
| POST | `/api/devices/:id/mode` | `scans.execute` | administrator, manager, office, inbound, picker, stock | trucks | path id; body mode, orderId | the command result |
| POST | `/api/devices/:id/operator` | `tasks.assign` | administrator, manager | trucks | path id; body operator, duty | the command result |
| POST | `/api/devices/:id/pending` | `scans.execute` | administrator, manager, office, inbound, picker, stock | trucks | path id; body action | the command result |
| POST | `/api/devices/:id/problem` | `scans.execute` | administrator, manager, office, inbound, picker, stock | trucks | path id; body reason | the command result |
| POST | `/api/devices/:id/qty` | `scans.execute` | administrator, manager, office, inbound, picker, stock | trucks | path id; body qty | the command result |
| POST | `/api/devices/:id/scan` | `scans.execute` | administrator, manager, office, inbound, picker, stock | trucks | path id; body code | the command result |
| GET | `/api/devices/paired` | `devices.manage` | administrator, manager | device-pairing | — | devices |
| POST | `/api/devices/paired/:id/rename` | `devices.manage` | administrator, manager | device-pairing | path id; body name | the handler's value |
| POST | `/api/devices/paired/:id/revoke` | `devices.manage` | administrator, manager | device-pairing | path id; body name | the handler's value |
| POST | `/api/devices/paired/revoke-all` | `devices.manage` | administrator, manager | device-pairing | — | revoked |

## documents

| Method | Route | Permission | Roles | Module | Request | Response |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/documents/delivery-note/:id` | `documents.read` | administrator, manager, office, client | documents | path id | contentType, raw |
| GET | `/api/documents/packing-list/:id` | `documents.read` | administrator, manager, office, client | documents | path id | contentType, raw |
| GET | `/api/documents/pick-list/:id` | `documents.read` | administrator, manager, office, client | documents | path id | contentType, raw |
| GET | `/api/documents/statement/:clientId` | `documents.read` | administrator, manager, office, client | documents | path clientId; query from, to | pdf |

## drivers

| Method | Route | Permission | Roles | Module | Request | Response |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/drivers` | `wms.read` | administrator, manager, office, technician, inbound, picker, stock | trucks | — | id, mode, categories, since, jobs, moves, received, scans, wrongScans, scansPerMove, inputsPerReceived, wrongShare, idleMs, idleShare |

## equipment

| Method | Route | Permission | Roles | Module | Request | Response |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/equipment` | `wms.read` | administrator, manager, office, technician, inbound, picker, stock |  | — | equipment, faults, maintenance |
| POST | `/api/equipment` | `equipment.write` | administrator, manager, technician |  | body id, status, name, kind, location, stationId, notes | the command result |
| POST | `/api/equipment/:id/fault` | `equipment.write` | administrator, manager, technician |  | path id; body equipmentId, summary, detail | the command result |
| POST | `/api/equipment/:id/maintenance` | `equipment.write` | administrator, manager, technician |  | path id; body equipmentId, note, by | the command result |

## etsy

| Method | Route | Permission | Roles | Module | Request | Response |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/etsy` | `etsy.manage` | administrator | etsy | — | the handler's value |
| GET | `/api/etsy/callback` | `wms.read` | administrator, manager, office, technician, inbound, picker, stock | etsy | query code, state | the handler's value |
| POST | `/api/etsy/catalog` | `etsy.manage` | administrator | etsy | body shopId | the handler's value |
| POST | `/api/etsy/connect` | `etsy.manage` | administrator | etsy | body shopId | the handler's value |
| POST | `/api/etsy/map` | `etsy.manage` | administrator | etsy | body shopId, sku, itemNo | the handler's value |
| GET | `/api/etsy/map/:id` | `etsy.manage` | administrator | etsy | path id | the handler's value |
| POST | `/api/etsy/shops` | `etsy.manage` | administrator | etsy | — | the handler's value |
| POST | `/api/etsy/stock` | `etsy.manage` | administrator | etsy | — | the handler's value |
| POST | `/api/etsy/sync` | `etsy.manage` | administrator | etsy | body shopId | the handler's value |

## events

| Method | Route | Permission | Roles | Module | Request | Response |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/events` | `wms.read` | administrator, manager, office, technician, inbound, picker, stock |  | — | the record's own fields, text |

## exceptions

| Method | Route | Permission | Roles | Module | Request | Response |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/exceptions` | `tasks.read` | administrator, manager, office, inbound, picker, stock |  | — | held, blocked, lost, faults, quality |

## faults

| Method | Route | Permission | Roles | Module | Request | Response |
| --- | --- | --- | --- | --- | --- | --- |
| POST | `/api/faults/:id/close` | `equipment.write` | administrator, manager, technician |  | path id; body note | the command result |

## hardware

| Method | Route | Permission | Roles | Module | Request | Response |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/hardware` | `wms.read` | administrator, manager, office, technician, inbound, picker, stock |  | — | the handler's value |
| POST | `/api/hardware/mode` | `equipment.write` | administrator, manager, technician |  | body scanner, printer | the handler's value |
| POST | `/api/hardware/print` | `labels.print` | administrator, manager, office, technician, inbound, picker, stock |  | body printer, zpl, html, kind | the handler's value |
| POST | `/api/hardware/scan` | `scans.execute` | administrator, manager, office, inbound, picker, stock |  | body deviceId, stationId, id | scan, result |

## health

| Method | Route | Permission | Roles | Module | Request | Response |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/health` | none, no sign-in | anyone |  | — | ok, auth |
| GET | `/api/health/figures` | `settings.read` | administrator, manager, office, technician |  | — | the handler's value |

## holders

| Method | Route | Permission | Roles | Module | Request | Response |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/holders` | `holders.read` | administrator, manager, office, technician, inbound, picker, stock |  | — | the record's own fields, contents |
| POST | `/api/holders` | `holders.write` | administrator, manager, inbound, stock |  | body id, type, clientId, parentId, tareKg, lengthMm, widthMm, heightMm, maxWeightKg, loc, contents | the command result |
| POST | `/api/holders/:id` | `holders.write` | administrator, manager, inbound, stock |  | path id; body id*, type, clientId, parentId, tareKg, lengthMm, widthMm, heightMm, maxWeightKg | the command result |
| GET | `/api/holders/:id/history` | `holders.read` | administrator, manager, office, technician, inbound, picker, stock |  | path id | id, series, parentId, children, history, movements |
| POST | `/api/holders/:id/load` | `holders.write` | administrator, manager, inbound, stock |  | path id; body id*, sscc, itemNo, qty, batch, expiry | the command result |
| POST | `/api/holders/:id/move` | `holders.write` | administrator, manager, inbound, stock |  | path id; body loc | the command result |
| POST | `/api/holders/:id/pick` | `picks.execute` | administrator, manager, picker |  | path id; body orderId, qty | the command result |
| POST | `/api/holders/:id/remove` | `holders.write` | administrator, manager, inbound, stock |  | path id | the command result |
| POST | `/api/holders/:id/unload` | `holders.write` | administrator, manager, inbound, stock |  | path id; body id*, sscc, index | the command result |
| POST | `/api/holders/issue` | `holders.write` | administrator, manager, inbound, stock |  | body sscc* | the command result |
| POST | `/api/holders/series` | `holders.write` | administrator, manager, inbound, stock |  | body series*, itemNo, qty, loc, batch, expiry, by | the command result |

## import

| Method | Route | Permission | Roles | Module | Request | Response |
| --- | --- | --- | --- | --- | --- | --- |
| POST | `/api/import/items` | `wms.write` | administrator, manager, office |  | body rows; each row itemNo, value | the command result |
| POST | `/api/import/locations` | `wms.write` | administrator, manager, office |  | body rows | the command result |
| POST | `/api/import/orders` | `wms.write` | administrator, manager, office |  | body rows; each row orderId, order, customer, lane, verifyLoading, minDays, units, itemNo, item, pallets, process | the command result |
| POST | `/api/import/stock` | `wms.write` | administrator, manager, office |  | body rows; each row code, sscc | the command result |

## inbox

| Method | Route | Permission | Roles | Module | Request | Response |
| --- | --- | --- | --- | --- | --- | --- |
| POST | `/api/inbox` | `intake.write` | administrator, manager, office, client | connections | body csv, type, documents | taken, refused, results |

## item-value

| Method | Route | Permission | Roles | Module | Request | Response |
| --- | --- | --- | --- | --- | --- | --- |
| POST | `/api/item-value/currency` | `items.value` | administrator, manager, office | item-value | body currency | the command result |

## items

| Method | Route | Permission | Roles | Module | Request | Response |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/items` | `items.read` | administrator, manager, office, inbound, picker, stock, client |  | — | the handler's value |
| POST | `/api/items` | `items.write` | administrator, manager, office, client |  | body clientId, status, itemNo, gtin, name, category, palletQty, minShipDays, storage, unitGtin, unitsPerCase, codes, uom, lengthMm, widthMm, heightMm, weightKg, barcodes, food, frozen, highValue, bestBefore, value | the command result |
| POST | `/api/items/:itemNo` | `items.write` | administrator, manager, office, client |  | path itemNo; body clientId, itemNo*, name, uom, bestBefore, storage, category, palletQty, reorderPoint, gtin, unitGtin, unitsPerCase, codes, barcodes, value, minShipDays, status, rack, lengthMm, widthMm, heightMm, weightKg | the command result |
| POST | `/api/items/:itemNo/approve` | `items.approve` | administrator, manager, office |  | path itemNo | the command result |
| POST | `/api/items/:itemNo/archive` | `items.write` | administrator, manager, office, client |  | path itemNo | the command result |
| POST | `/api/items/:itemNo/min-ship-days` | `wms.write` | administrator, manager, office | lots | path itemNo; body days | the command result |
| POST | `/api/items/:itemNo/photos` | `photos.write` | administrator, manager, office, client | photos | path itemNo; body data, name | file, bytes, sha256, targets, summary |
| GET | `/api/items/:itemNo/photos/:id` | `photos.read` | administrator, manager, office, client | photos | path itemNo, id | contentType, raw |
| POST | `/api/items/:itemNo/remove` | `items.write` | administrator, manager, office, client |  | path itemNo | the command result |
| POST | `/api/items/:itemNo/serials` | `items.write` | administrator, manager, office, client | serials | path itemNo; body on | the command result |
| POST | `/api/items/:itemNo/units` | `items.write` | administrator, manager, office, client |  | path itemNo; body itemNo*, base, unitWeightKg, packs | the command result |

## journal

| Method | Route | Permission | Roles | Module | Request | Response |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/journal` | `audit.read` | administrator, manager |  | query limit, op, by, before | the record's own fields, local |

## keys

| Method | Route | Permission | Roles | Module | Request | Response |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/keys` | `users.read` | administrator, manager | connections | — | keys |
| POST | `/api/keys` | `users.write` | administrator | connections | body name*, role*, clientId | key, id, name, role, roleLabel, clientId, createdAt, createdBy, lastUsed, revokedAt |
| POST | `/api/keys/:id/revoke` | `users.write` | administrator | connections | path id | created, username, mustChange |

## labels

| Method | Route | Permission | Roles | Module | Request | Response |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/labels/:id` | `labels.print` | administrator, manager, office, technician, inbound, picker, stock |  | path id | the record's own fields, html |
| GET | `/api/labels/:id/html` | `labels.print` | administrator, manager, office, technician, inbound, picker, stock |  | path id | contentType, raw |
| GET | `/api/labels/:id/zpl` | `labels.print` | administrator, manager, office, technician, inbound, picker, stock |  | path id | contentType, raw |
| POST | `/api/labels/master` | `labels.print` | administrator, manager, office, technician, inbound, picker, stock |  | — | result of issue |
| POST | `/api/labels/pallet` | `labels.print` | administrator, manager, office, technician, inbound, picker, stock |  | — | result of issue |
| GET | `/api/labels/sheet` | `labels.print` | administrator, manager, office, technician, inbound, picker, stock |  | query kind, codes, prefix, items, ids, layout, skip | contentType, raw |

## language

| Method | Route | Permission | Roles | Module | Request | Response |
| --- | --- | --- | --- | --- | --- | --- |
| POST | `/api/language` | none, no sign-in | anyone |  | body language | user, language |

## location-profiles

| Method | Route | Permission | Roles | Module | Request | Response |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/location-profiles` | `locations.read` | administrator, manager, office, technician, inbound, picker, stock |  | — | the handler's value |
| POST | `/api/location-profiles` | `technical.write` | administrator, technician |  | body id, name, storageType, capacity, temperature, security, autoSort, label, capacityMode | the command result |

## locations

| Method | Route | Permission | Roles | Module | Request | Response |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/locations` | `locations.read` | administrator, manager, office, technician, inbound, picker, stock |  | query kind, custom, q, limit | total, locations |
| POST | `/api/locations` | `locations.write` | administrator, manager, technician |  | body preserveCase, kind, code, parent, category, role, name, zone, aisle, rack, level, bin | the command result |
| POST | `/api/locations/:code/capacity` | `locations.write` | administrator, manager, technician |  | path code; body code* | the command result |
| POST | `/api/locations/:code/delete` | `locations.write` | administrator, manager, technician |  | path code | the command result |
| POST | `/api/locations/:code/unblock` | `wms.write` | administrator, manager, office |  | path code | the command result |
| GET | `/api/locations/aliases` | `locations.read` | administrator, manager, office, technician, inbound, picker, stock |  | — | the handler's value |
| POST | `/api/locations/aliases/drop` | `locations.write` | administrator, manager, technician |  | body code, prefix, all | the command result |
| POST | `/api/locations/bulk` | `technical.write` | administrator, technician |  | body profileId, aisleFrom, aisleTo, bayFrom, bayTo, heightFrom, heightTo | the command result |
| POST | `/api/locations/generate` | `settings.write` | administrator |  | body plan*, kind, capacity | the command result |
| POST | `/api/locations/guided` | `settings.write` | administrator |  | body answers* | the command result |
| POST | `/api/locations/guided/preview` | `settings.write` | administrator |  | body answers | total, sample, sampleCode, plans |
| POST | `/api/locations/preview` | `settings.write` | administrator |  | body plan | result of locationsLib |
| POST | `/api/locations/rename` | `locations.write` | administrator, manager, technician |  | body (whole) | the command result |
| POST | `/api/locations/rename/preview` | `locations.write` | administrator, manager, technician |  | body pairs, prefix, to | pairs |

## login

| Method | Route | Permission | Roles | Module | Request | Response |
| --- | --- | --- | --- | --- | --- | --- |
| POST | `/api/login` | none, no sign-in | anyone |  | body username, password | mfaRequired, mfaToken, user |
| GET | `/api/login/info` | none, no sign-in | anyone |  | — | demoUsers, language |
| POST | `/api/login/totp` | none, no sign-in | anyone |  | body mfaToken, code | user |

## logout

| Method | Route | Permission | Roles | Module | Request | Response |
| --- | --- | --- | --- | --- | --- | --- |
| POST | `/api/logout` | none, no sign-in | anyone |  | — | ok |

## lookup

| Method | Route | Permission | Roles | Module | Request | Response |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/lookup/:code` | `wms.read` | administrator, manager, office, technician, inbound, picker, stock |  | path code | kind, title, lines, text, belongsAt, pallet, pallets, location |

## lost

| Method | Route | Permission | Roles | Module | Request | Response |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/lost` | `wms.read` | administrator, manager, office, technician, inbound, picker, stock |  | — | sscc, itemNo, name, category, batch, expiry, qty, blockReason, shipState, loc, locName, qualityHold, qualityHistory, recallHold, holdReason, quarantine, quarantineHistory, orderId, inProcess, missingFrom, missingFromName |

## messages

| Method | Route | Permission | Roles | Module | Request | Response |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/messages` | `messages.read` | administrator, manager, office, client | connections | query after, limit, type | messages, next, last, more, gap |

## metrics

| Method | Route | Permission | Roles | Module | Request | Response |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/metrics` | `settings.read` | administrator, manager, office, technician |  | — | the handler's value |

## modules

| Method | Route | Permission | Roles | Module | Request | Response |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/modules` | `wms.read` | administrator, manager, office, technician, inbound, picker, stock |  | — | modules, simple |
| POST | `/api/modules/:id/settings` | `modules.write` | administrator, manager |  | path id; body settings | the command result |

## movements

| Method | Route | Permission | Roles | Module | Request | Response |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/movements` | `movements.read` | administrator, manager, stock |  | query user, holder | the handler's value |

## naming

| Method | Route | Permission | Roles | Module | Request | Response |
| --- | --- | --- | --- | --- | --- | --- |
| POST | `/api/naming` | `settings.write` | administrator |  | body show | the command result |

## notify

| Method | Route | Permission | Roles | Module | Request | Response |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/notify` | `alerts.read` | administrator, manager, office, stock, client | alerts | — | the handler's value |
| GET | `/api/notify/inbox` | `alerts.read` | administrator, manager, office, stock, client | alerts | — | the handler's value |
| POST | `/api/notify/read` | `alerts.read` | administrator, manager, office, stock, client | alerts | body ids | the handler's value |
| POST | `/api/notify/settings` | `alerts.write` | administrator, manager | alerts | — | ok |
| POST | `/api/notify/subscribe` | `alerts.read` | administrator, manager, office, stock, client | alerts | — | the handler's value |
| POST | `/api/notify/test` | `alerts.write` | administrator, manager | alerts | — | the handler's value |

## offsite

| Method | Route | Permission | Roles | Module | Request | Response |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/offsite` | `backups.offsite` | administrator | backup-offsite | — | the handler's value |
| POST | `/api/offsite/prune-plain` | `backups.offsite` | administrator | backup-offsite | body confirm | the handler's value |
| POST | `/api/offsite/restore` | `backups.offsite` | administrator | backup-offsite | body targetId, name, file | the handler's value |
| POST | `/api/offsite/run` | `backups.offsite` | administrator | backup-offsite | — | the handler's value |
| POST | `/api/offsite/settings` | `backups.offsite` | administrator | backup-offsite | — | ok |

## orders

| Method | Route | Permission | Roles | Module | Request | Response |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/orders` | `orders.read` | administrator, manager, office, picker, client |  | — | the record's own fields, trailerReadiness, shippingHolds |
| POST | `/api/orders` | `orders.write` | administrator, manager, office |  | body id*, customer*, lane*, lines*, verifyLoading, clientId, minDays | the command result |
| POST | `/api/orders/:id/carton` | `outbound.write` | administrator, manager, office, picker |  | path id | the command result |
| GET | `/api/orders/:id/delivery-note` | `orders.read` | administrator, manager, office, picker, client |  | path id | contentType, raw |
| POST | `/api/orders/:id/dispatch-cartons` | `outbound.write` | administrator, manager, office, picker |  | path id | the command result |
| GET | `/api/orders/:id/loading` | `wms.read` | administrator, manager, office, technician, inbound, picker, stock |  | path id | id, customer, lane, verifyLoading, loading, trailerReadiness, total, loaded, pallets |
| POST | `/api/orders/:id/loading` | `wms.write` | administrator, manager, office |  | path id; body trailer, inspectionPolicy | the command result |
| POST | `/api/orders/:id/loading/inspection` | `wms.write` | administrator, manager, office | food | path id; body id*, temperature, refrigerationOn, clean, dry, odorFree, damageFree, reason | the command result |
| POST | `/api/orders/:id/loading/release` | `wms.write` | administrator, manager, office | food | path id; body reason | the command result |
| POST | `/api/orders/:id/loading/scan` | `scans.execute` | administrator, manager, office, inbound, picker, stock |  | path id; body id*, device*, code*, unload | the command result |
| POST | `/api/orders/:id/pack` | `outbound.write` | administrator, manager, office, picker |  | path id; body note | the command result |
| GET | `/api/orders/:id/returnable` | `inbound.read` | administrator, manager, office, inbound | returns | path id | orderId, customer, shipped, lines, itemNo, name, uom, returned, left, serialized, serials |
| POST | `/api/orders/:id/ship` | `outbound.write` | administrator, manager, office, picker |  | path id; body seal | the command result |
| GET | `/api/orders/:id/shipment` | `orders.read` | administrator, manager, office, picker, client |  | path id | the handler's value |
| POST | `/api/orders/:id/shipment` | `outbound.write` | administrator, manager, office, picker |  | path id; body truck | the command result |
| POST | `/api/orders/:id/shipment/dispatch` | `outbound.write` | administrator, manager, office, picker |  | path id | the command result |
| POST | `/api/orders/:id/shipment/scan` | `outbound.write` | administrator, manager, office, picker |  | path id; body code | the command result |

## pairing

| Method | Route | Permission | Roles | Module | Request | Response |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/pairing` | `wms.read` | administrator, manager, office, technician, inbound, picker, stock | device-pairing | — | addresses, terminalPort, terminalError, idleHours |
| POST | `/api/pairing` | none, no sign-in | anyone | device-pairing | body userId, address | the record's own fields, addresses, expiresAt, username, requireSecret |
| POST | `/api/pairing/claim` | none, no sign-in | anyone | device-pairing | body token, code, secret | user, deviceId, idleHours |
| GET | `/api/pairing/status` | `wms.read` | administrator, manager, office, technician, inbound, picker, stock | device-pairing | query code | state, expiresAt, device |

## pallets

| Method | Route | Permission | Roles | Module | Request | Response |
| --- | --- | --- | --- | --- | --- | --- |
| POST | `/api/pallets/:sscc/allow-short` | `approvals.write` | administrator, manager | lots | path sscc | the command result |
| POST | `/api/pallets/:sscc/process` | `wms.write` | administrator, manager, office | stations | path sscc; body route | the command result |
| POST | `/api/pallets/:sscc/quality-release` | `approvals.write` | administrator, manager | food | path sscc; body reason | the command result |
| GET | `/api/pallets/:sscc/serials` | `stock.read` | every role | serials | path sscc | sscc, itemNo, qty, serialized, serials |
| POST | `/api/pallets/:sscc/serials` | `inbound.write` | administrator, manager, office, inbound | serials | path sscc; body serials | the command result |
| POST | `/api/pallets/:sscc/status` | `approvals.write` | administrator, manager |  | path sscc; body status, reason | the command result |
| POST | `/api/pallets/:sscc/temperature` | `approvals.write` | administrator, manager | food | path sscc; body temperature, min, max, reason | the command result |

## password

| Method | Route | Permission | Roles | Module | Request | Response |
| --- | --- | --- | --- | --- | --- | --- |
| POST | `/api/password` | `wms.read` | administrator, manager, office, technician, inbound, picker, stock |  | body current*, next* | user |

## password-rules

| Method | Route | Permission | Roles | Module | Request | Response |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/password-rules` | `users.read` | administrator, manager |  | — | rules, limits |
| POST | `/api/password-rules` | `users.write` | administrator |  | body minLength, history, maxAgeDays | rules, limits |

## photos

| Method | Route | Permission | Roles | Module | Request | Response |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/photos` | `photos.read` | administrator, manager, office, client | photos | — | the handler's value |

## pick-faces

| Method | Route | Permission | Roles | Module | Request | Response |
| --- | --- | --- | --- | --- | --- | --- |
| POST | `/api/pick-faces` | `putaway.execute` | administrator, manager, inbound |  | body code, itemNo, min, max, trigger | the command result |

## plan

| Method | Route | Permission | Roles | Module | Request | Response |
| --- | --- | --- | --- | --- | --- | --- |
| POST | `/api/plan/counts` | `counts.execute` | administrator, manager, stock | trucks | body from, to, limit | the command result |
| POST | `/api/plan/dig-out` | `wms.write` | administrator, manager, office | trucks | — | the command result |
| POST | `/api/plan/grouping` | `wms.write` | administrator, manager, office | trucks | — | the command result |

## print-queue

| Method | Route | Permission | Roles | Module | Request | Response |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/print-queue` | `wms.read` | administrator, manager, office, technician, inbound, picker, stock |  | — | jobs, results |

## printers

| Method | Route | Permission | Roles | Module | Request | Response |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/printers` | `wms.read` | administrator, manager, office, technician, inbound, picker, stock |  | — | the handler's value |
| GET | `/api/printers/:name/status` | `wms.read` | administrator, manager, office, technician, inbound, picker, stock |  | path name | the handler's value |

## process-log

| Method | Route | Permission | Roles | Module | Request | Response |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/process-log` | `wms.read` | administrator, manager, office, technician, inbound, picker, stock | stations | — | the handler's value |

## putaway

| Method | Route | Permission | Roles | Module | Request | Response |
| --- | --- | --- | --- | --- | --- | --- |
| POST | `/api/putaway` | `putaway.execute` | administrator, manager, inbound |  | body sscc*, to | the command result |
| GET | `/api/putaway/:sscc` | `putaway.execute` | administrator, manager, inbound |  | path sscc | sscc, itemNo, from, to |

## quality

| Method | Route | Permission | Roles | Module | Request | Response |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/quality` | `wms.read` | administrator, manager, office, technician, inbound, picker, stock | food | — | sscc, itemNo, name, category, batch, expiry, qty, blockReason, shipState, loc, locName, qualityHold, qualityHistory, recallHold, holdReason, quarantine, quarantineHistory, orderId, inProcess |

## quarantine

| Method | Route | Permission | Roles | Module | Request | Response |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/quarantine` | `wms.read` | administrator, manager, office, technician, inbound, picker, stock | quarantine | — | sscc, itemNo, name, category, batch, expiry, qty, blockReason, shipState, loc, locName, qualityHold, qualityHistory, recallHold, holdReason, quarantine, quarantineHistory, orderId, inProcess, move, waitingForSpace |
| POST | `/api/quarantine/locations` | `approvals.write` | administrator, manager | quarantine | body from*, to*, reason*, enabled | the command result |
| POST | `/api/quarantine/release` | `approvals.write` | administrator, manager | quarantine | body sscc*, reason* | the command result |
| POST | `/api/quarantine/request` | `approvals.write` | administrator, manager | quarantine | body sscc*, reason* | the command result |

## recalls

| Method | Route | Permission | Roles | Module | Request | Response |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/recalls` | `wms.read` | administrator, manager, office, technician, inbound, picker, stock | lots | — | the record's own fields, inStock |
| POST | `/api/recalls` | `approvals.write` | administrator, manager | lots | body itemNo, batch, reason | the command result |
| GET | `/api/recalls/preview` | `wms.read` | administrator, manager, office, technician, inbound, picker, stock | lots | query itemNo, batch | the record's own fields, inStock |
| POST | `/api/recalls/release` | `approvals.write` | administrator, manager | lots | body itemNo, batch, reason | the command result |

## replenish

| Method | Route | Permission | Roles | Module | Request | Response |
| --- | --- | --- | --- | --- | --- | --- |
| POST | `/api/replenish` | `replenish.execute` | administrator, manager, stock |  | body itemNo*, to*, topUp | the command result |

## replenishment

| Method | Route | Permission | Roles | Module | Request | Response |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/replenishment` | `stock.read` | every role |  | — | the record's own fields, text, source, quantity |
| POST | `/api/replenishment/plan` | `replenish.execute` | administrator, manager, stock |  | — | the command result |

## reports

| Method | Route | Permission | Roles | Module | Request | Response |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/reports/area` | `reports.read` | administrator, manager, office, stock, client | reports | — | timeZone, asOf, filters, catalog, reports |
| GET | `/api/reports/area/:name` | `reports.read` | administrator, manager, office, stock, client | reports | path name | the record's own fields, id, title, hidden, reason, columns, rows, filters, timeZone, asOf |
| GET | `/api/reports/area/:name.csv` | `reports.read` | administrator, manager, office, stock, client | reports | path name | csv |
| GET | `/api/reports/availability` | `reports.read` | administrator, manager, office, stock, client |  | — | the handler's value |
| GET | `/api/reports/availability.csv` | `reports.read` | administrator, manager, office, stock, client |  | — | csv |
| GET | `/api/reports/availability.json` | `reports.read` | administrator, manager, office, stock, client |  | — | the handler's value |
| GET | `/api/reports/billing` | `reports.read` | administrator, manager, office, stock, client | billing | query clientId | clientId, name, palletDays, moves, storageRate, handlingRate, storage, handling, total |
| GET | `/api/reports/billing.csv` | `reports.read` | administrator, manager, office, stock, client | billing | query clientId | csv |
| GET | `/api/reports/billing.html` | `reports.read` | administrator, manager, office, stock, client | billing | query clientId, from, to | contentType, raw |
| GET | `/api/reports/expiry` | `reports.read` | administrator, manager, office, stock, client | lots | query days; body expiry | sscc, itemNo, name, category, batch, expiry, qty, blockReason, shipState, loc, locName, qualityHold, qualityHistory, recallHold, holdReason, quarantine, quarantineHistory, orderId, inProcess, daysLeft |
| GET | `/api/reports/invoice` | `reports.read` | administrator, manager, office, stock, client | billing | query clientId, from, to | clientId, name, from, to, periodFrom, periodTo, timeZone, country, tariff, lines, subtotal, minimum, minimumVersion, total, palletDays, moves |
| GET | `/api/reports/invoice.csv` | `reports.read` | administrator, manager, office, stock, client | billing | query clientId, from, to | csv |
| GET | `/api/reports/orders` | `reports.read` | administrator, manager, office, stock, client |  | — | id, customer, clientId, lane, pallets, short |
| GET | `/api/reports/stock` | `reports.read` | administrator, manager, office, stock, client |  | — | itemNo, name, clientId, category, available, short, blocked, qty, batches, nextExpiry |
| GET | `/api/reports/stock-changes` | `reports.read` | administrator, manager, office, stock, client |  | query from, to | from, to, rows, net |
| GET | `/api/reports/stock-changes.csv` | `reports.read` | administrator, manager, office, stock, client |  | query from, to | csv |
| GET | `/api/reports/stock-value` | `reports.read` | administrator, manager, office, stock, client | item-value | query client, clientId | currency, total, rows |
| GET | `/api/reports/stock-value.csv` | `reports.read` | administrator, manager, office, stock, client | item-value | query client, clientId | csv |
| GET | `/api/reports/stock.csv` | `reports.read` | administrator, manager, office, stock, client |  | — | csv |

## return-moves

| Method | Route | Permission | Roles | Module | Request | Response |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/return-moves` | `wms.read` | administrator, manager, office, technician, inbound, picker, stock | return-move | — | tasks |

## returns

| Method | Route | Permission | Roles | Module | Request | Response |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/returns` | `inbound.read` | administrator, manager, office, inbound | returns | query status, order | the handler's value |
| POST | `/api/returns` | `inbound.write` | administrator, manager, office, inbound | returns | body orderId*, id, lines, itemNo, qty, serials, loc, reason, note | the command result |
| POST | `/api/returns/:id/grade` | `inbound.write` | administrator, manager, office, inbound | returns | path id; body id*, grade*, itemNo, qty, to, serials, batch, expiry, from | the command result |

## roles

| Method | Route | Permission | Roles | Module | Request | Response |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/roles` | `roles.read` | administrator, manager |  | — | permissions, roles |
| POST | `/api/roles/:role` | `roles.write` | administrator |  | path role; body permissions | role, permissions |

## routes

| Method | Route | Permission | Roles | Module | Request | Response |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/routes` | `wms.read` | administrator, manager, office, technician, inbound, picker, stock | stations | — | id, name, steps |

## scan-commands

| Method | Route | Permission | Roles | Module | Request | Response |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/scan-commands` | `wms.read` | administrator, manager, office, technician, inbound, picker, stock |  | — | code, label, group, confirm |

## search

| Method | Route | Permission | Roles | Module | Request | Response |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/search` | `wms.read` | administrator, manager, office, technician, inbound, picker, stock |  | query q | the record's own fields, items |

## sendcloud

| Method | Route | Permission | Roles | Module | Request | Response |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/sendcloud` | `sendcloud.manage` | administrator | sendcloud | — | account, rules, parcels, errors |
| POST | `/api/sendcloud/account` | `sendcloud.manage` | administrator | sendcloud | body senderName, senderAddress, senderCity, senderPostal, senderCountry, publicKey, secretKey, webhookSecret | the handler's value |
| POST | `/api/sendcloud/label` | `sendcloud.manage` | administrator | sendcloud | body orderId | orderId, tracking, trackingUrl, file, carrier, service, weightKg, lengthCm, widthCm, heightCm |
| POST | `/api/sendcloud/return` | `sendcloud.manage` | administrator | sendcloud | body returnId, weightKg | returnId, tracking, file, carrier |
| POST | `/api/sendcloud/rules` | `sendcloud.manage` | administrator | sendcloud | body clientId, country, minKg, maxKg, methodId, carrier, service | id, clientId, country, minKg, maxKg, methodId, carrier, service |
| POST | `/api/sendcloud/webhook` | `wms.write` | administrator, manager, office | sendcloud | query token | the handler's value |

## serials

| Method | Route | Permission | Roles | Module | Request | Response |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/serials` | `stock.read` | every role | serials | query loc, item | the handler's value |
| GET | `/api/serials/:sn` | `stock.read` | every role | serials | path sn | sn, itemNo, name, loc, sscc, carton, orderId, customer, shippedAt, history |

## session

| Method | Route | Permission | Roles | Module | Request | Response |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/session` | none, no sign-in | anyone |  | body by | user, features, categories, itemApproval, language, timeZone, currency, itemValue |

## setup

| Method | Route | Permission | Roles | Module | Request | Response |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/setup` | `settings.write` | administrator |  | — | setup, features, categories, presets, featureList, modules, examples, levels |
| POST | `/api/setup/complete` | `settings.write` | administrator |  | — | the command result |
| POST | `/api/setup/features` | `settings.write` | administrator |  | body features | the command result |
| POST | `/api/setup/modules` | `modules.write` | administrator, manager |  | body modules, enableDependencies, disableDependents | file, bytes, sha256, targets, summary |
| POST | `/api/setup/preset` | `settings.write` | administrator |  | body id* | the command result |

## shift

| Method | Route | Permission | Roles | Module | Request | Response |
| --- | --- | --- | --- | --- | --- | --- |
| POST | `/api/shift/start` | `wms.write` | administrator, manager, office | trucks | — | the command result |

## shopify

| Method | Route | Permission | Roles | Module | Request | Response |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/shopify` | `shopify.manage` | administrator | shopify | — | the handler's value |
| POST | `/api/shopify/catalog` | `shopify.manage` | administrator | shopify | body shopId | the handler's value |
| POST | `/api/shopify/map` | `shopify.manage` | administrator | shopify | body shopId, sku, itemNo | the handler's value |
| GET | `/api/shopify/map/:id` | `shopify.manage` | administrator | shopify | path id | the handler's value |
| POST | `/api/shopify/shops` | `shopify.manage` | administrator | shopify | — | the handler's value |
| POST | `/api/shopify/stock` | `shopify.manage` | administrator | shopify | — | the handler's value |
| POST | `/api/shopify/sync` | `shopify.manage` | administrator | shopify | body shopId | the handler's value |

## sites

| Method | Route | Permission | Roles | Module | Request | Response |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/sites` | `wms.read` | administrator, manager, office, technician, inbound, picker, stock | sites | — | current, sites |
| POST | `/api/sites` | `sites.write` | administrator | sites | body id*, name*, preset*, country*, timeZone* | id, name |
| POST | `/api/sites/switch` | `sites.switch` | administrator, manager, office, technician, inbound, picker, stock | sites | body id | current, sites |
| POST | `/api/sites/transfer` | `moves.execute` | administrator, manager, stock | transfers | body from, to, itemNo, qty, id | the handler's value |
| POST | `/api/sites/transfers/:id/cancel` | `moves.execute` | administrator, manager, stock | transfers | path id; body from | the handler's value |
| POST | `/api/sites/transfers/:id/receive` | `moves.execute` | administrator, manager, stock | transfers | path id; body from, to | the record's own fields, holder |

## stations

| Method | Route | Permission | Roles | Module | Request | Response |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/stations` | `wms.read` | administrator, manager, office, technician, inbound, picker, stock | stations | — | id, name, machine, minutes, dwell, capacity |
| GET | `/api/stations/:id` | `wms.read` | administrator, manager, office, technician, inbound, picker, stock | stations | path id | station, queue, working, dwelling, waiting, coming |
| POST | `/api/stations/:id/scan` | `scans.execute` | administrator, manager, office, inbound, picker, stock | stations | path id; body code | the command result |

## stock

| Method | Route | Permission | Roles | Module | Request | Response |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/stock` | `stock.read` | every role |  | — | the record's own fields, item, next |
| POST | `/api/stock/:sscc/delete` | `stock.delete` | administrator, manager, stock |  | path sscc; body reason | the command result |
| POST | `/api/stock/adjust` | `stock.adjust` | administrator, manager, stock |  | body sscc*, reason*, qty | the command result |
| GET | `/api/stock/at/:code` | `stock.read` | every role |  | path code | the handler's value |
| POST | `/api/stock/correct` | `stock.delete` | administrator, manager, stock |  | body target*, itemNo*, fromItem, qty, reason, by | the command result |
| POST | `/api/stock/create` | `stock.create` | administrator, manager, stock |  | body code, sscc, itemNo, qty, batch, expiry, reason, by | the command result |

## summary

| Method | Route | Permission | Roles | Module | Request | Response |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/summary` | `wms.read` | administrator, manager, office, technician, inbound, picker, stock |  | — | openJobs, activeJobs, heldJobs, trucks, orders, pallets, lost, cantShip, inProcess, categories, naming, config, jobOrderNow |

## tasks

| Method | Route | Permission | Roles | Module | Request | Response |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/tasks` | `wms.read` | administrator, manager, office, technician, inbound, picker, stock |  | query status | planning, id, type, typeLabel, category, reason, sscc, from, fromName, to, toName, step, orderId, deliveryId, truckId, urgent, why, labelCode, alert, heldReason, createdAt |
| POST | `/api/tasks/:taskId/cancel` | `tasks.assign` | administrator, manager |  | path taskId | the command result |
| POST | `/api/tasks/:taskId/release` | `approvals.write` | administrator, manager |  | path taskId | the command result |
| POST | `/api/tasks/:taskId/urgent` | `tasks.assign` | administrator, manager |  | path taskId; body urgent | the command result |

## technical

| Method | Route | Permission | Roles | Module | Request | Response |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/technical` | `wms.read` | administrator, manager, office, technician, inbound, picker, stock |  | — | holderSeries |
| POST | `/api/technical` | `technical.write` | administrator, technician |  | body autoSort, locationDefaults, holderSeries | the command result |

## template

| Method | Route | Permission | Roles | Module | Request | Response |
| --- | --- | --- | --- | --- | --- | --- |
| POST | `/api/template/apply` | `wms.write` | administrator, manager, office |  | body from*, to*, category | the record's own fields, moves |
| GET | `/api/template/preview` | `wms.read` | administrator, manager, office, technician, inbound, picker, stock |  | query from, to, category | the record's own fields, first, last |

## totp

| Method | Route | Permission | Roles | Module | Request | Response |
| --- | --- | --- | --- | --- | --- | --- |
| POST | `/api/totp/disable` | `wms.read` | administrator, manager, office, technician, inbound, picker, stock |  | body password*, code* | user |
| POST | `/api/totp/enable` | `wms.read` | administrator, manager, office, technician, inbound, picker, stock |  | body code | user |
| POST | `/api/totp/setup` | `wms.read` | administrator, manager, office, technician, inbound, picker, stock |  | — | secret, otpauth |

## trace

| Method | Route | Permission | Roles | Module | Request | Response |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/trace/:batch` | `wms.read` | administrator, manager, office, technician, inbound, picker, stock | lots | path batch | the record's own fields, inStock |

## transfer

| Method | Route | Permission | Roles | Module | Request | Response |
| --- | --- | --- | --- | --- | --- | --- |
| POST | `/api/transfer` | `moves.execute` | administrator, manager, stock |  | body sscc*, to* | the command result |

## transfers

| Method | Route | Permission | Roles | Module | Request | Response |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/transfers` | `wms.read` | administrator, manager, office, technician, inbound, picker, stock |  | — | the record's own fields, fromName, toName |

## user-audit

| Method | Route | Permission | Roles | Module | Request | Response |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/user-audit.csv` | `user-audit.read` | administrator, manager | user-audit | query from, to | csv |

## users

| Method | Route | Permission | Roles | Module | Request | Response |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/users` | `users.read` | administrator, manager |  | — | users |
| POST | `/api/users` | `users.write` | administrator |  | body language, username*, password*, role*, displayName*, clientId | user |
| POST | `/api/users/:id` | `users.write` | administrator |  | path id; body role, active, displayName, password, clientId, sites, language, by | user |
| POST | `/api/users/:id/reset-password` | `users.write` | administrator |  | path id | username, temporaryPassword |
| POST | `/api/users/:id/terminal` | `users.write` | administrator |  | path id; body pin, badge, clear | user |

## val

| Method | Route | Permission | Roles | Module | Request | Response |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/val` | `val.execute` | administrator, manager, picker | kitting | — | stations, kits, jobs |
| POST | `/api/val/scan` | `val.execute` | administrator, manager, picker | kitting | body stationId*, code* | the command result |
| POST | `/api/val/start` | `val.execute` | administrator, manager, picker | kitting | body stationId*, workOrderId | the command result |

## waves

| Method | Route | Permission | Roles | Module | Request | Response |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/waves` | `tasks.read` | administrator, manager, office, inbound, picker, stock | waves | — | the record's own fields, tasks |
| POST | `/api/waves` | `orders.write` | administrator, manager, office | waves | body id, orders | the command result |
| POST | `/api/waves/:id/cancel` | `orders.write` | administrator, manager, office | waves | path id | the command result |
| POST | `/api/waves/config` | `orders.write` | administrator, manager, office | waves | body auto, maxWaitMin, maxOrders, postPick | the command result |
| GET | `/api/waves/queue` | `tasks.read` | administrator, manager, office, inbound, picker, stock | waves | — | settings, active, queue |
| GET | `/api/waves/tasks` | `tasks.read` | administrator, manager, office, inbound, picker, stock | waves | query kind, mine | the handler's value |
| POST | `/api/waves/tasks/:task/claim` | `picks.execute` | administrator, manager, picker | waves | path task | the command result |
| POST | `/api/waves/tasks/:task/confirm` | `picks.execute` | administrator, manager, picker | waves | path task; body scan, serials | the command result |
| POST | `/api/waves/tasks/:task/release` | `picks.execute` | administrator, manager, picker | waves | path task | the command result |
| POST | `/api/waves/tasks/:task/short` | `picks.execute` | administrator, manager, picker | waves | path task; body found | the command result |

## webhooks

| Method | Route | Permission | Roles | Module | Request | Response |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/webhooks` | `users.read` | administrator, manager | connections | — | webhooks, types |
| POST | `/api/webhooks` | `users.write` | administrator | connections | body url*, types, clientId, site, fromStart | id, url, types, clientId, site, delivered, waiting, failures, nextTry, lastOk, lastError, createdAt, createdBy, secret |
| POST | `/api/webhooks/:id/remove` | `users.write` | administrator | connections | path id | removed |
| POST | `/api/webhooks/:id/retry` | `users.write` | administrator | connections | path id | removed |

## woocommerce

| Method | Route | Permission | Roles | Module | Request | Response |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/woocommerce` | `woocommerce.manage` | administrator | woocommerce | — | the handler's value |
| POST | `/api/woocommerce/catalog` | `woocommerce.manage` | administrator | woocommerce | body shopId | the handler's value |
| POST | `/api/woocommerce/map` | `woocommerce.manage` | administrator | woocommerce | body shopId, sku, itemNo | the handler's value |
| GET | `/api/woocommerce/map/:id` | `woocommerce.manage` | administrator | woocommerce | path id | the handler's value |
| POST | `/api/woocommerce/shops` | `woocommerce.manage` | administrator | woocommerce | — | the handler's value |
| POST | `/api/woocommerce/stock` | `woocommerce.manage` | administrator | woocommerce | — | the handler's value |
| POST | `/api/woocommerce/sync` | `woocommerce.manage` | administrator | woocommerce | body shopId | the handler's value |

## work-orders

| Method | Route | Permission | Roles | Module | Request | Response |
| --- | --- | --- | --- | --- | --- | --- |
| POST | `/api/work-orders` | `val.execute` | administrator, manager, picker | kitting | body id*, kitId*, qty, orderId | the command result |

## workload

| Method | Route | Permission | Roles | Module | Request | Response |
| --- | --- | --- | --- | --- | --- | --- |
| POST | `/api/workload` | `wms.write` | administrator, manager, office | demo | body seed, picks, inbound | the command result |
