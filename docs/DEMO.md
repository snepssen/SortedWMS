# SortedWMS: presenter guide

An interactive workflow demonstration for a chilled warehouse handling cheese and yoghurt, with protein drinks as a future-product example. It is not a proposal to replace the current WMS. The question is which ideas could make daily work and handovers smoother.

## Send or open first

Share the [guided shift](../walkthrough.html), with this guide as context and the [demo SOP](SOP.md) as a reference. It runs in a browser with made-up stock; no installation, account or warehouse connection is needed.

Suggested introduction:

> I've taken the warehouse demo further. It shows how receiving, put-away, picking and processing could connect, with clearer instructions for operators and better visibility for the office. This is an interactive prototype, not a proposed replacement for our WMS. I'd like your view on which ideas would help our day-to-day work.

## Browser presentation: about 10 minutes

1. **Receiving to shipping.** Start the [main guided scenario](../walkthrough.html?scenario=shipping). Advance with the action button at each step. Admin partitions storage for protein drinks; the office announces a delivery; the scanner receives and puts away stock. An order uses FEFO, damage triggers replacement stock, the station changes the pallet, and check & label leads to shipment and trace. This scenario uses office shipment confirmation; use the separate loading scenario to show pallet-to-trailer checks.
2. **Auto-Shift & partitioning.** Select [Auto-Shift & partitioning](../walkthrough.html?scenario=shift). Show next-out stock brought down and a pallet relocated after the partition changes. Talking point: the rules create the moves instead of requiring a list for each driver.
3. **Manual work & corrections.** Select [Manual work & corrections](../walkthrough.html?scenario=manual). Show a chosen order, manual put-away and a misplaced pallet corrected with two scans. Talking point: Auto should help, without taking away the ability to work a specific order or report reality.
4. **Close on the office.** Show the stock state and audit. Ask where handovers, labels or exception handling cause the most friction today, and which demonstrated changes would be worth exploring.

Each guided scenario starts from isolated stock. Switching scenarios or **Restart guided shift** starts that scenario from the beginning, without changing free-play stock. The role tabs inspect the same state, not separate user accounts. Measurements, timings and customer requirements are examples.

## Optional topics

| Topic | Scenario | What to look for |
| --- | --- | --- |
| Inventory | [Stock counts & accuracy](../walkthrough.html?scenario=counts) | Three locations, six scans; differences corrected and visible to the office. The percentage describes these counts, not the whole warehouse. |
| Cold-chain exceptions | [Temperature & quality holds](../walkthrough.html?scenario=quality) | A recorded reading places a hold; a passing follow-up does not release it automatically. |
| Traceability | [Batch recall & traceability](../walkthrough.html?scenario=recall) | Earlier recipients, late receipts and independent holds remain visible. |
| Segregation | [Physical quarantine & release](../walkthrough.html?scenario=quarantine) | Separate quality and return decisions, with scanned physical moves. |
| Outbound verification | [Trailer loading & dispatch](../walkthrough.html?scenario=loading) | Pallet plus trailer scans, wrong-destination rejection, unloading and a seal. |
| Trailer condition | [Trailer readiness & refrigeration](../walkthrough.html?scenario=readiness) | Missing, failed and expired checks stop loading or departure; unloading still works. |

These are examples of workflow logic, not validated food-safety procedures. No physical refrigeration, dock door or vehicle is controlled. Browser labels simulate printing; a real printer needs the local server and hardware configuration.

## Hardware set-up: optional

**With a real MC9401.** Use only an authorised demonstration network and made-up stock, not an operational WMS connection. The handheld and screens need the same prototype server, so run it on a laptop:

```
npm run start:demo
```

- MC9401: open `http://<laptop-ip>:8080/handheld` in Chrome, enter a handheld ID (e.g. HH05, category Yoghurt).
- Laptop, one window: `http://localhost:8080/kit`, the **label wall**, with that handheld chosen. Scan straight off the screen.
- Laptop, another window: `http://localhost:8080/admin`, the office, to show the jobs moving.
- Print beforehand, on the day of the demo: the kit's **Print sheet** (six sample pallet labels, dock and lane labels) and the **command card** (`/card`).
- Focus the capture field in `/keys` and verify actual scanner/key delivery before presenting. F1-F5 and Enter depend on the keypad and DataWedge configuration; browser tests do not prove physical behavior.

**Without hardware.** Open the GitHub Pages front page. It runs a simulated shift and links the three things to show: the **guided shift** (scenarios step by step), **handheld + office** (the real screens side by side, with a button that scans whatever the handheld asks for) and the **SOP**. The Pages version keeps its data in that one browser, so a real handheld can't join it. Use the laptop server for that.

## Label and handheld demonstration

1. **Receiving, the good label.** Pallets 1–4 on the sheet carry a full GS1 label (A-ware Kruibeke format). Two scans per pallet, nothing typed: item, count, best-before and batch come from one barcode, the pallet ID from the other. The put-away job exists the moment the pallet is registered.
2. **Receiving, the label that slows everyone down.** Pallets 5–6 are in the A-ware Packaging format: batch and best-before are printed as text only. The driver has to type both. Talking point: ask this supplier for a full GS1 label or a delivery list (ASN), and it's back to one or two scans. The system also reads their quirks: a count in pots (960 = 80 cases) and their own article number.
3. **Auto.** No menus: when a job is done, the next one is already on the screen, by priority (check & label first, so orders finish as they go, then picks) and nearest first. Put-away: the system picks the slot (right category, the same batch together, next-out low). Two scans: pallet, then location.
4. **Pick, check and label.** Picks follow earliest eligible expiry (FEFO). Checking the pallet at the lane queues its shipping label for the lane's configured printer. Scanning the label confirms it's on. Pages simulates the print; a physical ZT421 requires server configuration and a hardware check.
5. **Real life.** Scan a pallet the handheld didn't ask for:
   - It has a job: *pick it*.
   - It's in the wrong place for its category: *relocate it*.
   - It has nothing to do: the truck stays empty, and the next location scan records where it really stands. No correction form.
6. **Stock check, without switching anything.** In Auto, scan an item number or EAN: every pallet, location and SSCC, next to ship first. Scan a pallet: where it belongs, even while it's on the forks.
7. **Inventory between other jobs.** Office → Locations → *Stock counts* → **Plan counts** (leave the range empty: the system picks the places that need it). New counts only go to a truck with nothing else to do; to show one now, scan `CMD-COUNT` on the handheld. Without hardware, the guided shift's *Stock counts & accuracy* scenario shows a swap being found and corrected in six scans. Two scans per location, blind. Then scan a *different* pallet's label at a count: the system corrects itself and the office shows the difference and the match rate of these counts.
8. **Gloves on.** Routine work commands are on the card: modes, *pallet missing*, *damaged*, *full pallet*, *delivery done*. Reports are confirmed by scanning the same code twice; there are no report pop-ups. Setup and labels missing batch/date barcodes still need screen or keypad input. The demo implements Esc and F1-F5 browser mappings; use the card unless those keys have been checked on the actual MC9401.
9. **The office.** Every scan is in the audit trail with who and when. Batch trace answers "which customers got batch 41/07" in one search.

## A rush: hundreds of jobs at once

Open *Handheld + office* on Pages and switch to **Whole floor**.
1. **Drop in** 200 pallets to pick and 200 to receive. The board shows what the system made of it: picks, receiving, put-aways, Auto-Shift, each in the coordinator's order.
2. **Add trucks** (two or three) and **Start driving** at 1×. Every scanner screen shows its job and a countdown to its next scan, as it would on the floor.
3. Speed up to 10× or 30× to watch the queue drain: receiving fills the dock, put-aways follow, picks go out and orders turn ready.
4. **Talking point:** nobody hands out work. Change the job order in the office (Settings → Dispatch, for example *Receiving* first while the morning trucks are at the doors) and watch the queue reshuffle on every screen.

## What the demo does and does not prove

The simulated shift counts **scans per pallet move** and **inputs per received pallet**. A routine pickup/drop pair is two scans, not a claim that the entire shipment takes two inputs. Supplier labels, corrections, checking and loading can add steps.

The driver clock is a model, not a site throughput measurement. A lower demo input count does not establish a time saving. Compare the same task, label and exception in the current workflow before drawing conclusions. Keep operator observations separate from performance scoring.

Network retries remember recent request IDs only while the server is running. A final unanswered scan has an uncertain outcome: check the current job and audit before repeating it. This demo is not an offline system, a production rollout, an access-control demonstration or a certified recall/temperature system.

## Before sending

1. Open the link in a fresh browser tab and check the first guided action is available.
2. Check the main guided scenario finishes with a shipment and batch trace.
3. Keep the guide and SOP links with the demo so the scope and procedures are clear.
4. Do not put real stock, customer records or credentials into the public browser demonstration.
