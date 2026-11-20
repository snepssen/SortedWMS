# Security review

Reviewed for roadmap 1.5: sessions and device pairing, per-route permissions, client isolation, photo uploads, CSV exports, webhook signatures, and the telnet terminal. What was small is fixed in this change. The rest is listed here with a severity. Severity is how much it matters on a warehouse PC that follows [RUNNING.md](RUNNING.md): the program is on localhost, HTTPS is the proxy, and telnet stays on the LAN.

## Fixed here

**CSV formula injection, every export.** A cell whose text starts with `=`, `+`, `-`, `@`, a tab or a return is led with a quote, unless it is a plain number such as `-64` or `+5`. The writers are the stock, billing, availability and low-stock exports, the report area, invoices, ABC counts, stock changes, and the user audit. A name `=cmd|calc` is stored as `'=cmd|calc` in the file.

**Client reports and one order read.** A client login could read warehouse-wide reports (stock, orders, availability, expiry, billing, invoices, stock changes, low stock) and another client's shipment, because those routes checked `reports.read` or `orders.read` and not the client id. A client now sees only its own items, orders and billing. Asking for another client's id returns that client's own rows, or 404 for the shipment. Items, stock and the order list already worked this way.

**Secure cookies, listed routes, and webhook time.** The session and device cookies are `Secure` on HTTPS, including behind a proxy listed in `SORTED_TRUST_PROXY`. A route with no permission row is refused. Outgoing webhooks sign `timestamp + "." + body` as well as the older body-only header, which stays until 1 March 2027. See [RUNNING.md](RUNNING.md) and [SECURITY-NOTES.md](SECURITY-NOTES.md).

## What is in good shape

- **Browser sessions** idle out after 30 minutes (`SORTED_IDLE_MS`). The cookie is `HttpOnly` and `SameSite=Lax`, and `Secure` on HTTPS or from a trusted proxy. The token is stored as a hash.
- **Device pairing** keeps a session for 90 days, but a paired device that is quiet for 4 hours is signed out (`SORTED_DEVICE_IDLE_MS`, default 4 hours). The device cookie follows the same `Secure` rule. The browser must present the same device id or the session is deleted. Pairing is refused from a public address unless `SORTED_PAIR_PUBLIC=1`.
- **Permissions** name a permission for every route the server lists. A missing row is 404 on a read and 403 on a change. An administrator has every named permission and still cannot call a route that is not listed. A module that is off answers 404 on a read and 403 on a change.
- **Photos** are accepted only as JPEG, PNG, GIF or WebP by their first bytes, at most 512 KB. The file name is the item number, and that number may only contain letters, digits, `.`, `_` and `-`.
- **Webhooks** send `x-sorted-timestamp` and `x-sorted-signature-v2` (HMAC-SHA256 of `timestamp + "." + body`). Allow five minutes of clock skew. `x-sorted-signature` remains the body-only HMAC until 1 March 2027. The secret is shown once when the webhook is created.
- **Telnet** refuses an address that is not loopback or a private range, unless `TERMINAL_ALLOW` names something else. The port defaults to 2323. The PIN travels in the clear.

## Still open

| Severity | Topic | What is left |
| --- | --- | --- |
| Low | Telnet | The PIN is plaintext and the session is a TCP socket. The allow list and the firewall are the control. Do not set `TERMINAL_ALLOW` to a public address. |
| Low | Pairing switch | `SORTED_PAIR_PUBLIC=1` accepts pairing codes from the internet. Leave it unset. |
| Low | Device idle is configurable | `SORTED_DEVICE_IDLE_MS` can make the 4-hour idle longer or shorter. The default is 4 hours, and the session still ends after 90 days. |
| Low | GIF photos | A GIF is a real image by its header and is served as `image/gif`. It is not executed. It is not a substitute for scanning files with an antivirus. |
| Note | Client item list | The client item list is on. A client cannot read another's item or removal request. Reports follow the same rule. |

Nothing else in this pass needed a code change. Customer contact, physical access to the PC, and a stolen database file are out of scope: a backup is the database, hashes and all, as [BACKUPS.md](BACKUPS.md) says.
