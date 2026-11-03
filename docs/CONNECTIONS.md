# Connections

How other systems (a webshop, an ERP, a carrier, a client's own system) work with SortedWMS.

- **They sign in with an API key.** An administrator makes one per system.
- **They read what the warehouse confirms** from a numbered message log: goods received, orders shipped, returns, stock adjustments.

Every example below uses made-up names and numbers.

## API keys

An administrator makes a key under **Connections** in the app, or with `POST /api/keys`. Each key has:

- **a name** for the system that uses it, for example `webshop`;
- **one role**, which decides what the key may do. Choose the role of the work it does, for example `office` for an ERP;
- **a client**, for a key with the `client` role. Such a key only sees that client's items, stock, orders and messages.

A key is never an administrator. It is shown once, when it is made, and only its hash is kept. Revoke it under Connections (`POST /api/keys/:id/revoke`) and the system using it is locked out at once. Making and revoking keys is in the sign-in audit log. Every change a key makes is in the journal, under `key:<name>`.

Send the key with every call, either way:

```
Authorization: Bearer swk_…
X-Api-Key: swk_…
```

```bash
curl -H "Authorization: Bearer $SORTED_KEY" http://localhost:8080/api/orders
```

## Messages out

The warehouse writes a message each time something happens that another system needs to know about. Messages are numbered `1, 2, 3 …` in the order they happen.

A reader keeps the last number it handled and asks for what came after it:

```
GET /api/messages?after=0&limit=100
```

```json
{
  "messages": [ { "seq": 1, "type": "delivery.received", "t": "2026-11-02T06:42:10.000Z", "clientId": "CL-PAINT", "data": { … } } ],
  "next": 100,
  "last": 245,
  "more": true,
  "gap": false
}
```

- **`next`:** what to ask `after` next time. Store it once the messages are handled.
- **`more`:** there are more messages to read right away.
- **`last`:** the newest number so far.
- **`gap: true`:** messages after the number you asked from were dropped, because the newest 20,000 are kept. Start again from a full stock report (`GET /api/reports/stock`).
- **`type`:** optional filter for one or more types, for example `?type=order.shipped,delivery.received`.
- **A client key** sees only its own client's messages.

Reading changes nothing, so a reader can ask as often as it likes. If it was offline, it carries on from its last number and nothing is lost. The log is part of the warehouse's own state, so a restart or a restore from backup numbers it the same way.

A loop that reads every minute:

```bash
after=$(cat last-seq 2>/dev/null || echo 0)
while :; do
  page=$(curl -s -H "Authorization: Bearer $SORTED_KEY" "http://localhost:8080/api/messages?after=$after&limit=500")
  # … hand each message in $page to your system …
  after=$(echo "$page" | node -pe 'JSON.parse(require("fs").readFileSync(0)).next')
  echo "$after" > last-seq
  sleep 60
done
```

### `delivery.received`

A delivery is closed. It lists the pallets that came in, with batch, best-before and the serial numbers booked on them, and how many were short.

```json
{
  "deliveryId": "IN-0003", "asn": "ASN-77120", "ref": null, "supplier": "Brightwall factory",
  "expected": 6, "received": 6, "short": 0,
  "pallets": [
    { "sscc": "106141410002000017", "itemNo": "W1001", "qty": 60, "batch": "L280301A", "expiry": "2028-03-21" }
  ]
}
```

A pallet that arrived already past its best-before carries `"held": "Expired on arrival"`.

### `order.shipped`

An order has left the building. This covers all three ways out: whole pallets loaded, cartons dispatched, or one shipment of both.

```json
{
  "orderId": "SO-1102-014", "ref": null, "customer": "Harbour Hardware", "lane": "OUT-02",
  "carrier": "Carrier 2", "trailer": null, "seal": null, "shippedAt": "2026-11-02T09:14:00.000Z",
  "lines": [ { "itemNo": "T4001", "ordered": { "pallets": 1 }, "shipped": 40 } ],
  "pallets": [ { "sscc": "006141410001000844", "itemNo": "T4001", "qty": 40, "batch": "L0001B", "expiry": null } ],
  "cartons": [],
  "serials": [ { "sn": "T4001-10008401", "itemNo": "T4001", "on": "006141410001000844" } ]
}
```

- **`lines`:** for each item, what was ordered (`units` or `pallets`) and the units that went.
- **`cartons`:** each carton has its weight and size, and lines with batch, best-before and serials.
- **`serials`:** every serial number that left, and the pallet or carton it was on.

### `return.received` and `return.graded`

A customer sent something back, booked against what shipped (`return.received`). Then it was graded (`return.graded`):

- **`restock`:** back into stock, with `to` saying where;
- **`quarantine`:** on hold;
- **`scrap`:** thrown away.

```json
{ "returnId": "RMA-2", "orderId": "SO-1102-007", "customer": "Corner Builders", "reason": "Ordered too many", "lines": [ { "itemNo": "F3001", "qty": 2 } ] }
{ "returnId": "RMA-2", "orderId": "SO-1102-007", "itemNo": "F3001", "grade": "restock", "qty": 2, "to": "Pick-Shelf1-Bin4-Low" }
```

### `stock.adjusted`

Stock changed outside the flow of orders and deliveries, for example a count, a correction, stock found, stock written off, or a return restocked.

```json
{ "loc": "Pick-Shelf1-Bin3-High", "sscc": null, "itemNo": "F3002", "batch": null, "before": 30, "after": 29, "change": -1, "reason": "recount", "by": "S1" }
```

## Into the warehouse: orders and ASNs

Another system sends orders and ASNs (a supplier's advance shipping notice) to one intake:

```
POST /api/inbox
```

This needs the `intake.write` permission, which the office and client roles have.

Every document carries **the sender's own reference, `ref`**. That makes sending safe to repeat:

- **The same document again** is recognised. The answer is `"status": "duplicate"`, with the order or delivery it made the first time. A system that isn't sure its last call arrived just sends it again.
- **The same ref with other content** is refused (HTTP 409). Nothing is booked twice or quietly changed. Change it in the warehouse, or send it under a new ref.
- **The ref comes back** on the order's or delivery's messages (`"ref"` in `order.shipped`, `delivery.received` and returns).

Items are found by item number or GTIN (`itemNo`, `gtin`, `ean` or `sku`).

### An order

```json
{
  "type": "order", "ref": "WEB-1001", "clientId": "CL-FIX", "customer": "Harbour Hardware",
  "lines": [ { "itemNo": "F3001", "units": 6 }, { "gtin": "6141410000113", "units": 24 } ]
}
```

- **Lines:** each is in `units` (picked in the waves) or whole `pallets`.
- **`lane`:** optional. Without one, the order goes to the shipping lane with the fewest open orders.
- **`minDays`:** optional. The fewest days of best-before this customer accepts.
- **Order number:** the ref, when it can be one. Otherwise the client and the ref, or a number.

The answer:

```json
{ "status": "created", "type": "order", "ref": "WEB-1001", "id": "WEB-1001" }
```

### An ASN

```json
{
  "type": "asn", "ref": "ASN-55", "clientId": "CL-PAINT", "supplier": "Brightwall factory", "expectedAt": "2026-11-03",
  "pallets": [
    { "sscc": "706141410000000011", "itemNo": "W1001", "qty": 60, "batch": "B7", "expiry": "2028-01-31" },
    { "sscc": "706141410000000028", "itemNo": "T4001", "qty": 40, "batch": "L9", "serials": ["T4001-0001", "…"] }
  ]
}
```

- **What it books:** a delivery with the supplier's pallet list. At the dock, one scan of a pallet's SSCC receives it with everything on the list: item, quantity, batch, best-before and serials.
- **Quantity:** a pallet without `qty` is a full pallet of its item.
- **Category:** an ASN is for one category. It comes from the pallets, or you name it with `category`.
- **Labels without a list:** `"at": "desk"` sends it to the receiving desk instead.

### Several at once, and CSV

Send a batch as `{ "documents": [ … ] }`, up to 500 a call. Each document is taken in on its own, so one bad document doesn't hold up the rest. The answer lists each one:

```json
{ "taken": 2, "refused": 1, "results": [ { "status": "created", … }, { "status": "refused", "ref": "WEB-2", "error": "Line 1: unknown item NOPE" }, { "status": "duplicate", … } ] }
```

Send CSV as `{ "type": "order", "csv": "…" }` or `{ "type": "asn", "csv": "…" }`:

- **Format:** a header row, comma or semicolon. Rows with the same ref make one document.
- **Order columns:** `ref, customer, client, lane, item (or gtin), units or pallets, minDays`.
- **ASN columns:** `ref, supplier, client, category, expected, sscc, item (or gtin), qty, batch, expiry, serials`.

```
ref,customer,client,item,units
WEB-7,Corner Builders,CL-FIX,F3001,6
WEB-7,Corner Builders,CL-FIX,F3002,24
```

### A client's key

A key with the client role takes in documents for its own client only. A document naming another client is refused.

### The drop folder

For a system that can only write files: put a `.json` or `.csv` file in the server's inbox folder.

- **Where:** `data/inbox` by default. `SORTED_INBOX` sets another folder, and `SORTED_INBOX=0` turns it off.
- **When:** every few seconds, each file that has stopped changing is taken in like `POST /api/inbox`.
- **After:** the file moves to `done/` when every document in it was taken in, or to `failed/` when any was refused. A `.result.json` beside it says what became of each document.
- **JSON files:** one document, a list, or `{ "documents": [ … ] }`.
- **CSV files:** the file name says what it holds: `orders-….csv` or `asn-….csv`.
- **Fixing a failed file:** fix it and drop it again. Documents it already took in answer `duplicate`.

## Pushed out: webhooks and the outbox folder

A system that would rather be told than ask gets the same messages pushed to it.

### Webhooks

An administrator adds a webhook under **Connections**, or with `POST /api/webhooks`:

```json
{ "url": "https://erp.example/sortedwms", "types": ["order.shipped", "delivery.received"], "clientId": "CL-PAINT" }
```

- **What it gets:** leave out `types` for every message, and `clientId` for every client's.
- **From when:** a new webhook starts with the next message. Add `"fromStart": true` to send every message still in the log.
- **How it arrives:** new messages are POSTed in order, a batch at a time:

  ```json
  { "webhook": 3, "messages": [ { "seq": 128, "type": "order.shipped", … }, … ], "gap": false }
  ```

  - **`X-Sorted-Signature`:** `sha256=` and the HMAC-SHA256 of the raw body, keyed with the webhook's secret. The secret is shown once, when the webhook is added.
  - **`X-Sorted-Delivery`:** names the batch (`webhook-first-last`), so a receiver can tell a batch it has already handled.
- **Only a 2xx answer moves it on.** Anything else, or no answer within 10 seconds, is tried again later. The wait grows from 5 seconds to 15 minutes, so nothing is skipped while the other side is down. **Try now** on the Connections screen (`POST /api/webhooks/:id/retry`) skips the wait.
- **After a restart:** where each webhook has got to is kept in the database, so it carries on from there.
- **On screen:** the Connections screen shows each webhook's position, how many messages wait, and its last error.

Checking the signature, in Node:

```js
const { createHmac, timingSafeEqual } = require('crypto');
const expected = 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');
const ok = timingSafeEqual(Buffer.from(expected), Buffer.from(req.headers['x-sorted-signature']));
```

A batch can arrive twice: the receiver answered, but the answer was lost on the way back. Use `seq` to skip messages you have already handled.

Adding and removing webhooks is recorded in the sign-in audit log. A webhook URL is reached from the server, so only an administrator can add one.

### The outbox folder

Set `SORTED_OUTBOX` to a folder, and every message is written there as a file of its own: `000128-order.shipped.json`.

- **Whole files only:** each file is written under a temporary name first, so a reader never sees half of one.
- **After a restart:** the server remembers where it got to and carries on.
- **Housekeeping:** the reading system moves or deletes the files it has handled.
