# Security notes

Three follow-ups to the security review. This page is the record until [SECURITY-REVIEW.md](SECURITY-REVIEW.md) is on `main`. Fold these three rows into that page (they were the medium findings) and keep the proxy paragraph in [RUNNING.md](RUNNING.md) beside the Caddy and nginx examples.

## Session cookie

`sorted_session` and `sorted_device` gain `Secure` when the connection is HTTPS. `SORTED_TRUST_PROXY` is the list of proxy addresses allowed to say so via `X-Forwarded-Proto`. With the variable unset, that header is ignored, so a client cannot mark the cookie `Secure` by itself and cannot make a plain HTTP browser drop it. Telnet does not use the cookie.

## Unmapped routes

`permissionFor` no longer invents `wms.read` or `wms.write`. A read with no row is 404. A change with no row is 403. Every route the server registers has a row, and `test/security-medium.test.js` fails when a new one does not.

## Webhook replay

Outgoing deliveries sign `timestamp + "." + body` in `X-Sorted-Signature-V2` and still send the body-only `X-Sorted-Signature` until 1 March 2027. `X-Sorted-Delivery` stays. Incoming webhooks that use this program's own signature (the optional Etsy check) refuse a timestamp outside five minutes. Shopify, WooCommerce and Sendcloud stay on the signatures those services define.
