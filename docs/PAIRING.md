# Connect a device

SortedWMS can run on a laptop or a desktop. A phone or a tablet on the same network opens the web screens, including the handhelds, without a separate install.

On a signed-in desktop, **Connect a device** shows a QR code, a short link such as `http://192.168.1.20:8080/pair/<token>`, and a six-digit code. The link uses a private address. If the computer has more than one, pick it. The code works once and expires after five minutes.

Scanning it signs the phone in as the person who made the code. An administrator can name another user instead. That person then types their password or PIN on the phone, because the device is shared. The phone stores a long device id in a cookie and in `localStorage`. The session is bound to that id and to the browser's user agent. A copied session cookie from another device is rejected.

A paired device is signed out after 4 hours with no requests. Every request moves that deadline. The hours are `SORTED_DEVICE_IDLE_MS` (default 4 hours). An expired session returns to sign-in. Scans waiting in the handheld's offline queue stay on the device; pairing does not clear them.

Managers and administrators see the paired devices: name, user, last seen, and IP. They can rename one, revoke one, or revoke all. Issuing a code, pairing, revoking, and an idle expiry are written to the audit log, and the warehouse journal notes the issue, the pairing, and the revoke.

This is HTTP on a trusted local network. The claim is refused from a public address. To put the site behind HTTPS, terminate TLS on the laptop or a reverse proxy and keep the phones pointed at that name. Do not publish the port on the open internet.
