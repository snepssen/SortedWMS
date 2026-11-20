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
- `:id` and the like are parts of the address you fill in.
- The fields of each body are not listed here yet. The screens in `server/public/` and the tests in `test/` show them in use.

## abc

| Method | Route | Permission | Roles | Module |
| --- | --- | --- | --- | --- |
| GET | `/api/abc` | `counts.execute` | administrator, manager, stock | abc |
| GET | `/api/abc.csv` | `counts.execute` | administrator, manager, stock |  |
| POST | `/api/abc/:id/approve` | `counts.approve` | administrator, manager | abc |
| POST | `/api/abc/:id/count` | `counts.execute` | administrator, manager, stock | abc |
| POST | `/api/abc/:id/recount` | `counts.execute` | administrator, manager, stock | abc |
| POST | `/api/abc/:id/reject` | `counts.approve` | administrator, manager | abc |
| POST | `/api/abc/class` | `counts.approve` | administrator, manager | abc |
| GET | `/api/abc/classes` | `counts.execute` | administrator, manager, stock | abc |
| GET | `/api/abc/mine` | `counts.execute` | administrator, manager, stock | abc |
| POST | `/api/abc/plan` | `counts.execute` | administrator, manager, stock | abc |
| POST | `/api/abc/settings` | `counts.approve` | administrator, manager | abc |

## aisles

| Method | Route | Permission | Roles | Module |
| --- | --- | --- | --- | --- |
| POST | `/api/aisles/:aisle/cell` | `settings.write` | administrator |  |
| POST | `/api/aisles/:aisle/direction` | `settings.write` | administrator | trucks |

## alerts

| Method | Route | Permission | Roles | Module |
| --- | --- | --- | --- | --- |
| GET | `/api/alerts/low-stock` | `reports.read` | administrator, manager, office, stock, client |  |
| GET | `/api/alerts/low-stock.csv` | `reports.read` | administrator, manager, office, stock, client |  |

## auth-log

| Method | Route | Permission | Roles | Module |
| --- | --- | --- | --- | --- |
| GET | `/api/auth-log` | `audit.read` | administrator, manager |  |

## backup

| Method | Route | Permission | Roles | Module |
| --- | --- | --- | --- | --- |
| GET | `/api/backup` | `settings.write` | administrator |  |
| POST | `/api/backup` | `settings.write` | administrator |  |

## backups

| Method | Route | Permission | Roles | Module |
| --- | --- | --- | --- | --- |
| GET | `/api/backups` | `settings.write` | administrator |  |
| POST | `/api/backups` | `settings.write` | administrator |  |

## best-before

| Method | Route | Permission | Roles | Module |
| --- | --- | --- | --- | --- |
| GET | `/api/best-before` | `stock.read` | every role | lots |

## bins

| Method | Route | Permission | Roles | Module |
| --- | --- | --- | --- | --- |
| GET | `/api/bins` | `stock.read` | every role | bins |
| GET | `/api/bins/:code` | `stock.read` | every role | bins |
| POST | `/api/bins/:code/mode` | `locations.write` | administrator, manager, technician | bins |
| POST | `/api/bins/count` | `counts.execute` | administrator, manager, stock | bins |
| POST | `/api/bins/move` | `moves.execute` | administrator, manager, stock | bins |
| POST | `/api/bins/put` | `inbound.write` | administrator, manager, office, inbound | bins |
| POST | `/api/bins/refill` | `replenish.execute` | administrator, manager, stock | bins |
| GET | `/api/bins/suggest` | `stock.read` | every role | bins |
| POST | `/api/bins/take` | `picks.execute` | administrator, manager, picker | bins |

## blocked

| Method | Route | Permission | Roles | Module |
| --- | --- | --- | --- | --- |
| GET | `/api/blocked` | `wms.read` | administrator, manager, office, technician, inbound, picker, stock |  |

## boms

| Method | Route | Permission | Roles | Module |
| --- | --- | --- | --- | --- |
| POST | `/api/boms` | `bom.write` | administrator, manager, office | bom |
| POST | `/api/boms/build` | `bom.write` | administrator, manager, office | bom |

## cartons

| Method | Route | Permission | Roles | Module |
| --- | --- | --- | --- | --- |
| POST | `/api/cartons/:id/close` | `outbound.write` | administrator, manager, office, picker |  |
| POST | `/api/cartons/:id/pack` | `outbound.write` | administrator, manager, office, picker |  |
| GET | `/api/cartons/:id/slip.html` | `orders.read` | administrator, manager, office, picker, client |  |

## categories

| Method | Route | Permission | Roles | Module |
| --- | --- | --- | --- | --- |
| POST | `/api/categories` | `settings.write` | administrator |  |

## checks

| Method | Route | Permission | Roles | Module |
| --- | --- | --- | --- | --- |
| GET | `/api/checks` | `stock.read` | every role |  |
| POST | `/api/checks` | `stock.check` | administrator, manager, office, picker, stock |  |
| POST | `/api/checks/:id/close` | `stock.adjust` | administrator, manager, stock |  |

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

| Method | Route | Permission | Roles | Module |
| --- | --- | --- | --- | --- |
| GET | `/api/clients` | `clients.read` | administrator, manager, office, client | clients |
| POST | `/api/clients` | `clients.write` | administrator, manager, office | clients |
| GET | `/api/clients/:id` | `clients.read` | administrator, manager, office, client | clients |
| POST | `/api/clients/:id` | `clients.write` | administrator, manager, office | clients |
| POST | `/api/clients/:id/archive` | `clients.write` | administrator, manager, office | clients |
| POST | `/api/clients/:id/restore` | `clients.write` | administrator, manager, office | clients |
| POST | `/api/clients/:id/space` | `tariff.write` | administrator, manager, office | billing |
| POST | `/api/clients/:id/tariff` | `tariff.write` | administrator, manager, office | billing |

## config

| Method | Route | Permission | Roles | Module |
| --- | --- | --- | --- | --- |
| POST | `/api/config` | `settings.write` | administrator |  |

## consolidate

| Method | Route | Permission | Roles | Module |
| --- | --- | --- | --- | --- |
| POST | `/api/consolidate` | `holders.write` | administrator, manager, inbound, stock |  |

## counts

| Method | Route | Permission | Roles | Module |
| --- | --- | --- | --- | --- |
| GET | `/api/counts` | `wms.read` | administrator, manager, office, technician, inbound, picker, stock |  |

## customers

| Method | Route | Permission | Roles | Module |
| --- | --- | --- | --- | --- |
| GET | `/api/customers` | `wms.read` | administrator, manager, office, technician, inbound, picker, stock |  |
| POST | `/api/customers` | `wms.write` | administrator, manager, office |  |

## deliveries

| Method | Route | Permission | Roles | Module |
| --- | --- | --- | --- | --- |
| GET | `/api/deliveries` | `inbound.read` | administrator, manager, office, inbound |  |
| POST | `/api/deliveries` | `inbound.write` | administrator, manager, office, inbound |  |

## desks

| Method | Route | Permission | Roles | Module |
| --- | --- | --- | --- | --- |
| POST | `/api/desks/:id/enter` | `scans.execute` | administrator, manager, office, inbound, picker, stock |  |
| POST | `/api/desks/:id/start` | `scans.execute` | administrator, manager, office, inbound, picker, stock |  |

## devices

| Method | Route | Permission | Roles | Module |
| --- | --- | --- | --- | --- |
| GET | `/api/devices` | `wms.read` | administrator, manager, office, technician, inbound, picker, stock | trucks |
| POST | `/api/devices` | `tasks.assign` | administrator, manager | trucks |
| GET | `/api/devices/:id` | `wms.read` | administrator, manager, office, technician, inbound, picker, stock | trucks |
| POST | `/api/devices/:id/categories` | `tasks.assign` | administrator, manager | trucks |
| POST | `/api/devices/:id/duty` | `tasks.assign` | administrator, manager | trucks |
| POST | `/api/devices/:id/equipment` | `tasks.assign` | administrator, manager | trucks |
| POST | `/api/devices/:id/finish-receiving` | `scans.execute` | administrator, manager, office, inbound, picker, stock | trucks |
| POST | `/api/devices/:id/mode` | `scans.execute` | administrator, manager, office, inbound, picker, stock | trucks |
| POST | `/api/devices/:id/operator` | `tasks.assign` | administrator, manager | trucks |
| POST | `/api/devices/:id/pending` | `scans.execute` | administrator, manager, office, inbound, picker, stock | trucks |
| POST | `/api/devices/:id/problem` | `scans.execute` | administrator, manager, office, inbound, picker, stock | trucks |
| POST | `/api/devices/:id/qty` | `scans.execute` | administrator, manager, office, inbound, picker, stock | trucks |
| POST | `/api/devices/:id/scan` | `scans.execute` | administrator, manager, office, inbound, picker, stock | trucks |
| GET | `/api/devices/paired` | `devices.manage` | administrator, manager | device-pairing |
| POST | `/api/devices/paired/:id/rename` | `devices.manage` | administrator, manager | device-pairing |
| POST | `/api/devices/paired/:id/revoke` | `devices.manage` | administrator, manager | device-pairing |
| POST | `/api/devices/paired/revoke-all` | `devices.manage` | administrator, manager | device-pairing |

## documents

| Method | Route | Permission | Roles | Module |
| --- | --- | --- | --- | --- |
| GET | `/api/documents/delivery-note/:id` | `documents.read` | administrator, manager, office, client | documents |
| GET | `/api/documents/packing-list/:id` | `documents.read` | administrator, manager, office, client | documents |
| GET | `/api/documents/pick-list/:id` | `documents.read` | administrator, manager, office, client | documents |
| GET | `/api/documents/statement/:clientId` | `documents.read` | administrator, manager, office, client | documents |

## drivers

| Method | Route | Permission | Roles | Module |
| --- | --- | --- | --- | --- |
| GET | `/api/drivers` | `wms.read` | administrator, manager, office, technician, inbound, picker, stock | trucks |

## equipment

| Method | Route | Permission | Roles | Module |
| --- | --- | --- | --- | --- |
| GET | `/api/equipment` | `wms.read` | administrator, manager, office, technician, inbound, picker, stock |  |
| POST | `/api/equipment` | `equipment.write` | administrator, manager, technician |  |
| POST | `/api/equipment/:id/fault` | `equipment.write` | administrator, manager, technician |  |
| POST | `/api/equipment/:id/maintenance` | `equipment.write` | administrator, manager, technician |  |

## etsy

| Method | Route | Permission | Roles | Module |
| --- | --- | --- | --- | --- |
| GET | `/api/etsy` | `etsy.manage` | administrator | etsy |
| GET | `/api/etsy/callback` | `wms.read` | administrator, manager, office, technician, inbound, picker, stock | etsy |
| POST | `/api/etsy/catalog` | `etsy.manage` | administrator | etsy |
| POST | `/api/etsy/connect` | `etsy.manage` | administrator | etsy |
| POST | `/api/etsy/map` | `etsy.manage` | administrator | etsy |
| GET | `/api/etsy/map/:id` | `etsy.manage` | administrator | etsy |
| POST | `/api/etsy/shops` | `etsy.manage` | administrator | etsy |
| POST | `/api/etsy/stock` | `etsy.manage` | administrator | etsy |
| POST | `/api/etsy/sync` | `etsy.manage` | administrator | etsy |

## events

| Method | Route | Permission | Roles | Module |
| --- | --- | --- | --- | --- |
| GET | `/api/events` | `wms.read` | administrator, manager, office, technician, inbound, picker, stock |  |

## exceptions

| Method | Route | Permission | Roles | Module |
| --- | --- | --- | --- | --- |
| GET | `/api/exceptions` | `tasks.read` | administrator, manager, office, inbound, picker, stock |  |

## faults

| Method | Route | Permission | Roles | Module |
| --- | --- | --- | --- | --- |
| POST | `/api/faults/:id/close` | `equipment.write` | administrator, manager, technician |  |

## hardware

| Method | Route | Permission | Roles | Module |
| --- | --- | --- | --- | --- |
| GET | `/api/hardware` | `wms.read` | administrator, manager, office, technician, inbound, picker, stock |  |
| POST | `/api/hardware/mode` | `equipment.write` | administrator, manager, technician |  |
| POST | `/api/hardware/print` | `labels.print` | administrator, manager, office, technician, inbound, picker, stock |  |
| POST | `/api/hardware/scan` | `scans.execute` | administrator, manager, office, inbound, picker, stock |  |

## health

| Method | Route | Permission | Roles | Module |
| --- | --- | --- | --- | --- |
| GET | `/api/health` | none, no sign-in | anyone |  |
| GET | `/api/health/figures` | `settings.read` | administrator, manager, office, technician |  |

## holders

| Method | Route | Permission | Roles | Module |
| --- | --- | --- | --- | --- |
| GET | `/api/holders` | `holders.read` | administrator, manager, office, technician, inbound, picker, stock |  |
| POST | `/api/holders` | `holders.write` | administrator, manager, inbound, stock |  |
| POST | `/api/holders/:id` | `holders.write` | administrator, manager, inbound, stock |  |
| GET | `/api/holders/:id/history` | `holders.read` | administrator, manager, office, technician, inbound, picker, stock |  |
| POST | `/api/holders/:id/load` | `holders.write` | administrator, manager, inbound, stock |  |
| POST | `/api/holders/:id/move` | `holders.write` | administrator, manager, inbound, stock |  |
| POST | `/api/holders/:id/pick` | `picks.execute` | administrator, manager, picker |  |
| POST | `/api/holders/:id/remove` | `holders.write` | administrator, manager, inbound, stock |  |
| POST | `/api/holders/:id/unload` | `holders.write` | administrator, manager, inbound, stock |  |
| POST | `/api/holders/issue` | `holders.write` | administrator, manager, inbound, stock |  |
| POST | `/api/holders/series` | `holders.write` | administrator, manager, inbound, stock |  |

## import

| Method | Route | Permission | Roles | Module |
| --- | --- | --- | --- | --- |
| POST | `/api/import/items` | `wms.write` | administrator, manager, office |  |
| POST | `/api/import/locations` | `wms.write` | administrator, manager, office |  |
| POST | `/api/import/orders` | `wms.write` | administrator, manager, office |  |
| POST | `/api/import/stock` | `wms.write` | administrator, manager, office |  |

## inbox

| Method | Route | Permission | Roles | Module |
| --- | --- | --- | --- | --- |
| POST | `/api/inbox` | `intake.write` | administrator, manager, office, client | connections |

## item-value

| Method | Route | Permission | Roles | Module |
| --- | --- | --- | --- | --- |
| POST | `/api/item-value/currency` | `items.value` | administrator, manager, office | item-value |

## items

| Method | Route | Permission | Roles | Module |
| --- | --- | --- | --- | --- |
| GET | `/api/items` | `items.read` | administrator, manager, office, inbound, picker, stock, client |  |
| POST | `/api/items` | `items.write` | administrator, manager, office, client |  |
| POST | `/api/items/:itemNo` | `items.write` | administrator, manager, office, client |  |
| POST | `/api/items/:itemNo/approve` | `items.approve` | administrator, manager, office |  |
| POST | `/api/items/:itemNo/archive` | `items.write` | administrator, manager, office, client |  |
| POST | `/api/items/:itemNo/min-ship-days` | `wms.write` | administrator, manager, office | lots |
| POST | `/api/items/:itemNo/photos` | `photos.write` | administrator, manager, office, client | photos |
| GET | `/api/items/:itemNo/photos/:id` | `photos.read` | administrator, manager, office, client | photos |
| POST | `/api/items/:itemNo/remove` | `items.write` | administrator, manager, office, client |  |
| POST | `/api/items/:itemNo/serials` | `items.write` | administrator, manager, office, client | serials |
| POST | `/api/items/:itemNo/units` | `items.write` | administrator, manager, office, client |  |

## journal

| Method | Route | Permission | Roles | Module |
| --- | --- | --- | --- | --- |
| GET | `/api/journal` | `audit.read` | administrator, manager |  |

## keys

| Method | Route | Permission | Roles | Module |
| --- | --- | --- | --- | --- |
| GET | `/api/keys` | `users.read` | administrator, manager | connections |
| POST | `/api/keys` | `users.write` | administrator | connections |
| POST | `/api/keys/:id/revoke` | `users.write` | administrator | connections |

## labels

| Method | Route | Permission | Roles | Module |
| --- | --- | --- | --- | --- |
| GET | `/api/labels/:id` | `labels.print` | administrator, manager, office, technician, inbound, picker, stock |  |
| GET | `/api/labels/:id/html` | `labels.print` | administrator, manager, office, technician, inbound, picker, stock |  |
| GET | `/api/labels/:id/zpl` | `labels.print` | administrator, manager, office, technician, inbound, picker, stock |  |
| POST | `/api/labels/master` | `labels.print` | administrator, manager, office, technician, inbound, picker, stock |  |
| POST | `/api/labels/pallet` | `labels.print` | administrator, manager, office, technician, inbound, picker, stock |  |
| GET | `/api/labels/sheet` | `labels.print` | administrator, manager, office, technician, inbound, picker, stock |  |

## language

| Method | Route | Permission | Roles | Module |
| --- | --- | --- | --- | --- |
| POST | `/api/language` | none, no sign-in | anyone |  |

## location-profiles

| Method | Route | Permission | Roles | Module |
| --- | --- | --- | --- | --- |
| GET | `/api/location-profiles` | `locations.read` | administrator, manager, office, technician, inbound, picker, stock |  |
| POST | `/api/location-profiles` | `technical.write` | administrator, technician |  |

## locations

| Method | Route | Permission | Roles | Module |
| --- | --- | --- | --- | --- |
| GET | `/api/locations` | `locations.read` | administrator, manager, office, technician, inbound, picker, stock |  |
| POST | `/api/locations` | `locations.write` | administrator, manager, technician |  |
| POST | `/api/locations/:code/capacity` | `locations.write` | administrator, manager, technician |  |
| POST | `/api/locations/:code/delete` | `locations.write` | administrator, manager, technician |  |
| POST | `/api/locations/:code/unblock` | `wms.write` | administrator, manager, office |  |
| GET | `/api/locations/aliases` | `locations.read` | administrator, manager, office, technician, inbound, picker, stock |  |
| POST | `/api/locations/aliases/drop` | `locations.write` | administrator, manager, technician |  |
| POST | `/api/locations/bulk` | `technical.write` | administrator, technician |  |
| POST | `/api/locations/generate` | `settings.write` | administrator |  |
| POST | `/api/locations/guided` | `settings.write` | administrator |  |
| POST | `/api/locations/guided/preview` | `settings.write` | administrator |  |
| POST | `/api/locations/preview` | `settings.write` | administrator |  |
| POST | `/api/locations/rename` | `locations.write` | administrator, manager, technician |  |
| POST | `/api/locations/rename/preview` | `locations.write` | administrator, manager, technician |  |

## login

| Method | Route | Permission | Roles | Module |
| --- | --- | --- | --- | --- |
| POST | `/api/login` | none, no sign-in | anyone |  |
| GET | `/api/login/info` | none, no sign-in | anyone |  |
| POST | `/api/login/totp` | none, no sign-in | anyone |  |

## logout

| Method | Route | Permission | Roles | Module |
| --- | --- | --- | --- | --- |
| POST | `/api/logout` | none, no sign-in | anyone |  |

## lookup

| Method | Route | Permission | Roles | Module |
| --- | --- | --- | --- | --- |
| GET | `/api/lookup/:code` | `wms.read` | administrator, manager, office, technician, inbound, picker, stock |  |

## lost

| Method | Route | Permission | Roles | Module |
| --- | --- | --- | --- | --- |
| GET | `/api/lost` | `wms.read` | administrator, manager, office, technician, inbound, picker, stock |  |

## messages

| Method | Route | Permission | Roles | Module |
| --- | --- | --- | --- | --- |
| GET | `/api/messages` | `messages.read` | administrator, manager, office, client | connections |

## metrics

| Method | Route | Permission | Roles | Module |
| --- | --- | --- | --- | --- |
| GET | `/api/metrics` | `settings.read` | administrator, manager, office, technician |  |

## modules

| Method | Route | Permission | Roles | Module |
| --- | --- | --- | --- | --- |
| GET | `/api/modules` | `wms.read` | administrator, manager, office, technician, inbound, picker, stock |  |
| POST | `/api/modules/:id/settings` | `modules.write` | administrator, manager |  |

## movements

| Method | Route | Permission | Roles | Module |
| --- | --- | --- | --- | --- |
| GET | `/api/movements` | `movements.read` | administrator, manager, stock |  |

## naming

| Method | Route | Permission | Roles | Module |
| --- | --- | --- | --- | --- |
| POST | `/api/naming` | `settings.write` | administrator |  |

## notify

| Method | Route | Permission | Roles | Module |
| --- | --- | --- | --- | --- |
| GET | `/api/notify` | `alerts.read` | administrator, manager, office, stock, client | alerts |
| GET | `/api/notify/inbox` | `alerts.read` | administrator, manager, office, stock, client | alerts |
| POST | `/api/notify/read` | `alerts.read` | administrator, manager, office, stock, client | alerts |
| POST | `/api/notify/settings` | `alerts.write` | administrator, manager | alerts |
| POST | `/api/notify/subscribe` | `alerts.read` | administrator, manager, office, stock, client | alerts |
| POST | `/api/notify/test` | `alerts.write` | administrator, manager | alerts |

## offsite

| Method | Route | Permission | Roles | Module |
| --- | --- | --- | --- | --- |
| GET | `/api/offsite` | `backups.offsite` | administrator | backup-offsite |
| POST | `/api/offsite/prune-plain` | `backups.offsite` | administrator | backup-offsite |
| POST | `/api/offsite/restore` | `backups.offsite` | administrator | backup-offsite |
| POST | `/api/offsite/run` | `backups.offsite` | administrator | backup-offsite |
| POST | `/api/offsite/settings` | `backups.offsite` | administrator | backup-offsite |

## orders

| Method | Route | Permission | Roles | Module |
| --- | --- | --- | --- | --- |
| GET | `/api/orders` | `orders.read` | administrator, manager, office, picker, client |  |
| POST | `/api/orders` | `orders.write` | administrator, manager, office |  |
| POST | `/api/orders/:id/carton` | `outbound.write` | administrator, manager, office, picker |  |
| GET | `/api/orders/:id/delivery-note` | `orders.read` | administrator, manager, office, picker, client |  |
| POST | `/api/orders/:id/dispatch-cartons` | `outbound.write` | administrator, manager, office, picker |  |
| GET | `/api/orders/:id/loading` | `wms.read` | administrator, manager, office, technician, inbound, picker, stock |  |
| POST | `/api/orders/:id/loading` | `wms.write` | administrator, manager, office |  |
| POST | `/api/orders/:id/loading/inspection` | `wms.write` | administrator, manager, office | food |
| POST | `/api/orders/:id/loading/release` | `wms.write` | administrator, manager, office | food |
| POST | `/api/orders/:id/loading/scan` | `scans.execute` | administrator, manager, office, inbound, picker, stock |  |
| POST | `/api/orders/:id/pack` | `outbound.write` | administrator, manager, office, picker |  |
| GET | `/api/orders/:id/returnable` | `inbound.read` | administrator, manager, office, inbound | returns |
| POST | `/api/orders/:id/ship` | `outbound.write` | administrator, manager, office, picker |  |
| GET | `/api/orders/:id/shipment` | `orders.read` | administrator, manager, office, picker, client |  |
| POST | `/api/orders/:id/shipment` | `outbound.write` | administrator, manager, office, picker |  |
| POST | `/api/orders/:id/shipment/dispatch` | `outbound.write` | administrator, manager, office, picker |  |
| POST | `/api/orders/:id/shipment/scan` | `outbound.write` | administrator, manager, office, picker |  |

## pairing

| Method | Route | Permission | Roles | Module |
| --- | --- | --- | --- | --- |
| GET | `/api/pairing` | `wms.read` | administrator, manager, office, technician, inbound, picker, stock | device-pairing |
| POST | `/api/pairing` | none, no sign-in | anyone | device-pairing |
| POST | `/api/pairing/claim` | none, no sign-in | anyone | device-pairing |
| GET | `/api/pairing/status` | `wms.read` | administrator, manager, office, technician, inbound, picker, stock | device-pairing |

## pallets

| Method | Route | Permission | Roles | Module |
| --- | --- | --- | --- | --- |
| POST | `/api/pallets/:sscc/allow-short` | `approvals.write` | administrator, manager | lots |
| POST | `/api/pallets/:sscc/process` | `wms.write` | administrator, manager, office | stations |
| POST | `/api/pallets/:sscc/quality-release` | `approvals.write` | administrator, manager | food |
| GET | `/api/pallets/:sscc/serials` | `stock.read` | every role | serials |
| POST | `/api/pallets/:sscc/serials` | `inbound.write` | administrator, manager, office, inbound | serials |
| POST | `/api/pallets/:sscc/status` | `approvals.write` | administrator, manager |  |
| POST | `/api/pallets/:sscc/temperature` | `approvals.write` | administrator, manager | food |

## password

| Method | Route | Permission | Roles | Module |
| --- | --- | --- | --- | --- |
| POST | `/api/password` | `wms.read` | administrator, manager, office, technician, inbound, picker, stock |  |

## password-rules

| Method | Route | Permission | Roles | Module |
| --- | --- | --- | --- | --- |
| GET | `/api/password-rules` | `users.read` | administrator, manager |  |
| POST | `/api/password-rules` | `users.write` | administrator |  |

## photos

| Method | Route | Permission | Roles | Module |
| --- | --- | --- | --- | --- |
| GET | `/api/photos` | `photos.read` | administrator, manager, office, client | photos |

## pick-faces

| Method | Route | Permission | Roles | Module |
| --- | --- | --- | --- | --- |
| POST | `/api/pick-faces` | `putaway.execute` | administrator, manager, inbound |  |

## plan

| Method | Route | Permission | Roles | Module |
| --- | --- | --- | --- | --- |
| POST | `/api/plan/counts` | `counts.execute` | administrator, manager, stock | trucks |
| POST | `/api/plan/dig-out` | `wms.write` | administrator, manager, office | trucks |
| POST | `/api/plan/grouping` | `wms.write` | administrator, manager, office | trucks |

## print-queue

| Method | Route | Permission | Roles | Module |
| --- | --- | --- | --- | --- |
| GET | `/api/print-queue` | `wms.read` | administrator, manager, office, technician, inbound, picker, stock |  |

## printers

| Method | Route | Permission | Roles | Module |
| --- | --- | --- | --- | --- |
| GET | `/api/printers` | `wms.read` | administrator, manager, office, technician, inbound, picker, stock |  |
| GET | `/api/printers/:name/status` | `wms.read` | administrator, manager, office, technician, inbound, picker, stock |  |

## process-log

| Method | Route | Permission | Roles | Module |
| --- | --- | --- | --- | --- |
| GET | `/api/process-log` | `wms.read` | administrator, manager, office, technician, inbound, picker, stock | stations |

## putaway

| Method | Route | Permission | Roles | Module |
| --- | --- | --- | --- | --- |
| POST | `/api/putaway` | `putaway.execute` | administrator, manager, inbound |  |
| GET | `/api/putaway/:sscc` | `putaway.execute` | administrator, manager, inbound |  |

## quality

| Method | Route | Permission | Roles | Module |
| --- | --- | --- | --- | --- |
| GET | `/api/quality` | `wms.read` | administrator, manager, office, technician, inbound, picker, stock | food |

## quarantine

| Method | Route | Permission | Roles | Module |
| --- | --- | --- | --- | --- |
| GET | `/api/quarantine` | `wms.read` | administrator, manager, office, technician, inbound, picker, stock | quarantine |
| POST | `/api/quarantine/locations` | `approvals.write` | administrator, manager | quarantine |
| POST | `/api/quarantine/release` | `approvals.write` | administrator, manager | quarantine |
| POST | `/api/quarantine/request` | `approvals.write` | administrator, manager | quarantine |

## recalls

| Method | Route | Permission | Roles | Module |
| --- | --- | --- | --- | --- |
| GET | `/api/recalls` | `wms.read` | administrator, manager, office, technician, inbound, picker, stock | lots |
| POST | `/api/recalls` | `approvals.write` | administrator, manager | lots |
| GET | `/api/recalls/preview` | `wms.read` | administrator, manager, office, technician, inbound, picker, stock | lots |
| POST | `/api/recalls/release` | `approvals.write` | administrator, manager | lots |

## replenish

| Method | Route | Permission | Roles | Module |
| --- | --- | --- | --- | --- |
| POST | `/api/replenish` | `replenish.execute` | administrator, manager, stock |  |

## replenishment

| Method | Route | Permission | Roles | Module |
| --- | --- | --- | --- | --- |
| GET | `/api/replenishment` | `stock.read` | every role |  |
| POST | `/api/replenishment/plan` | `replenish.execute` | administrator, manager, stock |  |

## reports

| Method | Route | Permission | Roles | Module |
| --- | --- | --- | --- | --- |
| GET | `/api/reports/area` | `reports.read` | administrator, manager, office, stock, client | reports |
| GET | `/api/reports/area/:name` | `reports.read` | administrator, manager, office, stock, client | reports |
| GET | `/api/reports/area/:name.csv` | `reports.read` | administrator, manager, office, stock, client | reports |
| GET | `/api/reports/availability` | `reports.read` | administrator, manager, office, stock, client |  |
| GET | `/api/reports/availability.csv` | `reports.read` | administrator, manager, office, stock, client |  |
| GET | `/api/reports/availability.json` | `reports.read` | administrator, manager, office, stock, client |  |
| GET | `/api/reports/billing` | `reports.read` | administrator, manager, office, stock, client | billing |
| GET | `/api/reports/billing.csv` | `reports.read` | administrator, manager, office, stock, client | billing |
| GET | `/api/reports/billing.html` | `reports.read` | administrator, manager, office, stock, client | billing |
| GET | `/api/reports/expiry` | `reports.read` | administrator, manager, office, stock, client | lots |
| GET | `/api/reports/invoice` | `reports.read` | administrator, manager, office, stock, client | billing |
| GET | `/api/reports/invoice.csv` | `reports.read` | administrator, manager, office, stock, client | billing |
| GET | `/api/reports/orders` | `reports.read` | administrator, manager, office, stock, client |  |
| GET | `/api/reports/stock` | `reports.read` | administrator, manager, office, stock, client |  |
| GET | `/api/reports/stock-changes` | `reports.read` | administrator, manager, office, stock, client |  |
| GET | `/api/reports/stock-changes.csv` | `reports.read` | administrator, manager, office, stock, client |  |
| GET | `/api/reports/stock-value` | `reports.read` | administrator, manager, office, stock, client | item-value |
| GET | `/api/reports/stock-value.csv` | `reports.read` | administrator, manager, office, stock, client | item-value |
| GET | `/api/reports/stock.csv` | `reports.read` | administrator, manager, office, stock, client |  |

## return-moves

| Method | Route | Permission | Roles | Module |
| --- | --- | --- | --- | --- |
| GET | `/api/return-moves` | `wms.read` | administrator, manager, office, technician, inbound, picker, stock | return-move |

## returns

| Method | Route | Permission | Roles | Module |
| --- | --- | --- | --- | --- |
| GET | `/api/returns` | `inbound.read` | administrator, manager, office, inbound | returns |
| POST | `/api/returns` | `inbound.write` | administrator, manager, office, inbound | returns |
| POST | `/api/returns/:id/grade` | `inbound.write` | administrator, manager, office, inbound | returns |

## roles

| Method | Route | Permission | Roles | Module |
| --- | --- | --- | --- | --- |
| GET | `/api/roles` | `roles.read` | administrator, manager |  |
| POST | `/api/roles/:role` | `roles.write` | administrator |  |

## routes

| Method | Route | Permission | Roles | Module |
| --- | --- | --- | --- | --- |
| GET | `/api/routes` | `wms.read` | administrator, manager, office, technician, inbound, picker, stock | stations |

## scan-commands

| Method | Route | Permission | Roles | Module |
| --- | --- | --- | --- | --- |
| GET | `/api/scan-commands` | `wms.read` | administrator, manager, office, technician, inbound, picker, stock |  |

## search

| Method | Route | Permission | Roles | Module |
| --- | --- | --- | --- | --- |
| GET | `/api/search` | `wms.read` | administrator, manager, office, technician, inbound, picker, stock |  |

## sendcloud

| Method | Route | Permission | Roles | Module |
| --- | --- | --- | --- | --- |
| GET | `/api/sendcloud` | `sendcloud.manage` | administrator | sendcloud |
| POST | `/api/sendcloud/account` | `sendcloud.manage` | administrator | sendcloud |
| POST | `/api/sendcloud/label` | `sendcloud.manage` | administrator | sendcloud |
| POST | `/api/sendcloud/return` | `sendcloud.manage` | administrator | sendcloud |
| POST | `/api/sendcloud/rules` | `sendcloud.manage` | administrator | sendcloud |
| POST | `/api/sendcloud/webhook` | `wms.write` | administrator, manager, office | sendcloud |

## serials

| Method | Route | Permission | Roles | Module |
| --- | --- | --- | --- | --- |
| GET | `/api/serials` | `stock.read` | every role | serials |
| GET | `/api/serials/:sn` | `stock.read` | every role | serials |

## session

| Method | Route | Permission | Roles | Module |
| --- | --- | --- | --- | --- |
| GET | `/api/session` | none, no sign-in | anyone |  |

## setup

| Method | Route | Permission | Roles | Module |
| --- | --- | --- | --- | --- |
| GET | `/api/setup` | `settings.write` | administrator |  |
| POST | `/api/setup/complete` | `settings.write` | administrator |  |
| POST | `/api/setup/features` | `settings.write` | administrator |  |
| POST | `/api/setup/modules` | `modules.write` | administrator, manager |  |
| POST | `/api/setup/preset` | `settings.write` | administrator |  |

## shift

| Method | Route | Permission | Roles | Module |
| --- | --- | --- | --- | --- |
| POST | `/api/shift/start` | `wms.write` | administrator, manager, office | trucks |

## shopify

| Method | Route | Permission | Roles | Module |
| --- | --- | --- | --- | --- |
| GET | `/api/shopify` | `shopify.manage` | administrator | shopify |
| POST | `/api/shopify/catalog` | `shopify.manage` | administrator | shopify |
| POST | `/api/shopify/map` | `shopify.manage` | administrator | shopify |
| GET | `/api/shopify/map/:id` | `shopify.manage` | administrator | shopify |
| POST | `/api/shopify/shops` | `shopify.manage` | administrator | shopify |
| POST | `/api/shopify/stock` | `shopify.manage` | administrator | shopify |
| POST | `/api/shopify/sync` | `shopify.manage` | administrator | shopify |

## sites

| Method | Route | Permission | Roles | Module |
| --- | --- | --- | --- | --- |
| GET | `/api/sites` | `wms.read` | administrator, manager, office, technician, inbound, picker, stock | sites |
| POST | `/api/sites` | `sites.write` | administrator | sites |
| POST | `/api/sites/switch` | `sites.switch` | administrator, manager, office, technician, inbound, picker, stock | sites |
| POST | `/api/sites/transfer` | `moves.execute` | administrator, manager, stock | transfers |
| POST | `/api/sites/transfers/:id/cancel` | `moves.execute` | administrator, manager, stock | transfers |
| POST | `/api/sites/transfers/:id/receive` | `moves.execute` | administrator, manager, stock | transfers |

## stations

| Method | Route | Permission | Roles | Module |
| --- | --- | --- | --- | --- |
| GET | `/api/stations` | `wms.read` | administrator, manager, office, technician, inbound, picker, stock | stations |
| GET | `/api/stations/:id` | `wms.read` | administrator, manager, office, technician, inbound, picker, stock | stations |
| POST | `/api/stations/:id/scan` | `scans.execute` | administrator, manager, office, inbound, picker, stock | stations |

## stock

| Method | Route | Permission | Roles | Module |
| --- | --- | --- | --- | --- |
| GET | `/api/stock` | `stock.read` | every role |  |
| POST | `/api/stock/:sscc/delete` | `stock.delete` | administrator, manager, stock |  |
| POST | `/api/stock/adjust` | `stock.adjust` | administrator, manager, stock |  |
| GET | `/api/stock/at/:code` | `stock.read` | every role |  |
| POST | `/api/stock/correct` | `stock.delete` | administrator, manager, stock |  |
| POST | `/api/stock/create` | `stock.create` | administrator, manager, stock |  |

## summary

| Method | Route | Permission | Roles | Module |
| --- | --- | --- | --- | --- |
| GET | `/api/summary` | `wms.read` | administrator, manager, office, technician, inbound, picker, stock |  |

## tasks

| Method | Route | Permission | Roles | Module |
| --- | --- | --- | --- | --- |
| GET | `/api/tasks` | `wms.read` | administrator, manager, office, technician, inbound, picker, stock |  |
| POST | `/api/tasks/:taskId/cancel` | `tasks.assign` | administrator, manager |  |
| POST | `/api/tasks/:taskId/release` | `approvals.write` | administrator, manager |  |
| POST | `/api/tasks/:taskId/urgent` | `tasks.assign` | administrator, manager |  |

## technical

| Method | Route | Permission | Roles | Module |
| --- | --- | --- | --- | --- |
| GET | `/api/technical` | `wms.read` | administrator, manager, office, technician, inbound, picker, stock |  |
| POST | `/api/technical` | `technical.write` | administrator, technician |  |

## template

| Method | Route | Permission | Roles | Module |
| --- | --- | --- | --- | --- |
| POST | `/api/template/apply` | `wms.write` | administrator, manager, office |  |
| GET | `/api/template/preview` | `wms.read` | administrator, manager, office, technician, inbound, picker, stock |  |

## totp

| Method | Route | Permission | Roles | Module |
| --- | --- | --- | --- | --- |
| POST | `/api/totp/disable` | `wms.read` | administrator, manager, office, technician, inbound, picker, stock |  |
| POST | `/api/totp/enable` | `wms.read` | administrator, manager, office, technician, inbound, picker, stock |  |
| POST | `/api/totp/setup` | `wms.read` | administrator, manager, office, technician, inbound, picker, stock |  |

## trace

| Method | Route | Permission | Roles | Module |
| --- | --- | --- | --- | --- |
| GET | `/api/trace/:batch` | `wms.read` | administrator, manager, office, technician, inbound, picker, stock | lots |

## transfer

| Method | Route | Permission | Roles | Module |
| --- | --- | --- | --- | --- |
| POST | `/api/transfer` | `moves.execute` | administrator, manager, stock |  |

## transfers

| Method | Route | Permission | Roles | Module |
| --- | --- | --- | --- | --- |
| GET | `/api/transfers` | `wms.read` | administrator, manager, office, technician, inbound, picker, stock |  |

## user-audit

| Method | Route | Permission | Roles | Module |
| --- | --- | --- | --- | --- |
| GET | `/api/user-audit.csv` | `user-audit.read` | administrator, manager | user-audit |

## users

| Method | Route | Permission | Roles | Module |
| --- | --- | --- | --- | --- |
| GET | `/api/users` | `users.read` | administrator, manager |  |
| POST | `/api/users` | `users.write` | administrator |  |
| POST | `/api/users/:id` | `users.write` | administrator |  |
| POST | `/api/users/:id/reset-password` | `users.write` | administrator |  |
| POST | `/api/users/:id/terminal` | `users.write` | administrator |  |

## val

| Method | Route | Permission | Roles | Module |
| --- | --- | --- | --- | --- |
| GET | `/api/val` | `val.execute` | administrator, manager, picker | kitting |
| POST | `/api/val/scan` | `val.execute` | administrator, manager, picker | kitting |
| POST | `/api/val/start` | `val.execute` | administrator, manager, picker | kitting |

## waves

| Method | Route | Permission | Roles | Module |
| --- | --- | --- | --- | --- |
| GET | `/api/waves` | `tasks.read` | administrator, manager, office, inbound, picker, stock | waves |
| POST | `/api/waves` | `orders.write` | administrator, manager, office | waves |
| POST | `/api/waves/:id/cancel` | `orders.write` | administrator, manager, office | waves |
| POST | `/api/waves/config` | `orders.write` | administrator, manager, office | waves |
| GET | `/api/waves/queue` | `tasks.read` | administrator, manager, office, inbound, picker, stock | waves |
| GET | `/api/waves/tasks` | `tasks.read` | administrator, manager, office, inbound, picker, stock | waves |
| POST | `/api/waves/tasks/:task/claim` | `picks.execute` | administrator, manager, picker | waves |
| POST | `/api/waves/tasks/:task/confirm` | `picks.execute` | administrator, manager, picker | waves |
| POST | `/api/waves/tasks/:task/release` | `picks.execute` | administrator, manager, picker | waves |
| POST | `/api/waves/tasks/:task/short` | `picks.execute` | administrator, manager, picker | waves |

## webhooks

| Method | Route | Permission | Roles | Module |
| --- | --- | --- | --- | --- |
| GET | `/api/webhooks` | `users.read` | administrator, manager | connections |
| POST | `/api/webhooks` | `users.write` | administrator | connections |
| POST | `/api/webhooks/:id/remove` | `users.write` | administrator | connections |
| POST | `/api/webhooks/:id/retry` | `users.write` | administrator | connections |

## woocommerce

| Method | Route | Permission | Roles | Module |
| --- | --- | --- | --- | --- |
| GET | `/api/woocommerce` | `woocommerce.manage` | administrator | woocommerce |
| POST | `/api/woocommerce/catalog` | `woocommerce.manage` | administrator | woocommerce |
| POST | `/api/woocommerce/map` | `woocommerce.manage` | administrator | woocommerce |
| GET | `/api/woocommerce/map/:id` | `woocommerce.manage` | administrator | woocommerce |
| POST | `/api/woocommerce/shops` | `woocommerce.manage` | administrator | woocommerce |
| POST | `/api/woocommerce/stock` | `woocommerce.manage` | administrator | woocommerce |
| POST | `/api/woocommerce/sync` | `woocommerce.manage` | administrator | woocommerce |

## work-orders

| Method | Route | Permission | Roles | Module |
| --- | --- | --- | --- | --- |
| POST | `/api/work-orders` | `val.execute` | administrator, manager, picker | kitting |

## workload

| Method | Route | Permission | Roles | Module |
| --- | --- | --- | --- | --- |
| POST | `/api/workload` | `wms.write` | administrator, manager, office | demo |
