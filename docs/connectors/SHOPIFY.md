# Shopify

Connect one or more Shopify shops to a warehouse, for one client or for the whole building. Turn the module on under Modules. Open **Shopify**.

The access token and the webhook secret are saved on this machine, in `shopify-secrets.json` next to the database. They are never shown again, never written into the journal, and never included in an export.

## What you need in Shopify

1. In the Shopify admin, create a custom app for this warehouse.
2. Give it read access to orders and products, and write access to fulfilment and inventory.
3. Install the app and copy the Admin API access token. Paste it once into SortedWMS.
4. Note the shop address, such as `example.myshopify.com`.
5. For stock, copy the location id (Settings → Locations, the number in the URL, or the locations API).
6. Optional: a webhook for `orders/create` or `orders/paid`, posted to `https://<your-wms>/api/shopify/webhook/<shop-id>`, signed with the app's webhook secret. SortedWMS checks `X-Shopify-Hmac-Sha256` (base64 HMAC-SHA256 of the raw body). A bad signature is refused.
7. Polling still runs, every few minutes, so a missed webhook is picked up. Paid orders that are not yet fulfilled are imported. The same order sent twice is the same warehouse order.

## SKUs

**Read SKUs** loads the shop's variants. A SKU or barcode that already matches an item is filled in. Save the row to keep the link. An order line with no link is not booked; the error stays on the page.

## Stock and tracking

Available stock is on hand minus allocated, held and reserved, then minus the shop's buffer. Several changes close together are sent once. If Shopify answers 429, SortedWMS waits and tries again, waiting longer each time.

When the warehouse ships an order that came from the shop, the tracking number and carrier (if the order has them) are sent back as a fulfilment.

Errors are kept on the Shopify page. If the Alerts module is on, the same text is raised there.

Order and catalogue imports follow pagination beyond the first 50 records. Shipment updates are stored in a per-warehouse delivery queue before the read cursor advances. Failed updates retry with increasing delays, including after a server restart. Background work visits every configured warehouse and keeps that warehouse context during network requests.
