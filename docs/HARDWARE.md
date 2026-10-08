# Hardware at the site

What SortedWMS expects from the equipment on the floor, and how to set it up. Based on photos of the site's own equipment and pallets (October 2026).

## Handheld: Zebra MC9401

A rugged Android gun-grip terminal with a 4.3" touch screen and a full keypad (Esc, letters, digits, F-keys under the blue key, P1/P2, arrows, ENT).

**Running SortedWMS on it.** Open the server's `/handheld` page in Chrome (on GitHub Pages: `handheld.html`) and add it to the home screen. For a locked-down device, pin the screen (Android screen pinning) or run it in Zebra's Enterprise Browser. Enter the handheld ID once; it's remembered.

**Starting up and slow spots.** The device's auto-start script opens the `/handheld` page from the intranet server. If the server doesn't answer, the script waits and tries again; that part is the device's. Once the page is open:
- **Startup:** while the server doesn't answer, it shows *Connecting to SortedWMS…* and keeps trying every 2 seconds. It never sits on a blank screen.
- **Lag near the docks:** a scan that gets no answer within 6 seconds is sent again with the same request ID, up to five times over about half a minute. The server answers a repeated request ID with the first answer, so a scan is never done twice; this matters because a pallet scanned twice in Auto means *move it*.
- **Scans during lag:** the same code scanned again while it's on its way is ignored. Anything else waits its turn and is never dropped.

**Screen.** In the browser the screen is about 320×480. The handheld page has a compact layout for this size: the answer to the last scan and the scan field sit above the job, so "wrong pallet" is never below the fold, and the whole job fits without scrolling.

**Scanner (DataWedge).** The scanner types into the page like a keyboard. In DataWedge, the profile for Chrome (or Enterprise Browser) needs:
- Barcode input on, with Code 128 and GS1-128 enabled (supplier labels, our labels, location labels and the command card are all Code 128).
- Keystroke output on, with **Send ENTER key** after the data.
- Optional: the AIM code identifier (symbology prefix, `]C1` for GS1-128). With it, the system knows for certain that a scan is a GS1 barcode; without it, it works it out from the content.
- The FNC1 separator: welcome but not required. If the scanner doesn't pass it on, the system still splits a label like `(37)96(15)261110(10)41/06` correctly.

Open **`/keys`** (`keys.html` on Pages) on the device once: it shows exactly what each key and each scan sends, including whether the separator and prefix arrive. Copy its summary and send it to whoever maintains the system.

**Keys.**

| Key | Does |
| --- | --- |
| ENT | Sends what's typed in the scan field (the scanner sends it after every scan) |
| Digits / letters | Type into the scan field: a quantity, a batch number, a date, a location like A3C2 |
| Esc | Clears a half-typed entry; with nothing typed, cancels (like `CMD-CANCEL`) |
| F1 … F5 (blue key + digit) | Auto, Pick, Put-away, Transfer, Stock check |

**Gloves.** Everything on the touch screen also has a barcode on the command card (office → Settings → Command card).

**Dates on the keypad.** Type them as day-month-year: `09112026`, `091126` or `9-11-26`. The system reads the date back on the screen ("expiry date 09-11-2026") so a slip is seen straight away. A six-digit entry can also be a date-only barcode in GS1 order (year-month-day): the reading that makes sense for a best-before date wins.

## Label printer: Zebra ZT421

An industrial label printer that takes ZPL over the network on port 9100, which is what SortedWMS sends.

**Set up.**
1. Give it a fixed IP address (or a DHCP reservation), and make sure the server can reach port 9100.
2. Print a configuration label from the printer's menu: it shows the IP address and the **print resolution, 203 or 300 dpi** (the ZT421 is made in both).
3. In the site file, map the printer name to its address and resolution:
   ```json
   "printers": {
     "LP-OUT-01": { "address": "10.0.4.51:9100", "dpi": 300 },
     "LP-ST-PRESS": "10.0.4.52:9100"
   }
   ```
   A plain address means 203 dpi. Labels are laid out for 203 dpi and scaled to the printer, so they come out the same size on either model.

**Status.** Office → Settings → Label printers → **Check** asks the printer how it is (Zebra's `~HS` host status) and shows paper out, ribbon out, head open or paused. Each printed job shows whether it was sent.

**Labels.** Shipping and pallet labels are 4×6 inch. If the printers are loaded with another size, or run direct thermal (no ribbon) or thermal transfer, tell whoever maintains the system: the layout and the "ribbon out" check depend on it.

## Supplier pallet labels

Two A-ware labels were photographed on skyr pallets. They show why receiving must handle both full GS1 labels and labels where half the information is only printed as text.

### A-ware Packaging (Netto Gutes Land Skyr 12×500 g)

| Barcode | Contains | Notes |
| --- | --- | --- |
| Top | `(02)4316268741606(37)0960` | The **pot's** EAN and the count **in pots**: 960 pots = 80 cases of 12. The EAN is printed with 13 digits where GS1 wants 14; it is read as `04316268741606`. |
| Middle | `(91)40012009` | A-ware's own article number ("INTERNAL") |
| Bottom | `(00)354111938100402747` | The SSCC: the pallet's identity |

**Batch (810040274) and best-before (09/11/2026) are printed as text only, not in any barcode.** That's why "we only use the bottom one". Receiving one of these pallets:
1. Scan the bottom barcode (SSCC).
2. Type the batch, ENT.
3. Type the best-before date, e.g. `09112026`, ENT.
4. Scan the top barcode: item and count (960 pots → 80 cases). Or scan the middle one (the item), then confirm the full pallet.

So 2 scans and 2 typed entries. If A-ware sends a delivery list (ASN) with batch and date per SSCC, it's **1 scan**.

### A-ware Kruibeke (JA! skyr natuur 12×500 g)

| Barcode | Contains |
| --- | --- |
| Top | `(02)04388860261127(37)96(15)261110(10)41/06`: case GTIN, 96 cases, best-before 10-11-2026, batch 41/06 |
| Bottom | `(00)054133890000100974`: SSCC |

**2 scans, nothing typed.** The small label beside it (E0960, barcode 2026410074) isn't needed.

### What the item master needs for this

Per item:
- **gtin**: the case GTIN, as on full GS1 labels.
- **unitGtin** + **unitsPerCase**: the consumer unit's EAN, for labels that count units (A-ware Packaging: `4316268741606`, 12 per case).
- **codes**: supplier article numbers, such as `40012009`, for the `(91)` barcode. A stock check also finds the item by any of these.

The example site (`server/site.example.json`) has both skyr items set up like this. On the Pages demo, delivery D-2042 takes these real labels.
