# SortedWMS

A working prototype of **Auto dispatch** for reach trucks, built to show the floor what it could look like next to the WMS in use today.

Open `index.html` in a browser to run a simulated shift. No install or server needed.

## What it does

### Auto
A reach truck driver doesn't choose work from a menu. The moment they finish a job, the next one is on the screen.

Jobs are handed out in the order the coordinator sets:

1. **Urgent jobs** first: those flagged by the coordinator, and any job that has waited longer than the "jump the queue" time (default 20 min), so nothing gets forgotten at the bottom of the list.
2. Then by **job type**, in the coordinator's order. The default is Replenishment › Pallet pick › Put-away › Auto-Shift.
3. Within the same type, the **nearest job** to where the truck is now (can be switched off; then it's oldest first).

The coordinator can switch any job type off, reorder the types, flag or cancel single jobs, and set each truck to **Auto**, **Auto-Shift only** or **Paused**.

### Two scans per job
Every job is two inputs: scan the pick-up location, scan the drop location. The scanner sends its own Enter, so the driver never presses a key. A wrong scan shows what's wrong and changes nothing, and the next correct scan just works. There's nothing to dismiss.

### Max 2 reach trucks per aisle
A truck counts against an aisle from the moment it is sent there until it leaves. Auto never sends a third truck into a full aisle; that truck gets the best job somewhere else instead.
If a driver picks up a pallet that has to go into a full aisle, the handheld says **wait at the aisle entry**, and lets them in as soon as a truck leaves. Waiting trucks stand outside the aisle, so two full aisles can never lock each other up. The limit is a setting (1–4).

### Auto-Shift (rack-to-rack)
Rack-to-rack moves where **the system picks the destination slot**: the nearest free reserve slot to the pallet, lower levels first, and avoiding aisles that are full.

- The coordinator can queue shift jobs, which Auto hands out like any other job type.
- A driver with nothing to do can **scan any pallet in the racking**. The system creates the move, chooses the slot, and shows it. Two scans, no menus.
- If the driver prefers another free slot, they just scan it instead and it's accepted (the coordinator can turn this off).
- Slots are reserved the moment they're handed out, so two trucks are never sent to the same one.

### Problems
**Report a problem** on the handheld: location blocked, pallet missing, or pallet damaged. The job is held for the coordinator and the driver gets the next one straight away. If the blocked location is an Auto-Shift drop slot, the system just picks another slot. A driver can't pause while carrying a pallet.

## Files

| File | What it is |
| --- | --- |
| `engine.js` | The dispatch rules. Plain JavaScript with no dependencies; runs in a browser or Node. |
| `index.html` | The demo: aisle board, handheld screens, coordinator controls, job queue and floor log. |
| `test/engine.test.js` | Tests for every rule above. Run with `npm test` (Node 18+). |

## Open questions for the floor

- **Auto-Shift as used at the other site:** is this how it worked (system picks the slot, driver scans twice)? Or was it a separate stream of rack-to-rack jobs a truck worked through? Both are supported here (driver-started shifts, and trucks set to "Auto-Shift only").
- **Aisle limit:** should a truck waiting to drop count against the aisle it's waiting for, or stay outside like here?
- **Location codes:** the demo uses `aisle-bay-level` (`03-012-2`, level 0 = pick face). Real labels will differ.
- **Connecting to the current WMS:** this prototype keeps its own job list. Running it for real means reading jobs from, and confirming moves back to, the existing system, which depends on what interface that system offers.
