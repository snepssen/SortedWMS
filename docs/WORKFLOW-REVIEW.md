# Workflow review

Every procedure in [SOP.md](SOP.md) was walked through step by step against the system, looking for anything that costs a scan, a tap, a walk or a phone call. What was found, and what happened to it.

## Fixed

| Step | What was in the way | Now |
| --- | --- | --- |
| Process floor (5.2, 5.3) | Stations and the warm room had no screen on the real server, only in the simulated demo. | **Station screen** (`/station`): <ul><li>scan to start, scan when done</li><li>the SOP on screen</li><li>a timer against the standard time</li><li>the queue, and what's coming</li><li>warm room countdowns</li></ul> |
| Receiving desk (2.3) | The two-person desk had no screen on the real server. | **Desk screen** (`/desk`): <ul><li>the call-out word in big letters</li><li>scans land on it</li><li>typed fields for whatever has no barcode</li><li>the field being called for is highlighted</li></ul> |
| Orders (4.1) | An order could have only one line, and orders couldn't be imported. | Lines with **+ Line**, and Import → Orders from a spreadsheet. |
| Deliveries (2.1) | A supplier's pallet list couldn't be entered, so 1-scan receiving was out of reach. | Paste the list when announcing: **one scan per pallet**. |
| Shift start (1.2) | A handheld's categories were fixed when it was first set up. Operators swap trucks. | The driver ticks their categories at shift start (⚙). The office can change them too. |
| Process start (5.1) | Pallets could only go through a process via an order line. Hole forming isn't on orders. | Office → Stock & trace → *Send a pallet to a process*. |
| Blocked stock (6.1, 6.2) | Damaged pallets and blocked locations couldn't be released from the office, and a short pallet couldn't be let through. The API could; the screen couldn't. | Locations → **Blocked** list with Release/Unblock. The stock check answer has Block, Release and *Let this one ship short-dated*. |
| Check & label (4.3) | A jammed or torn label left the driver stuck: no way to print it again. | **Scan the pallet again** prints the same label again. |
| Stations (5.2) | A pallet set down without the drop scan couldn't be started, and the station said *"Already done"*. A finished pallet got *"has no process"*. | A correction transfer onto the station counts as arrival. The messages say what's actually going on. |
| Desk (2.3) | A scan at the desk with no delivery open crashed the request. A mode barcode would have switched the desk into a truck mode. | Both answered with a clear message. |
| Blocking (6.2) | A blocked pallet kept its planned move to ground level: a truck trip for a pallet that won't ship. | That move is dropped when the pallet is blocked. |
| Drops (2.4, 3.2) | A location label that won't scan (frost, damage) left two bad options: type the location shown on the screen, which proves nothing, or call someone. | **Check digits**, as on EDEKA's system: type the two digits printed on the label. The screen never shows them. |
| Picking, check & label (4.2, 4.3) | Customer requirements (no double stacking, label position) lived in people's heads, or behind extra screens in older systems. | **Customer requirements** come up on the handheld with every job on that customer's order, in amber. Kept per customer in the office. |
| Network lag (1.2) | Near the docks a scan could take seconds to answer. A second scan was dropped without a word, an impatient rescan could count twice (a pallet scanned twice in Auto means *move it*), and a request that hung locked the handheld. | Scans **queue** instead of dropping. A late answer is **asked for again with the same request ID**, and the server does it once. The screen says *Sending…* or *Slow network: your scan is kept*, and *Connecting…* at startup. |
| Receiving (2.2, 2.3) | A wrong value while receiving (a typo, or the dock label scanned by mistake and taken as the batch) could only be fixed by the coordinator. | **CMD-CANCEL** starts the pallet again. A location label is never taken as a batch number. |
| Held jobs (6.1) | A held job could be released for a pallet nobody could find, sending a truck to an empty spot. | Release waits until the pallet is found. A check whose pallet left the order is closed, like a pick. |
| Shift start (1.1) | The job order was one list all day: receiving first in the morning meant changing it by hand, and changing it back. | **Job order by time of day** (Settings → Dispatch): windows like *06:00-10:00 receiving and put-away first*. It switches by itself; the office shows which order applies now. |
| Shift end (7.2) | No way to see per handheld how the shift went. | **Drivers this shift** (Floor): jobs, pallet moves, scans per move, wrong scans and idle time per handheld, from a *Start a new shift* button. For coaching, not counting. |
| Stock counts (3.6) | No inventory control: differences were found when a pick failed. | **Count jobs** for idle trucks: blind, two scans, the system corrected on the spot. The places with corrections and lost pallets go first. **Stock count mode** for a driver on inventory duty. Accuracy in the office. |

## Recommended: decisions for the floor and management

These cost nothing to build. They are settings, supplier requests or site data.

1. **Ask A-ware Packaging for batch and best-before in a barcode, or a delivery list.**
   - Today their pallets need two typed entries each.
   - With a full GS1 label it's two scans; with a list, one.
   - The same request applies to every supplier: a delivery list makes receiving one scan per pallet and stops wrong deliveries at the door.
2. **Relabel the racks to `AA03C2`, one aisle at a time.**
   - Both labels scan during the changeover.
   - The short spoken form (*A3C2*) is what drivers say and type.
3. **Confirm the one-way direction of each aisle and switch it on.**
   - The signs are up already.
   - With it on, "nearest job" means nearest by the route a truck may drive.
4. **Real values for the process floor.** For each station:
   - standard minutes;
   - SOP steps;
   - warm room time;
   - whether a pallet change always needs a new label.
   Today these are example values.
5. **Quality limits.** Product temperature limits, trailer air limits and how long a trailer check stays valid all need QA's numbers, not the examples.
6. **Minimum days left to ship, per item.** Is it ever different per customer? If yes, that's a build (see below).
7. **Check & label for every order, or only some customers?** Today it's one setting for all.
8. **Personal logins before live use.** Today a handheld is identified by its truck ID and the name typed at shift start. That is good enough for a demo, not for an audit trail with legal weight.

## Worth building next

In order of what they save on the floor:

1. **Printer alerts.** Ask every printer for its status every few minutes, and show *paper out* in the office and on the handheld of a driver heading to that lane.
2. **Customer rules the system enforces:** minimum days left per customer, and checks such as *no double stacking* at the lane. Requirements are already shown to the driver; this would make the system hold to them.
