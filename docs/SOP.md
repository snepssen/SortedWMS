# SortedWMS: standard operating procedures

How the prototype connects warehouse work, task by task: who does what, on which screen, and what the system does in return.

**Demo procedures, not an approved site SOP.** This manual describes the demonstration, not a replacement for the current WMS or the warehouse's working instructions. Stock, customers, measurements and timing are examples. Site safety, hygiene, temperature limits and quality decisions remain governed by the warehouse's approved procedures. Admin, Office, Scanner and Station in the guided shift are views of the same demonstration, not access-controlled permissions.

For a coordinator presentation, start with the [presenter guide](DEMO.md) and [guided shift](../walkthrough.html). The procedures below are the reference for exploring individual tasks.

**Who this is for**
- **New to SortedWMS but not to warehouse systems?** Read section 0 once, then follow the procedures; each one stands on its own.
- **A veteran?** The steps will look familiar. Routine pallet moves use scan confirmations rather than pick-list entry. Setup, exceptions and incomplete supplier labels can still need a screen or keypad. The "Workflow benefit" notes describe the intended improvement, not measured savings.

**How each procedure reads**
- **Who · Screen · When**
- **Steps**, numbered. *Scan* means a barcode; *type* means the keypad, then ENT.
- **The system** does the rest, listed after the steps.
- **If it goes wrong:** what to do.

Contents

0. [The system on one page](#0-the-system-on-one-page)
1. [Shift start](#1-shift-start)
2. [Inbound: receiving and put-away](#2-inbound)
3. [Storage: locations, Auto-Shift, corrections, stock counts](#3-storage)
4. [Outbound: orders, picking, check & label, loading](#4-outbound)
5. [Process floor: stations and the warm room](#5-process-floor)
6. [Quality and exceptions](#6-quality-and-exceptions)
7. [Shift end](#7-shift-end)
8. [Reference: command card, keys, messages](#8-reference)

---

## 0. The system on one page

### Screens

| Screen | Who | Where |
| --- | --- | --- |
| **Handheld** | Reach-truck drivers | `/handheld` on the Zebra MC9401 |
| **Office** | Floor coordinator, team leaders, manager | `/admin` on a PC |
| **Station** | Operators at the press, plate press, foil wrapper, warm room | `/station` on a PC or tablet at the station, with a scanner |
| **Receiving desk** | Two operators: one at the keyboard, one with the scanner | `/desk` |
| **Loading** | Whoever loads trailers | `/loading` (opened from an order in the office) |
| **Command card** | Printed, laminated, one per truck | `/card` |

On the browser-only demo, these are `handheld.html`, `admin.html`, `station.html`, `desk.html`, `loading.html` and `card.html`. No installation is needed. The guided shift starts fresh on restart; free play keeps made-up stock in this browser. Separate devices do not share the Pages warehouse. Browser print jobs are simulated, not sent to a physical printer.

### The rules the system keeps for you

- **Auto.** Drivers don't choose work. When a job is done, the next one is on the screen, chosen by:
  1. urgent first: flagged in the office, then eligible jobs waiting at least the configured limit (default 20 minutes). Auto-Shift and stock counts do not age into urgency;
  2. then job type in the coordinator's order (default: Check & label › Pick › Process move › Receiving › Put-away › Auto-Shift › Stock count). Checking first means orders finish as their pallets reach the lane;
  3. ordinary jobs of the same type go nearest first by the route the truck may drive (if enabled). Urgent and aged jobs go oldest first within their job type.
- **Category routing.** Normal put-away chooses a slot matching the product category (yoghurt, cheese, protein drinks). Drivers receive jobs for their configured categories. A correction can record stock in the wrong partition; the system then plans its relocation rather than pretending the mismatch does not exist.
- **First expiry, first out (FEFO).** Picks take the earliest eligible best-before. Expired or held stock cannot ship. A pallet below the item's *minimum days left to ship* is excluded unless the coordinator records a short-date exception; that exception does not override expiry or other holds.
- **Two trucks per aisle.** A third is given work elsewhere, or waits at the aisle entry while carrying.
- **One-way aisles,** if switched on: the handheld says which end to enter from.
- **Every scan is recorded**, with who and when (Office → Audit).

### Words used here

| Word | Means |
| --- | --- |
| **SSCC** | The pallet's 18-digit ID, the bottom barcode on a pallet label. |
| **Location** | A rack position, shown as `AA03C2` (cell A, rack A, bay 03, level C, position 2) or the old `38-02-0-10`; both scan. Also lanes (`DOCK-IN`, `OUT-01`), block lanes (`BL01-03`) and stations. |
| **Job** | One move for one pallet: pick, put-away, Auto-Shift, process move, check & label, receiving. Or one stock count: one location. |
| **Stock count** | A blind count of one location: scan the location, scan what's in it. The handheld doesn't say what to expect. |
| **Auto-Shift** | A rack-to-rack move the system plans: wrong category, next-out to the ground, batch together, dig out buried stock. |
| **Held pallet** | A pallet a driver scanned that had nothing to do. The truck stays empty; the next location scan records where it stands. |
| **Location unknown** | Pallets the system has lost track of (reported missing, or pushed out by a correction). Listed in the office. |
| **Held job** | A job stopped by a problem report, waiting for the coordinator. |

---

## 1. Shift start

### 1.1 Coordinator: open the shift
**Who** Floor coordinator · **Screen** Office → Floor · **When** Before the trucks start

1. Open the office. Check the top numbers:
   - **held** jobs
   - **location unknown** pallets
   - **pallets can't ship**
2. **Held jobs** (Floor → Jobs, status *held*): each says why. Sort out the cause, then **Release** (back to the queue) or **Cancel**.
3. **Location unknown** (Locations): ask drivers to look out for these. Any driver who scans one puts it back on the map.
4. **Blocked** (Locations): damaged or blocked pallets and blocked locations. Release what's been dealt with.
5. **Orders** (Orders & deliveries): enter or import today's orders (4.1).
6. **Deliveries**: announce today's deliveries, with the supplier's pallet list where there is one (2.1).
7. **Printers** (Settings → Label printers → **Check**): every printer should say *ready*.
8. If needed, change the job order or the per-aisle limit (Settings → Dispatch). A job order that changes with the time of day (receiving first while the morning trucks are at the doors) is set once there and switches by itself.
9. **Start a new shift** (Floor → *Drivers this shift*) so each handheld's figures count from now.

> **Workflow benefit:** jobs exist when orders, deliveries and rules call for them; eligible trucks take them as they come free. The coordinator handles the exceptions instead of handing out each move.

### 1.2 Driver: start on a truck
**Who** Reach-truck driver · **Screen** Handheld · **When** Shift start, or after changing trucks

1. Open the handheld page. The truck's ID is remembered. If it shows the setup screen, enter the truck ID (e.g. `RT07`) and your name.
2. **Tick the categories you work this shift** (none ticked = all), then **Start**. A different operator on the same truck does this again (⚙ in the top corner).
3. Check the **command card** is on the truck.
4. Scan `CMD-AUTO` (or press F1). The first job appears.

**If it goes wrong:**
- **Slow network** (near the docks): the handheld says *Sending…*, then *Slow network: your scan is kept*. **Don't scan again.** It retries with the same request ID, and the running server remembers recent answers. Scanning the same thing again while it's on its way is ignored (*Already sending*); anything else you scan waits its turn. After the last retry fails, the first scan's outcome is uncertain and following queued scans are cancelled before sending. Check the current job and audit with the coordinator before scanning again. After a server restart, recent answers are no longer remembered. This prototype is not an offline or durable exactly-once system.
- **At startup** the handheld says *Connecting to SortedWMS…* until the server answers. It keeps trying by itself.
- **No answer / outcome unknown:** do not assume a scan failed just because its answer was lost. Following queued scans were cancelled before sending. Have the coordinator check the current job and Audit before continuing.

### 1.3 Station and desk: open the screen
1. **Station:** open `/station` on the station's PC and choose the station (top right). It's remembered.
2. **Receiving desk:** open `/desk` and choose the desk.
3. On a token-protected server, open **Connection**, enter the server token supplied for the demonstration, and **Connect**. Station and desk tokens are not saved; re-enter them after reloading. A connection failure stays visible instead of leaving a blank screen. The browser-only demo needs no token.

---

## 2. Inbound

### 2.1 Announce a delivery
**Who** Coordinator · **Screen** Office → Orders & deliveries → *Announce a delivery* · **When** When a delivery is booked, at the latest when the truck arrives

1. Enter:
   - delivery number and supplier
   - **category**
   - number of pallets
   - **Received at:** *Dock* (a driver with a handheld) or *Receiving desk* (two people, for labels that need typing)
2. **If the supplier sent a pallet list** (ASN, email, delivery note), paste it in *Delivery list*: one row per pallet, `sscc;item;batch;bestBefore;qty`. The pallet count follows the list.
3. **Announce.**

The system makes a receiving job. With a list, every pallet is received with **one scan**, and a label that disagrees with the list is stopped.

> **Workflow benefit:** with a complete delivery list, receiving takes one SSCC scan per pallet and can flag disagreements at the door. A supplier list is worth discussing alongside better barcodes.

### 2.2 Receive at the dock (handheld)
**Who** Driver · **Screen** Handheld (Auto) · **When** The receiving job comes up

1. The screen shows *Receiving · delivery · supplier* and what to scan next.
2. Scan the pallet's labels. **Any order**: each barcode fills in what it carries.

   | Label | What to scan |
   | --- | --- |
   | With a delivery list | **Bottom barcode (SSCC) only.** Done. |
   | Full GS1 label (e.g. A-ware Kruibeke) | Top barcode, bottom barcode. Done. |
   | 3-barcode label | Top, middle and bottom, any order. |
   | Batch and date as text only (e.g. A-ware Packaging) | Bottom barcode, **type** the batch, **type** the best-before as day-month-year (`09112026`), then the top barcode. |
   | No usable label | Batch, best-before, item, SSCC, then the quantity. |

3. If it asks for the quantity: scan `CMD-FULL` (full pallet), or type the number of cases.
4. *"Pallet 3 of 6 registered. Next pallet."* Go to the next pallet. After the last one the delivery closes by itself.
5. A short delivery: scan `CMD-DONE` twice to close it.

**The system:**
- reads back what was typed (*"expiry date 09-11-2026"*);
- converts counts in consumer units into cases (960 pots = 80 cases of 12);
- blocks a pallet that arrives expired;
- notes a short-dated one;
- creates the put-away job immediately.

**If it goes wrong:**
- *"GTIN … is not in the item list"*: call the coordinator, the item master is missing it.
- *"Label and delivery list disagree"*: nothing was registered. If a wrong scan or typo caused it, scan `CMD-CANCEL` and the pallet starts again; otherwise show the coordinator.
- *"That's the label of DOCK-IN, not a batch number"*: a location label was scanned by mistake. Nothing changed: scan the pallet's labels.
- *"SSCC check digit is wrong"*: rescan, the label is damaged or misread.

### 2.3 Receive at the desk (two operators)
**Who** Keyboard operator + scanner operator · **Screen** Receiving desk · **When** Deliveries announced for the desk

1. Keyboard operator: **Start** the delivery.
2. The screen shows one word in big letters: **BATCH**, **PALLET** or **GS1**. The keyboard operator calls it out.
3. The scanner operator scans that barcode on the pallet. The scan lands on the desk screen.
4. Anything without a usable barcode (e.g. a missing count): the keyboard operator types it into its field and presses Enter. The field the call-out is waiting for is highlighted.
5. *Full pallet* fills in the standard quantity. When the pallet is complete it's registered and the call-out starts again with BATCH.
6. **Delivery done** (click twice) closes a short delivery.

### 2.4 Put-away
**Who** Driver · **Screen** Handheld (Auto) · **When** The put-away job comes up

1. Scan the pallet (at the dock).
2. Drive to the location on the screen (*"Say A3C2 · cell A"*). Scan the location label.

**The system** chooses the slot:
- the right category;
- next to the same batch if possible;
- the next pallet to ship low, later batches higher, blocked or short-dated stock at the top.

**If it goes wrong:**
- **Location label won't scan** (frost, damage): type the **2-digit check digit** printed on the label, then ENT. Drops only: a pickup is confirmed by scanning the pallet, and docks and gates are scanned. The handheld never shows it, so it confirms you're at the right spot.
- **Location occupied or blocked:** scan `CMD-BLOCKED` twice. A new slot appears.
- **Want another free slot of the right category:** just scan it. The system accepts it if it's suitable.

### 2.5 Temperature check on receipt
**Who** Coordinator or QA · **Screen** Office → Stock & trace → *Temperature inspection*

1. Enter:
   - the pallet's SSCC
   - the measured temperature
   - the limits for that product
   - a note
2. **Record inspection.**

Out of range creates a **quality hold**: the pallet can't be picked, and uncollected picks of it get replacement stock. A later in-range reading doesn't clear it. Release it with a reason under *Quality holds*.

---

## 3. Storage

### 3.1 Change the location template (which racks hold which category)
**Who** Coordinator or manager · **Screen** Office → Locations → *Location template*

1. Enter a range, in either naming:
   - `AA01A1` → `AH10E3`
   - whole racks: `AA` → `AD`
   - whole aisles: `31` → `34`
2. Choose the category. **Preview** shows how many locations change and how many pallets would need to move.
3. **Apply.**

**The system** creates Auto-Shift jobs to move every pallet now in a location of the wrong category. Trucks do them when nothing more urgent is waiting.

### 3.2 Auto-Shift (nothing to do but drive)
The system plans rack-to-rack moves on its own:
- **wrong category** after a template change;
- **next out to the ground**, to reduce high-reach pickups when replenishment is complete;
- **same batch together** in a bay;
- **dig out** newer cheese stacked in front of older stock (only when trucks are otherwise idle).

They come up in Auto like any job: scan the pallet, scan the location.

A driver can also move a pallet on their own initiative: scan it, then **scan it again** (or `CMD-MOVE`). The system picks the slot.

### 3.3 Corrections: a pallet isn't where the system says
**Who** Driver · **Screen** Handheld (Auto or Transfer) · **When** You find a pallet in the wrong place, or one the system lost

1. **In Auto:** scan the pallet. The screen says what the system knows about it, and **where it belongs**.
   - If it has a job you can do, you're given it (*"Pick it"*).
   - If it needs moving, a job is made (*"Relocate it"*).
   - Otherwise the truck **holds** it: scan the **location it is actually standing in**. That's the correction.
2. **In Transfer mode** (`CMD-TRANSFER`): scan the pallet, then the location.
3. **From the office** (Locations → *Office transfer*): SSCC and location.

**The system:**
- If another pallet was recorded in that spot, it goes on the **location unknown** list.
- Jobs follow the pallet: a planned pick now goes to where it really is.
- A pallet set down at its process station without the drop scan counts as arrived.
- Every correction is logged with who and when.

### 3.4 Stock check: what's where
**Who** Anyone · **Screen** Handheld (in Auto, or in Stock check mode: `CMD-STOCK` / F5), or Office → Locations → *Stock check*

Scan or type:

| You scan | You get |
| --- | --- |
| A **pallet** | What it is, where it is, **where it belongs** (on the forks: where it's going), any job or hold |
| A **location** | What's in it (block lanes: front first), category, blocked or reserved |
| An **item** (number, EAN, or the label's GS1 barcode) | Every pallet with location and SSCC, next to ship first, with short-dated, blocked and order pallets marked |

In the office, the answer comes with buttons:
- **Block** or **Release** a pallet;
- **Let this one ship short-dated** (a customer has accepted it);
- **Unblock** a location.

### 3.5 Block lanes (cheese crate pallets)
- Lanes fill from the back and empty from the front. Up to two batches share a lane.
- Trucks are only sent to the pallet they can actually lift: the top of the front stack.
- A ⚠ on a lane means a newer batch stands in front of an older one. Idle trucks dig it out.

### 3.6 Stock counts (inventory control without stopping work)
**Who** Coordinator plans, any driver counts · **Screen** Office → Locations → *Stock counts*; handheld · **When** Any time; counts fill the gaps between real jobs

**Coordinator**
1. Office → Locations → **Stock counts**.
2. Set **How many** (default 10), then **Plan counts**. Two ways:
   - **Leave the range empty:** the system chooses. First the places where corrections happened or a lost pallet was last seen, then the locations longest since a count.
   - **A range** (`AA01A1` → `AA10E3`, or a whole aisle): eligible locations in that range, up to **How many**. Plan further counts for a larger area; already queued or active locations are not duplicated.
3. Read the results in the same section: what the system had, what was found, and who counted. *System right …%* is the match rate of recorded location counts, not an independently measured whole-warehouse accuracy.

**Driver**
1. A new count comes up in Auto only when there is **nothing else to do**. Finish a count already assigned before moving to newly arrived work.
2. Go to the location. **Scan the location label.**
3. **Scan the pallet** in it. **Empty?** Scan the location label again.
4. The next job is on the screen.

**Inventory duty:** scan `CMD-COUNT` (Stock count mode). The truck gets count after count and no other work: first the places that need it, then the nearest location not counted this week. It walks the aisle for you. Scan `CMD-AUTO` to go back.

**The system:**
- **Match:** *Count OK*. The location is marked counted.
- **A different pallet:** the system is corrected on the spot, as a transfer. The pallet it had there goes on the **location unknown** list.
- **Empty where a pallet should be:** that pallet goes on the **location unknown** list. A pick waiting for it is held, so nobody drives there for it.
- Counts never jump the queue, however long they wait. Switch them off in Settings (*Job types on*) if a day is too busy.

> **Workflow benefit:** two scans per location, without count-sheet entry. Blind counts let the driver report what is actually there. This demonstrates cycle counting; it does not establish that a site can stop its existing stock-take process.

### 3.7 Manual put-away
**Who** Driver · **Screen** Handheld (Put-away) · **When** Choosing a dock or station pallet rather than taking Auto work

1. Finish any pallet already on the forks, then scan `CMD-PUTAWAY`.
2. Scan the pallet to store. The system chooses a suitable slot and records pickup.
3. Scan the destination location to record the drop. A printed location check digit can confirm a rack drop if the label will not scan (2.4).
4. Choose another pallet, or scan `CMD-AUTO` to return to dispatched work.

**If it goes wrong:** a pallet with a waiting pick or check belongs to that workflow; use Auto instead. A held pallet remains subject to the same category and storage restrictions. Manual does not mean bypassing those rules.

---

## 4. Outbound

### 4.1 Enter or import orders
**Who** Coordinator · **Screen** Office → Orders & deliveries → *New order*, or Office → Import → *Orders*

1. **One order:**
   - order number, customer, shipping lane;
   - one line per item: item, pallets, and a process if the customer needs one, e.g. *Pallet change*;
   - **+ Line** for more.
2. Leave **Verify trailer loading** ticked to load with the trailer scanner (4.4).
3. **Many orders:** paste rows into Import → Orders: `orderId;customer;lane;itemNo;pallets;process;verifyLoading`. Rows with the same order number make one order. Failed orders are listed; the rest go in.

For imports, use `true`, `yes` or `1` in `verifyLoading` to require trailer verification. A requirement on any row applies to the whole order; a blank field uses the original office-confirmation flow. Customer and lane must agree across an order's rows. Pallet counts are positive whole numbers; an omitted count defaults to one. An invalid line rejects that order before any stock is allocated.

**The system** allocates whole pallets by earliest eligible expiry. Pick jobs appear straight away.

### 4.2 Picking
**Who** Driver · **Screen** Handheld (Auto) · **When** The pick comes up (right after check & label by default)

1. Drive to the location shown. Scan the pallet, or the location label.
2. Drive to the shipping lane shown (`OUT-02`). Scan the lane label.

**The customer's requirements** (*No double-stacked pallets*, *Label on the long side*) show in amber on every pick, drop and check for that customer's order. The order brings them up: nothing to look up, nothing to type. The coordinator keeps them in Office → Orders & deliveries → *Customer requirements*.

**The system:**
- **A different pallet with the same item, batch and best-before** is accepted and swapped in.
- **A different batch:** the truck holds it (3.3), and your pick stays as it was.

**If it goes wrong** (each is confirmed by scanning the same code twice):
- `CMD-MISSING`: the next pallet by best-before is allocated straight away. The job is held for the coordinator.
- `CMD-DAMAGED`: the pallet is blocked, a replacement is allocated, and the job is held.
- `CMD-BLOCKED`: the location is blocked, and the job is held.

> **Workflow benefit:** routine picking uses two scans per pallet, without pick-list or quantity entry. Check & label and verified trailer loading have their own scan pairs.

### 4.3 Check & label
**Who** Driver · **Screen** Handheld (Auto) · **When** Picked pallets at the lane

1. Scan the picked pallet. Its shipping label prints on the lane's printer.
2. Stick it on. Scan the new label.

**If it goes wrong:**
- **No label, jammed or torn:** scan the pallet again. The same label prints again.
- *"Pallet is blocked (…)"*, *"Only … days left"* or *"Wrong item for this order"*: the pallet can't ship as it is. Call the coordinator; the reason is on the screen and in the office.

### 4.4 Trailer loading
**Who** Loader · **Screen** Office → Orders → *Loading* (opens the loading screen)

Open **Connection** and choose the order, operator and scanner ID. On a protected server, use the demonstration token. The example air limits and check validity are not approved product requirements; trailer air is recorded separately from product temperature.

1. When the order is checked and staged, **assign the trailer**:
   - trailer ID;
   - air temperature limits and how long an inspection stays valid.
   Then **Open manifest**.
2. **Trailer readiness:** record the trailer air temperature and the five checks (refrigeration running, clean, dry, no odour, no damage) with a note.
   - A failed check puts the trailer on hold.
   - After fixing it, record a passing check, then release the hold with a reason.
3. **Load:** scan each pallet, then the `TRAILER-<ID>` barcode. Only the second scan moves it onto the trailer.
   - The wrong order, wrong trailer, unchecked or held stock is refused.
   - **Cancel pending scan** undoes a half-done pair.
4. **Unload** (if needed): scan the pallet, then the order's shipping lane.
5. When every pallet is loaded: enter the **seal ID**, then **Seal & dispatch**.

**If it goes wrong:** a missing or expired inspection requires a fresh check. After a failed inspection, a passing check alone is insufficient: release the trailer hold separately with a reason. Unloading remains available during a trailer hold or expired check. Goods aboard a failed trailer need their own quality review; the trailer check does not automatically hold each pallet. No physical refrigeration or door interlock is controlled by the demo.

The trailer, seal, readings, loaders and times stay in the shipment and in batch trace.

**Orders without trailer verification:** **Shipped** in the order list once the order is *ready*.

### 4.5 Manual pick
**Who** Driver · **Screen** Handheld (Pick) · **When** Working a chosen order without Auto selecting another order

1. Finish any pallet on the forks, then scan `CMD-PICK`.
2. Scan the order number, for example `O4602`, or choose the order on screen.
3. Follow that order's pickup and drop instructions (4.2). FEFO, category restrictions and aisle limits still apply.
4. If check & label is enabled, complete the pallet and shipping-label scans at the lane (4.3).
5. When that order has no more work for you, choose another order or scan `CMD-AUTO`.

Only the chosen order's work comes to this truck. This is not a way to select an arbitrary batch or override a hold. Trailer loading and dispatch remain separate when verification is required.

---

## 5. Process floor

### 5.1 Send pallets into a process
**Who** Coordinator · **Screen** Office

- **For an order:** choose the process on the order line (4.1). The picked pallet goes through it before shipping.
- **Not for an order** (e.g. hole forming): Stock & trace → *Send a pallet to a process* → SSCC, process, **Start**.

**The system** creates the moves between storage and stations as Auto jobs for the trucks: two scans each, as always.

### 5.2 Work a station (press, plate press, foil)
**Who** Station operator · **Screen** Station

1. A truck drops the pallet at the station. It appears under **Next**.
2. **Scan the pallet to start.** It moves to *On the machine* with a timer against the standard time. The SOP for the station is on the right.
3. Do the work. **Scan the pallet again when done.**
   - If the step needs a new pallet label, it prints at the station.
   - A truck is sent to take the pallet to the next station, back to storage, or to its shipping lane.

**If it goes wrong:**
- *"Busy. Finish the pallet on it first"*: the machine already has a pallet. Scan that one when it's done.
- *"The system has it on a truck job to here"*: the driver set it down without scanning. Ask them to scan the station, or record it with a transfer (3.3).

### 5.3 Warm room
**Who** Nobody, mostly · **Screen** Station (warm room)

1. A truck drops the pallet in. The clock starts by itself.
2. When time is up, the system creates the move out, **flagged urgent**. The next eligible truck takes it according to urgent job order and oldest-first tie-breaking; a busy truck is not interrupted.

The screen shows every pallet's countdown. There are no timers on phones and no lists on paper.

### 5.4 Process log
Every step is recorded with pallet, station, actual time and standard time, and each pallet keeps its own trail.

---

## 6. Quality and exceptions

### 6.1 Held jobs (problem reports)
**Screen** Office → Floor → Jobs (status *held*, with the reason)

| Reported | Already done by the system | You |
| --- | --- | --- |
| Pallet missing | Next pallet allocated; pallet on *location unknown* | Have it looked for. **Release**: a pick's or check's job closes (its replacement carries on). Any other job waits until the pallet is found (Transfer mode puts it back on the map, and the job follows it). |
| Damaged | Pallet blocked; replacement allocated | Inspect. Release the pallet (Locations → Blocked) or leave it blocked. Release the job. |
| Location blocked | Location blocked | Clear the location, then **Release**. That unblocks it too. |

### 6.2 Short-dated stock
- Set the **minimum days left to ship** per item: Stock & trace → *Stock per item* → Min. days → Save. Planned picks of pallets now too short are swapped for good ones.
- Let one short pallet ship anyway: stock check the pallet → **Let this one ship short-dated**.

### 6.3 Quality hold (temperature)
See 2.5.
- Release: Stock & trace → *Quality holds* → enter a release reason → release.
- Releasing doesn't clear other holds (damage, recall, quarantine).

### 6.4 Batch recall
**Screen** Office → Batch recalls

1. Choose the item and enter the batch. **Preview affected stock** shows:
   - where every pallet is;
   - which pallets are picked or loaded;
   - which customers already received it.
2. Enter a reason. **Place recall hold.**
   - Nothing of that batch can be picked, checked or shipped, and later receipts of it are held too.
   - Uncollected picks get other stock.
3. After the decision: **Release batch hold** with the decision.

**Batch trace** (Stock & trace) answers "who got batch X" at any time.

### 6.5 Quarantine
**Screen** Office → Quarantine

1. **Designate positions** (once): a range, with a reason. Normal put-away never uses them.
2. **Request quarantine** for a pallet, with a reason. An urgent Auto-Shift takes it there: two scans, as always.
3. **Approve return** once the decision is made (other holds must be clear). A truck scans it back into normal storage.

### 6.6 Urgent and cancelled jobs
- Floor → Jobs → **Urgent**: the job goes to the next free truck that can do it.
- **Cancel** removes an open job (e.g. a move that's no longer wanted).

---

## 7. Shift end

### 7.1 Driver
1. Finish the job on the forks. A truck can't change mode with a pallet on it.
2. Scan `CMD-PAUSE`. Any job not started goes back to the queue for the next shift.

### 7.2 Coordinator
1. Floor: no **active** jobs left on paused trucks; held jobs dealt with or handed over.
2. Locations: the location unknown and Blocked lists, for the handover. Stock counts: any differences found today.
3. Orders: anything not *ready* or not shipped, and why.
4. Audit: who did what, if a question came up during the shift.
5. Floor → **Drivers this shift**: jobs, scans per move, wrong scans and time without an assigned job per handheld. Use these as prompts to investigate labels, screens and work availability, not as a productivity score or proof of the cause of idle time. Paused breaks do not count as idle.

---

## 8. Reference

### Command card
The routine handheld mode and work commands below have barcodes. Setup, typed supplier fields, office decisions and loading controls may still use the screen. Marked **2×** = scan twice within 30 s to confirm; any other scan cancels.

| Scan | Does |
| --- | --- |
| `CMD-AUTO` `CMD-PICK` `CMD-PUTAWAY` `CMD-TRANSFER` `CMD-STOCK` `CMD-COUNT` `CMD-PAUSE` | Switch mode (not with a pallet on the forks) |
| `CMD-MISSING` `CMD-DAMAGED` `CMD-BLOCKED` **2×** | Report a problem on the current job |
| `CMD-FULL` | Receiving: full pallet quantity |
| `CMD-DONE` **2×** | Receiving: close a short delivery |
| `CMD-MOVE` | Move the held pallet |
| `CMD-CANCEL` | Undo whatever is half-done: a report waiting for its confirm, a held pallet, a transfer, a stock check, or a pallet half-received (it starts again) |

### MC9401 keys

These are the browser key mappings implemented by the demo, not verified physical keypad behavior. Check the actual scanner with `keys.html` (Pages) or `/keys` (server), with the capture field focused. DataWedge and keypad configuration can change what reaches the browser; the command card avoids reliance on function keys.

| Key | Does |
| --- | --- |
| ENT | Sends what's typed (the scanner sends it after each scan) |
| Digits / letters | Type a quantity, batch, date (`09112026`) or location (`A3C2`) |
| Two digits at a drop | The check digit from a location label that won't scan |
| Esc | Clear a half-typed entry; with nothing typed, cancel |
| F1 … F5 | Auto, Pick, Put-away, Transfer, Stock check |

### Modes
Auto does everything; the other modes are for working on your own.

| Mode | Use it for |
| --- | --- |
| Auto | Everything: jobs come by priority, and any scan is understood |
| Pick | Working one order: scan the order number, its picks come one by one |
| Put-away | Putting away a pallet you choose (at the dock or a station). A pallet with a pick or check waiting is Auto's job |
| Transfer | Corrections: pallet, then location |
| Stock check | Asking without changing anything |
| Stock count | Inventory duty: count after count, nearest next |
| Pause | Breaks and shift end |

### Messages on the handheld

| The handheld says | Do |
| --- | --- |
| *Wrong pallet. Go to …* | You scanned another location. Go to the one shown. |
| *That's job #… on RT03* | Another truck has it. Leave it. |
| *Aisle … is full: wait at the entry* | Wait. You're let in when a truck leaves. |
| *… is blocked* | Scan `CMD-BLOCKED` twice for a new slot, or call the coordinator. |
| *Not one of your categories* | It belongs to another team, or your categories need changing (⚙). |
| *Scan the location it stands at to correct it* | You're holding a pallet. Scan its real location, scan it again to move it, or `CMD-CANCEL`. |
| *No label? Scan the pallet again to reprint* | At check & label: scan the pallet again for a new print. |
| *Scan the pallet in …. Empty? Scan the location again* | A stock count: scan what is really there. |
| *Corrected* / *… should be here* | Your count found a difference. The system is already corrected; carry on. |

### Settings worth knowing (Office → Settings)
- **Job order:** which job types come first.
- **Job order by time of day:** windows like `06:00-10:00 RECEIVE, PUTAWAY`. The types named go first, the rest follow the job order. Outside every window the job order applies. The office shows which order applies now.
- **Job types on:** switch a job type off for the day (for example stock counts during a peak).
- **Trucks per aisle:** default 2.
- **Jump the queue after:** minutes before an old job goes urgent.
- **Next-out pallets at ground per item.**
- **Nearest job first:** on or off.
- **One-way aisles:** on or off.
- **Check & label after picking:** on or off.
- **Batches per block lane.**
- **Buried stock:** dig out, pick the newer first, both, or off.
- **Naming on screens:** `AA03C2` or `38-02-0-10`.
- **Label printers:** address, dpi, status.

---

*Procedures match the system as of October 2026. When a procedure changes, change it here in the same pull request.*
