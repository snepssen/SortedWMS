# Demo: a WMS that flows

What to show: a driver who never stops to type, tap through menus or take gloves off. Scan, the next job appears, scan. Wax on, wax off.

## Set-up

**With a real MC9401 (recommended).** The handheld and the screens must share one warehouse, so run the server on a laptop on the warehouse Wi-Fi:

```
npm run start:demo
```

- MC9401: open `http://<laptop-ip>:8080/handheld` in Chrome, enter a handheld ID (e.g. HH05, category Yoghurt).
- Laptop, one window: `http://localhost:8080/kit`, the **label wall**, with that handheld chosen. Scan straight off the screen.
- Laptop, another window: `http://localhost:8080/admin`, the office, to show the jobs moving.
- Print beforehand, on the day of the demo: the kit's **Print sheet** (six sample pallet labels, dock and lane labels) and the **command card** (`/card`).

**Without hardware.** Open `wms.html` on GitHub Pages: handheld and office side by side, with a button that scans whatever the handheld asks for. The Pages version keeps its data in that one browser, so a real handheld can't join it. Use the laptop server for that.

## The run (about 10 minutes)

1. **Receiving, the good label.** Pallets 1–4 on the sheet carry a full GS1 label (A-ware Kruibeke format). Two scans per pallet, nothing typed: item, count, best-before and batch come from one barcode, the pallet ID from the other. The put-away job exists the moment the pallet is registered.
2. **Receiving, the label that slows everyone down.** Pallets 5–6 are in the A-ware Packaging format: batch and best-before are printed as text only. The driver has to type both. Talking point: ask this supplier for a full GS1 label or a delivery list (ASN), and it's back to one or two scans. The system also reads their quirks: a count in pots (960 = 80 cases) and their own article number.
3. **Auto.** No menus: when a job is done, the next one is already on the screen, by priority (picks first) and nearest first. Put-away: the system picks the slot (right category, the same batch together, next-out low). Two scans: pallet, then location.
4. **Pick, check and label.** Picks follow first-expired-first-out. Checking the pallet at the lane prints its shipping label on the lane's ZT421. Scanning the label confirms it's on.
5. **Real life.** Scan a pallet the handheld didn't ask for:
   - It has a job: *pick it*.
   - It's in the wrong place for its category: *relocate it*.
   - It has nothing to do: the truck stays empty, and the next location scan records where it really stands. No correction form.
6. **Stock check, without switching anything.** In Auto, scan an item number or EAN: every pallet, location and SSCC, next to ship first. Scan a pallet: where it belongs, even while it's on the forks.
7. **Inventory without a stock-take.** Office → Locations → *Stock counts* → **Plan counts** (leave the range empty: the system picks the places that need it). Counts only go to a truck with nothing else to do; to show one now, scan `CMD-COUNT` on the handheld. Two scans per location, blind. Then scan a *different* pallet's label at a count: the system corrects itself and the office shows the difference and the accuracy.
8. **Gloves on.** Everything is on the command card: modes, *pallet missing*, *damaged*, *full pallet*, *delivery done*. Reports are confirmed by scanning the same code twice; there are no pop-ups. On the MC9401's keypad, Esc cancels and F1–F5 switch modes.
9. **The office.** Every scan is in the audit trail with who and when. Batch trace answers "which customers got batch 41/07" in one search.

## What to measure

The simulated shift (the Pages front page) counts **scans per pallet move** (2.0) and **inputs per received pallet**. Count the Enter presses and screens for the same jobs in the current system on the same day: that's the comparison that matters to the floor.
