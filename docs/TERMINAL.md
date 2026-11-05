# Text terminal

A scanner terminal, the kind of RF gun that only shows text, talks to SortedWMS over telnet. There are no graphics. The same warehouse commands as the truck handheld and the bin handheld do the work.

The module is **off** until you turn on Text terminal. Telnet sends everything in the clear, including the PIN. Use it only on the site network. The listener refuses an address that is not loopback or a private range (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, link-local), unless `TERMINAL_ALLOW` names something else. Put a TLS wrapper in front of it if the path is not a trusted LAN. Do not publish port 2323 on the internet.

## Connect

```
telnet <host> 2323
```

The port is `TERMINAL_PORT` (2323). `TERMINAL_HOST` defaults to every interface. `TERMINAL_IDLE_MS` is 15 minutes. `TERMINAL_MAX` is 8 sessions.

On connect the server offers echo, suppress-go-ahead, and window size (NAWS). A terminal that answers with its size skips the size list. Otherwise pick a profile:

1. 20×16
2. 40×8
3. 16×20
4. 80×24

Then the user id and the terminal PIN, or a badge scan. The PIN is not the web password. An administrator sets it. Five wrong PINs lock the terminal sign-in for 15 minutes. The web password is separate.

Menus are numbers. `0` or `F1` goes back. `?` or `F2` is help. `c` or `F3` cancels to the menu. A scan is typed text and Enter, which is what a keyboard wedge sends. Every field takes a scan or typed text.

What you see depends on the role and on which modules are on. Receiving, put-away, moves, replenishment (including a split-return task when that module created one), picking, ST/INB/OUT plates, consolidation is the plate flow the office already has, blind cycle counts, stock enquiry, and kitting scans. Each one calls the same command the handheld uses, and the journal records the user and the terminal id.

## A typical RF gun

1. Install a telnet client that speaks VT100, or plain ASCII lines if it has no cursor control.
2. Host: the warehouse PC. Port: 2323. Local echo off if the server is echoing. Turn on "send Enter after a scan" on the wedge.
3. Screen: 20×16 is the usual small gun. 40×8 and 16×20 are the other short panels. 80×24 is a desk terminal.
4. If the client can send NAWS, the server picks the nearest profile.
5. Function keys: F1 back, F2 help, F3 cancel. If the gun cannot send F-keys, use `0`, `?` and `c`.
6. No colour is required. The screen is ASCII, including Dutch with the accents removed when the language catalogs are in use.
