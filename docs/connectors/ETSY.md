# Etsy

Connect one or more Etsy shops to a warehouse, for one client or for the whole building. Turn the module on under Modules. Open **Etsy**.

The keystring, shared secret, access token and refresh token are saved on this machine, in `etsy-secrets.json` next to the database. They are never shown again, never written into the journal, and never included in an export. The PKCE verifier lives in that same file until the browser comes back, then it is removed.

## What you need on Etsy

1. Create an app at [Etsy developers](https://www.etsy.com/developers/your-apps). Copy the keystring and the shared secret. Paste each once into SortedWMS.
2. Set the app's redirect URI to `https://<your-wms>/api/etsy/callback`. Put that same address in the shop form. `http://127.0.0.1` is accepted only on this machine.
3. The app needs the scopes `transactions_r`, `transactions_w`, `listings_r` and `listings_w`.
4. Note the numeric shop id (the number in the shop manager URL, or from `getMe`).
5. Save the shop, then press **Connect**. The browser goes to Etsy and comes back here. That is OAuth 2 with PKCE (S256). The shared secret never goes to the browser.

## Orders

Polling, every few minutes, reads paid receipts that have not shipped (`was_paid` and not `was_shipped`). The same receipt sent twice is the same warehouse order.

Etsy does not publish a signature for order webhooks. Polling is the import. If you set a webhook secret, SortedWMS will also accept a POST to `https://<your-wms>/api/etsy/webhook/<shop-id>` whose `X-Etsy-Signature` header is the hex HMAC-SHA256 of the raw body. That header is not an official Etsy header. A body that does not match is refused. With no secret saved, every webhook is refused.

## SKUs

**Read SKUs** loads active listings and their inventory. A SKU that already matches an item number or a barcode is filled in. Save the row to keep the link. An order line with no link is not booked; the error stays on the page.

## Stock and tracking

Available stock is on hand minus allocated, held and reserved, then minus the shop's buffer. Several changes close together are sent once, as the listing inventory quantity. If Etsy answers 429, SortedWMS waits and tries again, waiting longer each time.

When the warehouse ships an order that came from the shop, the tracking number and carrier are posted to the receipt.

Errors are kept on the Etsy page. If the Alerts module is on, the same text is raised there.
