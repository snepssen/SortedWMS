# Running it safely

How to put SortedWMS on a machine that other people use. Node.js 22.13 or newer is the only install. There is no package to download and no Docker image. The program listens on port 8080 unless `PORT` says otherwise. The database is `data/sorted.db` unless `SORTED_DB` names another file.

Do this on a machine you control. The pages below assume the warehouse PC is the only thing that should see the program, and that a reverse proxy is what the office browser talks to.

## What to open, and what to keep shut

| Port | What | Who may reach it |
| --- | --- | --- |
| 443 | HTTPS on the reverse proxy | The office, on the site network or over a VPN |
| 80 | HTTP, only so the proxy can redirect to HTTPS | Same as 443, and only the redirect |
| 8080 | SortedWMS itself | The proxy on the same machine. Not the internet, and not the rest of the site if the proxy is local |
| 2323 | Telnet for scanner guns ([TERMINAL.md](TERMINAL.md)) | The warehouse LAN only. The program already refuses a public address. Do not forward this port |

The telnet port is plain text, including the PIN. Leave Text terminal off until a gun needs it. The default allow list is loopback and the private ranges (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, and link-local). `TERMINAL_ALLOW` can name extra addresses. Do not set it to the open internet.

On the warehouse PC, a firewall that allows 443 (and 80 for the redirect) from the site LAN, and drops everything else inbound, is enough. 8080 and 2323 stay on the machine. If the guns are on a different host from the proxy, allow 2323 only from the gun VLAN, not from the guest Wi-Fi and not from the internet.

Label printers on TCP 9100 are outbound from this PC, or inbound only from the PC to the printer. Do not publish 9100.

## HTTPS

SortedWMS speaks HTTP. Put Caddy or nginx in front of it and let that process hold the certificate. Point the office at `https://wms.example`. Leave `PORT=8080` bound to localhost so the only way in is the proxy.

The proxy must forward the original address so the logs and the pairing QR use the name people type. SortedWMS does not require a special header to work. Send `X-Forwarded-Proto: https` and `X-Forwarded-For` anyway, so anything that records the client sees the office machine rather than the proxy.

### Caddy

`/etc/caddy/Caddyfile`:

```
wms.example {
	reverse_proxy 127.0.0.1:8080
}
```

Caddy fetches a certificate when the name resolves to this machine and port 80 and 443 are reachable from the internet. On a site that is not on the internet, use a certificate you already have:

```
wms.example {
	tls /etc/caddy/wms.crt /etc/caddy/wms.key
	reverse_proxy 127.0.0.1:8080
}
```

### nginx

`/etc/nginx/sites-available/sortedwms`:

```
server {
	listen 80;
	server_name wms.example;
	return 301 https://$host$request_uri;
}

server {
	listen 443 ssl;
	server_name wms.example;
	ssl_certificate     /etc/nginx/wms.crt;
	ssl_certificate_key /etc/nginx/wms.key;

	client_max_body_size 8m;

	location / {
		proxy_pass http://127.0.0.1:8080;
		proxy_set_header Host $host;
		proxy_set_header X-Forwarded-Proto https;
		proxy_set_header X-Forwarded-For $remote_addr;
	}
}
```

`client_max_body_size` has to fit an item photo. The program itself stops a body at 5 MB.

Telnet does not go through this proxy. Guns connect to port 2323 on the LAN, as [TERMINAL.md](TERMINAL.md) says.

## systemd

`/etc/systemd/system/sortedwms.service`:

```
[Unit]
Description=SortedWMS
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=sorted
Group=sorted
WorkingDirectory=/opt/sortedwms
Environment=PORT=8080
Environment=SORTED_DB=/var/lib/sortedwms/sorted.db
Environment=SORTED_BACKUP_DIR=/var/lib/sortedwms/backups
EnvironmentFile=-/etc/sortedwms/env
ExecStart=/usr/bin/node --no-warnings server/index.js
Restart=on-failure
RestartSec=3
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

`/etc/sortedwms/env` is optional (the leading `-`). Put `SORTED_BACKUP_PASSPHRASE=…` there when the off-site copy is encrypted, own the file as root, and set mode `0600`. systemd refuses a world-readable `EnvironmentFile` for some setups; keep it unreadable by other users either way. Do not put the passphrase in the unit file if that file is world-readable.

```
sudo systemctl enable --now sortedwms
sudo systemctl status sortedwms
```

`User=sorted` must own the database directory. Create it before the first start. The daily copy lands in `SORTED_BACKUP_DIR` ([BACKUPS.md](BACKUPS.md)).

## macOS launchd

`/Library/LaunchDaemons/com.sortedwms.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>com.sortedwms</string>
	<key>WorkingDirectory</key>
	<string>/opt/sortedwms</string>
	<key>ProgramArguments</key>
	<array>
		<string>/usr/local/bin/node</string>
		<string>--no-warnings</string>
		<string>server/index.js</string>
	</array>
	<key>EnvironmentVariables</key>
	<dict>
		<key>PORT</key>
		<string>8080</string>
		<key>SORTED_DB</key>
		<string>/Library/Application Support/SortedWMS/sorted.db</string>
		<key>SORTED_BACKUP_DIR</key>
		<string>/Library/Application Support/SortedWMS/backups</string>
	</dict>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>StandardOutPath</key>
	<string>/var/log/sortedwms.log</string>
	<key>StandardErrorPath</key>
	<string>/var/log/sortedwms.log</string>
</dict>
</plist>
```

```
sudo launchctl bootstrap system /Library/LaunchDaemons/com.sortedwms.plist
sudo launchctl enable system/com.sortedwms
```

Node's path is whatever `which node` prints on that Mac. Put `SORTED_BACKUP_PASSPHRASE` in the same dictionary when the off-site copy is encrypted. Restrict the plist if it contains that value.

## Backups before you need them

The local daily copy is on by default: `./start.sh backup` writes one now, `./start.sh backups` lists them. See [BACKUPS.md](BACKUPS.md) for the encrypted off-site copy (folder, S3 or WebDAV), the passphrase, and retention.

Take one encrypted copy off the machine. A disk in the same PC is not a second site.

## Restore onto a new machine

1. Install Node 22.13 or newer. Copy the SortedWMS directory (`git clone` the same version you were running, or copy the folder). Do not copy `node_modules`; there is nothing to install.
2. Stop SortedWMS on the old machine if it is still up, so the backup is not mid-write. `./start.sh backup` on the old machine, or use the latest off-site file.
3. On the new machine create the database directory and put nothing else in it yet.
4. Restore, with the server stopped:
   - Local plain file: `./start.sh restore /path/to/sorted-2026-11-14-023000.db`
   - Encrypted file: `SORTED_BACKUP_PASSPHRASE='…' ./start.sh restore /path/to/sorted-2026-11-14-023000.db.enc`
   - The same encrypted file downloaded from S3, WebDAV or the folder target. The passphrase is the one from the old machine. A new machine does not have `offsite-secrets.json` until you save the passphrase again under Backups.
5. The command runs the data upgrades before it returns. Then start the service.
6. Everyone signs in again. Sessions, pairing codes and MFA challenges in the backup are thrown out. Users and API keys come back. Item photos are inside a `.db` or `.db.enc` backup; you do not copy the photo directory. A JSON export from Settings does not contain the image bytes. Use a database backup for a new machine.
7. Open Modules and Backups and confirm the off-site target. Save the passphrase on the new machine or keep it in the environment. Send a test backup and check that it arrives.
8. Point the proxy at this machine, and point the scanner guns at the new LAN address for port 2323 if the terminal is on.

A restore refuses to run while something is still listening on `PORT`. Stop the service first.

## After it is up

- `GET /api/health` needs no sign-in and only says whether the process answers.
- `GET /api/health/figures` and `GET /api/metrics` need `settings.read`. Watch for a missing backup, a snapshot far behind the journal, and a webhook that keeps failing. See [HEALTH.md](HEALTH.md).
- Change the starting admin password at the first sign-in. It is printed on the sign-in page until you do.
