# Automatic operation in SortedWMS

Research date 12 November 2026. Planning assessment against SortedWMS commit 1b1c1fdcd5347f88130e5d62007c2921e7bfaad3.

## Direction

SortedWMS should create, sequence and assign routine work automatically. Operators confirm the physical action. Supervisors set operating policies and resolve decisions that need their authority.

The three usage levels should receive the same automatic planning behaviour, adapted to their equipment, demand and constraints.

| Level | Automatic behaviour | User experience |
| --- | --- | --- |
| Personal storage | Select a suitable storage location, choose stock for a requested withdrawal, identify replenishment needs and suggest counts | Enter an intention or scan an item, then follow a short instruction |
| Small business | Allocate orders, replenish pick locations, group compatible picks, assign the next task and progress work after confirmation | A shared work queue with a clear next action |
| Warehouse | Coordinate trucks and walking pickers, dependent transport steps, deadlines, aisle capacity and recovery | Directed work for operators and an exception view for supervisors |

Personal consumption can begin with a requested quantity. Sales orders, serial tracking, expiry and pallet equipment are capabilities selected for the operation. Unknown future demand requires an explicit configured threshold or a forecast with a stated basis.

## Research method

Reviewed public project source and official documentation for five systems. Odoo and ERPNext provide open inventory implementations within broader ERP products. myWMS and OpenBoxes provide warehouse workflows. OpenWMS supplies transport execution and routing components.

Implementation observations below describe the cited files. Code and documentation review supports the design comparisons. Runtime behaviour, deployment suitability and throughput remain unmeasured.

| Project | Reviewed revision |
| --- | --- |
| Odoo public stock addon | 19.0, f15820760a0132c85a11992ba6e1de963eff687c |
| ERPNext | develop, 0c1f32fd282ce73771482d4d3a36bbf8feb6b07a |
| myWMS, wms2 fork | master, db77e19048ed57913fc71f8afbafec8b1e96e3a3 |
| OpenBoxes | develop, 742bb7664a9e38fcd5a8b0bdf0bf2de08883718e |
| OpenWMS transportation | master, bf224eb54b54c40343671d04e61d08ed42e8c260 |

Development branch snapshots can contain work ahead of a released product.

## Implementation findings

### Odoo — linked demand and movement rules

The public stock addon represents routes through ordered stock rules. Pull rules create movements to satisfy a need at a destination. Push rules can create a following movement. Links between movements preserve their relationship, and cancellation propagation is configurable. The scheduler processes automatic orderpoints and attempts stock assignment for waiting movements.

For SortedWMS, use explicit dependencies for sequences such as reserve storage → pick face → packing. Preserve the order or shortage that caused each replenishment. Cancelling a customer order should recalculate which shared replenishments remain necessary.

This observation concerns stock planning and reservation. The cited code does not establish automatic assignment to individual forklift operators. Sources include the [stock rules implementation](https://github.com/odoo/odoo/blob/f15820760a0132c85a11992ba6e1de963eff687c/addons/stock/models/stock_rule.py) and [orderpoint implementation](https://github.com/odoo/odoo/blob/f15820760a0132c85a11992ba6e1de963eff687c/addons/stock/models/stock_orderpoint.py).

### ERPNext — projected supply and capacity allocation

The reorder implementation compares projected quantity with a configured level and generates Material Requests. It records the projected quantity and triggering settings on generated requests. Requests are grouped by request type and company, and request creation uses savepoints with error collection.

Putaway rules allocate incoming quantities by priority and available capacity, including splitting a receipt across destinations.

For SortedWMS, account for committed demand and incoming work before requesting more stock. Retain the input values behind automatic decisions. Capacity allocation should count destination reservations and quantities already travelling there.

A generated Material Request is a planning document whose later execution depends on its workflow. Sources include [reordering](https://github.com/frappe/erpnext/blob/0c1f32fd282ce73771482d4d3a36bbf8feb6b07a/erpnext/stock/reorder_item.py) and the official [putaway rules](https://docs.frappe.io/erpnext/putaway-rule).

### myWMS — replenishment transports and strategy constraints

Replenishment evaluates fixed item/location assignments, checks existing open transport orders and compares stock with the configured minimum before creating work. Source selection considers reserved quantities. Transport operations expose separate reservation, start, cancellation and pickup-related handling.

Storage strategies contain item and client mixing rules, optional client-specific locations, sort criteria and proximity to picking locations. Picking-order generation requires compatible strategies.

For SortedWMS, carry these ideas into compatible work grouping and reservation handling. Each replenishment needs a defined source, destination, quantity and ownership. A queued transport can be replanned when conditions change. A picked load requires a recovery instruction that accounts for its physical custody. Sources include [replenishment business logic](https://github.com/wms2/mywms/blob/db77e19048ed57913fc71f8afbafec8b1e96e3a3/dev/wms2-ejb/src/main/java/de/wms2/mywms/replenish/ReplenishBusiness.java), [storage strategy](https://github.com/wms2/mywms/blob/db77e19048ed57913fc71f8afbafec8b1e96e3a3/dev/wms2-ejb/src/main/java/de/wms2/mywms/strategy/StorageStrategy.java) and [picking-order generation](https://github.com/wms2/mywms/blob/db77e19048ed57913fc71f8afbafec8b1e96e3a3/dev/wms2-ejb/src/main/java/de/wms2/mywms/picking/PickingOrderGenerator.java).

### OpenBoxes — available stock and ordered pick suggestions

Product availability distinguishes on-hand quantity, allocation, holds and quantity available to promise. Candidate sorting considers expiry, available quantity and zero-availability placement. The picking and replenishment services use available stock to produce suggestions and validate quantities.

The reviewed code has two suggestion paths with different shortage handling. StockMovementService can suggest a partial quantity when some stock is available. PicklistService's suggestion path requires enough total available quantity to meet the request. This is a reason to trace each actual workflow entry point during implementation comparison.

For SortedWMS, keep a shared stock eligibility calculation and make partial-order behaviour an explicit policy. Reuse the calculation for initial planning and replacement allocation. Sources include [availability](https://github.com/openboxes/openboxes/blob/742bb7664a9e38fcd5a8b0bdf0bf2de08883718e/grails-app/services/org/pih/warehouse/inventory/ProductAvailabilityService.groovy), [stock movements](https://github.com/openboxes/openboxes/blob/742bb7664a9e38fcd5a8b0bdf0bf2de08883718e/grails-app/services/org/pih/warehouse/inventory/StockMovementService.groovy) and [picklists](https://github.com/openboxes/openboxes/blob/742bb7664a9e38fcd5a8b0bdf0bf2de08883718e/grails-app/services/org/pih/warehouse/picklist/PicklistService.groovy).

### OpenWMS — transport lifecycle and routing events

Transport orders expose created, initialized, started, interrupted, failed, cancelled and finished states. TransportationServiceImpl applies changes through a state manager and publishes transport events. The routing documentation describes workflows that book a transport unit at an observed location, create a transport order and return its next destination to a subsystem.

For SortedWMS, distinguish planned work from observed movement and physical completion. Give interruption and failure explicit meanings. Keep the scanner confirmation boundary when automatically progressing dependent work.

The routing documentation focuses on conveyor/material-flow integration. Applying its lifecycle ideas to human-operated trucks is a design inference. Sources include [transport states](https://github.com/openwms/org.openwms.tms.transportation/blob/bf224eb54b54c40343671d04e61d08ed42e8c260/src/main/java/org/openwms/tms/TransportOrderState.java), [transport service](https://github.com/openwms/org.openwms.tms.transportation/blob/bf224eb54b54c40343671d04e61d08ed42e8c260/src/main/java/org/openwms/tms/impl/TransportationServiceImpl.java) and [routing documentation](https://openwms.github.io/org.openwms.tms.routing.lib/).

## SortedWMS assessment

The current implementation already provides automatic dispatch, equipment and duty filtering, aisle capacity checks, urgency escalation, nearest-job selection within parts of the priority order, automatic slot selection, FEFO and Auto-Shift. Wave planning allocates pallets, boxes and small picks. Pick-face replenishment uses thresholds and avoids a second open replenishment to the same destination.

The following observations identify where to extend that foundation.

| Area | Current evidence | Proposed improvement |
| --- | --- | --- |
| Dispatch | engine.js nextTaskFor filters and ranks candidates, then returns one task | Expose eligibility reasons, dependencies and the selected ranking inputs |
| Replenishment | operations.js planReplenishment compares on-hand face quantity with a trigger | Add near-term pick demand, inbound commitments and an explanation when no source or capacity is available |
| Failure visibility | planReplenishment skips missing sources and catches unavailable-source/capacity failures | Retain structured blocked reasons and retry when the relevant condition changes |
| Walking work | waves.js waveTasks sorts by location and supports claims | Direct the next eligible task to a walking worker using duty, zone, active work and capacity |
| Wave release | autoWave returns while any wave is active | Consider bounded release of independent work, with order policies and resource reservations preserved |
| Low stock | availability computes available stock, and its low flag compares that available quantity with reorderPoint | Define separate purchase-demand and internal-replenishment policies using the appropriate stock and time horizon |
| Recovery | Pallet replacement, stock checks, task release and handoffs already exist | Map recovery coverage across pallet, case and bin entry points, then close specific gaps |

These observations come from src/engine.js, src/operations.js, src/waves.js, src/bins.js, src/foundation.js and server/commands.js at the SortedWMS revision above.

## Proposed delivery sequence

### 1. Explain automatic decisions and blocked work

Extend existing eligibility and ranking logic to produce structured reasons. Capture why a selected task won and why required work is waiting. Include the causing order, relevant rule/settings and decision time in recorded decisions.

An idle worker should receive a useful explanation when demand exists but no executable task can be assigned. Supervisors should be able to distinguish missing stock, unavailable equipment, a blocked aisle and a predecessor still in progress.

### 2. Replenish for committed demand

Calculate projected pick-face stock over a configurable operating horizon from eligible face stock, committed pick demand and replenishments already inbound. Apply pack sizes and destination capacity when calculating top-ups.

Connect each required replenishment to the work it unblocks. Coalesce compatible demand into existing open work, and reconsider quantities when demand is cancelled. Use the existing task and reservation representations where their behaviour supports this.

Example for later evaluation follows a face holding 12 pieces, with 36 committed to near-term orders and 24 already arriving. A target of 12 remaining pieces requires a further 12, subject to source eligibility and pack rules.

### 3. Direct work across equipment and walking roles

Extend automatic assignment to walking pickers and relevant replenishment roles. Keep eligibility constraints first. Rank executable work using deadlines, urgency, work unlocked, waiting time and travel.

Increase released work only within configured capacity. Keep release, reservation and assignment consistent when several workers request work together.

For stacked pallets, assess whether compatible queued tasks can be offered as a combined pickup using the existing load and clearance checks. Each pallet retains its own task, destination and custody history.

### 4. Recover automatically when conditions change

On a shortage, blocked location, new receipt or released hold, reconsider affected unstarted work. Reallocate eligible alternatives, select another valid destination, or retain a specific blocked reason.

Track whether an operator has accepted or physically picked work before reassignment. A disconnected device with a pallet in custody needs explicit reconciliation. Replacement and recovery still apply stock holds, ownership rules and equipment constraints.

### 5. Evaluate policies through the existing demo

Use generic stock, locations and orders. Compare policy settings on repeatable scenarios through the existing clock and bots.

Later measures should include completed orders by deadline, empty travel, shortages, time blocked on replenishment, manual interventions and recovery time. Include crowded aisles, mixed pallet/bin demand, multiple scanners and partial outages.

This is a later validation plan. Research in this pass consisted of source and documentation review.

## Implementation boundary

Keep policy changes within the current command/journal architecture where possible. Start with decision reasons, demand accounting and task dependencies. Add configuration only for an operating decision a user needs to make.

The first implementation slice should explain blocked replenishments and link one replenishment to the pick demand it supplies. That provides a reviewable path from existing automatic operation to coordinated automatic recovery.

## First implementation slice

The first slice adds demand-aware unit replenishment for configured bin and mezzanine pick faces. It previews the next wave's configured maximum number of orders, preserving whole-pallet and whole-box allocation before calculating small-pick demand. Face status includes physical quantity, usable quantity, committed small picks, inbound replenishments, projected quantity and structured blocked reasons.

Order entry and normal clock ticks reconsider replenishment. Existing incoming transports count toward supply, source pallets cannot supply a second face simultaneously, and top-up quantities respect the physical face maximum. Replenishment tasks retain the demand inputs and causing orders.

Wave planning can reserve incoming units and attach the transport ID to dependent picks. The handheld receives executable picks after the confirmed drop. Bin top-ups become loose lot stock, and mezzanine top-ups become plates usable by wave confirmation. A cancelled predecessor releases its unpicked demand for later wave planning. Demands larger than a unit face can hold progress through successive picks and replenishments.

Older journals retain the original planning behaviour until an explicit activation command appears in the journal. Existing split transports retain their original drop behaviour. Fresh stores record the planner version at creation.

The operating horizon in this slice uses the next wave's order count. Time-based forecasting, automatic grouping of stacked pickups and general walking-worker dispatch remain subsequent work. Regression cases are included for a later functional test pass.
