# Text terminal

A scanner terminal, the kind of RF gun that only shows text, talks to SortedWMS over telnet. There are no graphics. The same warehouse commands as the truck handheld and the bin handheld do the work.

The module is **off** until you turn on Text terminal in Modules. The telnet port opens a few seconds later, with no restart, and closes when you turn it off. **Users → Text terminal** shows the address to point the gun at, whether it is listening, and where to give each person a terminal PIN or a badge. Telnet sends everything in the clear, including the PIN. Use it only on the site network. The listener refuses an address that is not loopback or a private range (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, link-local), unless `TERMINAL_ALLOW` names something else. Put a TLS wrapper in front of it if the path is not a trusted LAN. Do not publish port 2323 on the internet.

## Connect

```
telnet <host> 2323
```

The port, idle minutes and session cap come from the module's settings (2323, 15 minutes, 8). `TERMINAL_PORT`, `TERMINAL_IDLE_MS` and `TERMINAL_MAX` override them; `TERMINAL_HOST` defaults to every interface. Each connection gets the lowest free id, RF1, RF2 and so on, so two guns never share one.

On connect the server offers echo, suppress-go-ahead, and window size (NAWS). A terminal that answers with its size skips the size list. Otherwise pick a profile:

1. 20×16
2. 40×8
3. 16×20
4. 80×24

Then the user id and the terminal PIN, or a badge scan. The server echoes what you type and shows the PIN as stars. The PIN is not the web password. An administrator sets it under Users. Five wrong PINs lock the terminal sign-in for 15 minutes. The web password is separate.

Every screen is the same shape: the title and who is signed in on the top line, the body, the keys on the line above the bottom, and the prompt on the last line, where the cursor waits. An error starts with `!` and beeps. On a wide, short screen (40×8) the menu is in two columns. Menu numbers never move: an option you cannot use is left out, not renumbered.

Menus are numbers. `0` or `F1` goes back. `?` or `F2` is help. `c` or `F3` cancels to the menu. A scan is typed text and Enter, which is what a keyboard wedge sends. Every field takes a scan or typed text.

What you see depends on the role and on which modules are on. Receiving, put-away, moves, replenishment (including a split-return task when that module created one), picking, ST/INB/OUT plates, consolidation is the plate flow the office already has, blind cycle counts, stock enquiry, and kitting scans. Each one calls the same command the handheld uses, and the journal records the user and the terminal id.

## A typical RF gun

1. Install a telnet client that speaks VT100, or plain ASCII lines if it has no cursor control.
2. Host: the warehouse PC. Port: 2323. Local echo off if the server is echoing. Turn on "send Enter after a scan" on the wedge.
3. Screen: 20×16 is the usual small gun. 40×8 and 16×20 are the other short panels. 80×24 is a desk terminal.
4. If the client can send NAWS, the server picks the nearest profile.
5. Function keys: F1 back, F2 help, F3 cancel. VT100, VT220 and VT52 key codes all work, and arrow keys are ignored, so a stray key never lands in a field. If the gun cannot send F-keys, use `0`, `?` and `c`.
6. No colour is required. The screen is ASCII, including Dutch with the accents removed when the language catalogs are in use.
