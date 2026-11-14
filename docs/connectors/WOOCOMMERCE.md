# WooCommerce

Connect one or more WooCommerce shops to a warehouse, for one client or for the whole building. Turn the module on under Modules. Open **WooCommerce**.

The consumer key, consumer secret and webhook secret are saved on this machine, in `woocommerce-secrets.json` next to the database. They are never shown again, never written into the journal, and never included in an export. The shop address must be `https://`.

## What you need in WooCommerce

1. In WooCommerce, open Settings → Advanced → REST API and add a key with Read/Write permission.
2. Copy the consumer key and consumer secret. Paste each once into SortedWMS. A blank field later keeps the saved value.
3. Note the shop address, such as `https://shop.example.com`, with no path after the host.
4. Optional: a webhook for Order created or Order updated, posted to `https://<your-wms>/api/woocommerce/webhook/<shop-id>`. WooCommerce signs the raw body. SortedWMS checks `X-WC-Webhook-Signature` (base64 HMAC-SHA256). A bad signature is refused.
5. Polling still runs, every few minutes, so a missed webhook is picked up. Orders in status **processing** (paid, not yet completed) are imported. The same order sent twice is the same warehouse order. Pending, on-hold, completed and cancelled orders are left alone.

## SKUs

**Read SKUs** loads simple products and variations. A SKU, barcode, GTIN or EAN that already matches an item is filled in. Save the row to keep the link. An order line with no link is not booked; the error stays on the page.

## Stock and tracking

Available stock is on hand minus allocated, held and reserved, then minus the shop's buffer. Several changes close together are sent once, as `stock_quantity` on the product or variation. If WooCommerce answers 429, SortedWMS waits and tries again, waiting longer each time.

When the warehouse ships an order that came from the shop, the order is marked completed and the tracking number and carrier are written as order meta (`_tracking_number`, `_tracking_provider`).

Errors are kept on the WooCommerce page. If the Alerts module is on, the same text is raised there.

Order and catalogue imports follow pagination beyond the first 50 records. Shipment updates are stored in a per-warehouse delivery queue before the read cursor advances. Failed updates retry with increasing delays, including after a server restart. Background work visits every configured warehouse and keeps that warehouse context during network requests.
