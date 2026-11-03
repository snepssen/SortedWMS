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

## Into the warehouse

Today orders and deliveries come in through the API, with the same key:

- `POST /api/orders`
- `POST /api/deliveries`, carrying the supplier's pallet list
- the CSV imports: `POST /api/import/orders`, `/api/import/items`, `/api/import/stock`

These are next:

- **One intake for orders and ASNs:** JSON or CSV, safe to send twice, with the other system's own reference carried through to the messages.
- **A drop folder on the server** that feeds the same intake.
- **Webhooks and an outbox folder:** messages pushed out, not only read.
