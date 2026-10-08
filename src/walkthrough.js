(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('../server/site'), require('../server/commands'), require('./gs1'));
  else root.SortedWalkthrough = factory(root.SortedSite, root.SortedCommands, root.GS1);
})(typeof self !== 'undefined' ? self : this, function (Site, Commands, GS1) {
  'use strict';
  const steps = [
    ['admin', 'Partition storage', 'Reserve rack AP for protein drinks.', 'Apply partition'],
    ['admin', 'Assign the reach truck', 'RT-PRO works protein drinks in Auto.', 'Assign truck'],
    ['office', 'Announce the delivery', 'Two pallets, one item, two best-before dates. The supplier list supplies the receiving details.', 'Announce delivery'],
    ['office', 'Open receiving', 'The receiving desk takes delivery DEMO-IN.', 'Open delivery'],
    ['scanner', 'Receive the first pallet', 'Scan the supplier SSCC. Item, batch, date and quantity come from the delivery list.', 'Scan first SSCC'],
    ['scanner', 'Receive the second pallet', 'The second pallet has a later best-before date.', 'Scan second SSCC'],
    ['scanner', 'Put away: pick up', 'Auto assigns the first put-away. Scan the pallet at receiving.', 'Scan pallet'],
    ['scanner', 'Put away: drop', 'Scan the assigned protein-drink location.', 'Scan destination'],
    ['scanner', 'Put away: pick up', 'The next put-away arrives automatically.', 'Scan pallet'],
    ['scanner', 'Put away: drop', 'Both pallets are now stored and available.', 'Scan destination'],
    ['office', 'Release a customer order', 'One pallet for Fresh Market, with a pallet change before shipping. FEFO selects the earlier date.', 'Release order'],
    ['scanner', 'Report damaged stock', 'The selected pallet has damaged packaging. Confirm the report with two command-card scans.', 'Report damaged twice'],
    ['scanner', 'Pick the replacement', 'Auto allocates the next eligible pallet. The damaged pallet stays blocked.', 'Scan replacement'],
    ['scanner', 'Deliver to the press', 'Scan the station location to hand the pallet to its operator.', 'Scan station location'],
    ['station', 'Start pallet change', 'Scan the pallet at the hydraulic press.', 'Scan pallet to start'],
    ['station', 'Complete pallet change', 'Advance the demonstration clock by five minutes, then scan the pallet again. A pallet label is generated.', 'Finish pallet change'],
    ['scanner', 'Collect from the press', 'Auto creates the move to the shipping lane.', 'Scan pallet'],
    ['scanner', 'Drop at shipping', 'Scan OUT-01. Checking and labelling follows.', 'Scan shipping lane'],
    ['scanner', 'Check the pallet', 'Scan the picked pallet to generate its shipping label.', 'Scan pallet'],
    ['scanner', 'Confirm the label', 'Scan the generated shipping label.', 'Scan shipping label'],
    ['office', 'Confirm shipment', 'The order is ready. This prototype records shipment with an office confirmation; trailer verification is still a future workflow.', 'Confirm shipped'],
    ['office', 'Trace the shipped batch', 'Follow the replacement batch from delivery to Fresh Market. The damaged batch remains in stock on hold.', 'Trace batch'],
  ].map(([role, title, detail, action]) => ({ role, title, detail, action }));

  const operationSteps = (rows) => rows.map(([role, title, detail, action, execute]) => ({ role, title, detail, action, execute }));
  const stock = (d, code, sscc, batch, expiry) => ({ code, sscc, itemNo: 'Y1001', batch, expiry, qty: 96 });
  const shiftSteps = operationSteps([
    ['office', 'Load opening stock', 'Two yoghurt batches stand on upper levels. The earlier date should ship first.', 'Load stock', (d, run) => run('importStock', { rows: [stock(d, 'AA01C1', d.first, 'YOG-EARLY', '2026-11-20'), stock(d, 'AB01D1', d.second, 'YOG-LATER', '2026-12-20')] })],
    ['admin', 'Assign Auto-Shift work', 'RT-YOG handles yoghurt replenishment and relocation only.', 'Assign truck', (d, run) => run('addTruck', { id: d.truckId, categories: ['YOG'], mode: 'shift' })],
    ['admin', 'Bring next-out stock down', 'Keep one next-out pallet per item on the ground. The later batch stays above.', 'Enable ground replenishment', (d, run) => run('setConfig', { patch: { groundNextPerItem: 1 } })],
    ['scanner', 'Collect the earlier batch', 'Auto-Shift selects YOG-EARLY by expiry date.', 'Scan pallet', (d) => d.scanExpected()],
    ['scanner', 'Replenish the ground', 'Scan the assigned ground-level position.', 'Scan ground location', (d) => d.scanExpected()],
    ['admin', 'Change the partition', 'Reserve the occupied position for protein drinks. Its yoghurt pallet now needs relocation.', 'Apply partition change', (d, run) => { const code = d.wh.label(d.wh.pallets[d.first].loc); return run('applyTemplate', { from: code, to: code, category: 'PRO' }); }],
    ['scanner', 'Collect displaced stock', 'The partition change creates a relocation job for the yoghurt truck.', 'Scan pallet', (d) => d.scanExpected()],
    ['scanner', 'Relocate to yoghurt storage', 'Scan the new yoghurt destination. The protein-drink position is left empty.', 'Scan destination', (d) => d.scanExpected()],
  ]);
  const manualSteps = operationSteps([
    ['office', 'Load opening stock', 'Three yoghurt pallets in three positions, with progressively later dates.', 'Load stock', (d, run) => run('importStock', { rows: [stock(d, 'AA01A1', d.first, 'YOG-EARLY', '2026-11-20'), stock(d, 'AB01A1', d.second, 'YOG-LATER', '2026-12-20'), stock(d, 'AA02A1', d.fourth, 'YOG-SPARE', '2027-01-20')] })],
    ['office', 'Release two orders', 'FEFO allocates the earlier pallet to 4601 and the next pallet to 4602.', 'Release orders', (d, run) => { run('addOrder', { id: '4601', customer: 'Fresh Market', lane: 'OUT-01', lines: [{ itemNo: 'Y1001', pallets: 1 }] }); return run('addOrder', { id: '4602', customer: 'City Deli', lane: 'OUT-02', lines: [{ itemNo: 'Y1001', pallets: 1 }] }); }],
    ['admin', 'Assign manual picking', 'RT-YOG waits for an order number instead of choosing work automatically.', 'Assign truck', (d, run) => run('addTruck', { id: d.truckId, categories: ['YOG'], mode: 'pick' })],
    ['scanner', 'Choose order 4602', 'Scan O4602. The truck takes only that order; 4601 remains queued.', 'Scan order number', (d, run) => run('scan', { id: d.truckId, code: 'O4602' })],
    ['scanner', 'Pick for City Deli', 'Scan the pallet allocated to 4602.', 'Scan pallet', (d) => d.scanExpected()],
    ['scanner', 'Drop at OUT-02', 'Scan the shipping lane assigned to City Deli.', 'Scan shipping lane', (d) => d.scanExpected()],
    ['scanner', 'Check the manual pick', 'Checking and labelling still applies in manual mode.', 'Scan pallet', (d) => d.scanExpected()],
    ['scanner', 'Confirm its shipping label', 'The order becomes ready. Order 4601 remains untouched.', 'Scan shipping label', (d) => d.scanExpected()],
    ['scanner', 'Switch to manual put-away', 'Scan the put-away command on the truck command card.', 'Scan CMD-PUTAWAY', (d, run) => run('scan', { id: d.truckId, code: 'CMD-PUTAWAY' })],
    ['office', 'Register a dock pallet', 'A received yoghurt pallet is waiting at DOCK-IN.', 'Register dock stock', (d, run) => run('importStock', { rows: [stock(d, 'DOCK-IN', d.third, 'YOG-DOCK', '2027-02-20')] })],
    ['scanner', 'Start manual put-away', 'Scan the dock pallet. The engine assigns a yoghurt slot and records pickup.', 'Scan dock pallet', (d, run) => run('scan', { id: d.truckId, code: d.third })],
    ['scanner', 'Complete manual put-away', 'Scan the assigned rack position.', 'Scan destination', (d) => d.scanExpected()],
    ['scanner', 'Switch to corrections', 'Scan the transfer command. The next two scans record where a pallet actually stands.', 'Scan CMD-TRANSFER', (d, run) => run('scan', { id: d.truckId, code: 'CMD-TRANSFER' })],
    ['scanner', 'Identify the misplaced pallet', 'Scan YOG-EARLY, which is allocated to the unpicked order 4601.', 'Scan pallet', (d, run) => run('scan', { id: d.truckId, code: d.first })],
    ['scanner', 'Record its actual location', 'YOG-EARLY is physically at AA02A1. The system thought YOG-SPARE stood there; it now goes on the location-unknown list. The pick for 4601 follows YOG-EARLY.', 'Scan AA02A1', (d, run) => run('scan', { id: d.truckId, code: 'AA02A1' })],
    ['scanner', 'Find the displaced pallet', 'YOG-SPARE has been found elsewhere. Scan its SSCC.', 'Scan found pallet', (d, run) => run('scan', { id: d.truckId, code: d.fourth })],
    ['scanner', 'Restore its location', 'Scan AA03A1. YOG-SPARE returns to the stock map and the unknown-location list clears.', 'Scan AA03A1', (d, run) => run('scan', { id: d.truckId, code: 'AA03A1' })],
  ]);
  const qualitySteps = operationSteps([
    ['office', 'Announce chilled receiving', 'One yoghurt pallet is arriving with a supplier pallet list.', 'Announce delivery', (d, run) => run('addDelivery', { id: 'QUALITY-IN', supplier: 'Demo dairy', category: 'YOG', at: 'desk', list: [{ sscc: d.first, itemNo: 'Y1001', batch: 'YOG-REVIEW', expiry: '2026-11-20', qty: 96 }] })],
    ['office', 'Open the receiving desk', 'DESK1 takes the announced delivery.', 'Open delivery', (d, run) => run('deskStart', { id: 'DESK1', deliveryId: 'QUALITY-IN' })],
    ['scanner', 'Receive the pallet', 'Scan its supplier SSCC to register the stock.', 'Scan SSCC', (d, run) => run('scan', { id: 'DESK1', code: `00${d.first}` })],
    ['office', 'Record a temperature concern', 'Example only: a 9 C reading falls outside the recorded 2 to 6 C limits. This creates a quality hold; real limits come from the product specification.', 'Record 9 C inspection', (d, run) => run('recordTemperature', { sscc: d.first, temperature: 9, min: 2, max: 6, reason: 'Receiving probe reading outside demo limits; awaiting quality review.' })],
    ['admin', 'Assign storage work', 'Held stock may be moved into chilled storage, but cannot be allocated to ship. This demo does not designate a physical quarantine zone.', 'Assign truck', (d, run) => run('addTruck', { id: d.truckId, categories: ['YOG'] })],
    ['scanner', 'Collect held stock', 'The put-away keeps the quality hold attached to the pallet.', 'Scan pallet', (d) => d.scanExpected()],
    ['scanner', 'Store held stock', 'Scan the assigned yoghurt slot. Shipping eligibility stays blocked.', 'Scan destination', (d) => d.scanExpected()],
    ['office', 'Load an eligible replacement', 'A later-expiring yoghurt pallet is available without a quality hold.', 'Load replacement stock', (d, run) => run('importStock', { rows: [stock(d, 'AA01A1', d.second, 'YOG-CLEAR', '2026-12-20')] })],
    ['office', 'Allocate an order', 'Order 4701 skips the earlier pallet on hold and takes YOG-CLEAR.', 'Release order 4701', (d, run) => run('addOrder', { id: '4701', customer: 'Fresh Market', lane: 'OUT-01', lines: [{ itemNo: 'Y1001', pallets: 1 }] })],
    ['office', 'Record a follow-up reading', 'A 4 C reading is recorded. An in-range reading does not release the existing hold.', 'Record 4 C follow-up', (d, run) => run('recordTemperature', { sscc: d.first, temperature: 4, min: 2, max: 6, reason: 'Follow-up reading recorded; quality decision still pending.' })],
    ['office', 'Record the review decision', 'A simulated quality review releases the hold with a reason. Any independent damage block would remain.', 'Release quality hold', (d, run) => run('releaseQualityHold', { sscc: d.first, reason: 'Demo review completed: original measurement investigated and stock accepted by quality.' })],
    ['office', 'Allocate released stock', 'Order 4702 can now take the earlier yoghurt pallet. The inspection and release history remains attached.', 'Release order 4702', (d, run) => run('addOrder', { id: '4702', customer: 'City Deli', lane: 'OUT-02', lines: [{ itemNo: 'Y1001', pallets: 1 }] })],
  ]);
  const scenarios = {
    shipping: { label: 'Receiving to shipping', steps, truckId: 'RT-PRO', complete: 'Received, processed, shipped and traced', outcome: 'Fresh Market received PRO-LATER. PRO-EARLY remains blocked in storage.' },
    shift: { label: 'Auto-Shift & partitioning', steps: shiftSteps, truckId: 'RT-YOG', complete: 'Replenished and relocated', outcome: 'YOG-EARLY is on the ground in yoghurt storage. The repartitioned position is empty; YOG-LATER stays above.' },
    manual: { label: 'Manual work & corrections', steps: manualSteps, truckId: 'RT-YOG', complete: 'Picked, put away and reconciled', outcome: '4602 is ready. The pick for 4601 follows its corrected location. YOG-SPARE is found and the location-unknown list is empty.' },
    quality: { label: 'Temperature & quality holds', steps: qualitySteps, truckId: 'RT-YOG', complete: 'Inspected, held and reviewed', outcome: '4701 took eligible replacement stock. After a recorded quality decision, 4702 allocated YOG-REVIEW. Both readings and the release decision remain in the history.' },
  };

  class Walkthrough {
    constructor(site, scenario = 'shipping') {
      if (!scenarios[scenario]) throw new Error(`Unknown scenario ${scenario}`);
      this.scenarioId = scenario;
      this.scenario = scenarios[scenario];
      this.steps = this.scenario.steps;
      this.truckId = this.scenario.truckId;
      this.time = Date.UTC(2026, 9, 8, 6);
      this.wh = Site.buildWarehouse(site, () => this.time);
      this.journal = [];
      this.index = 0;
      this.trace = null;
      this.first = GS1.makeSscc(3, '8799999', 9101);
      this.second = GS1.makeSscc(3, '8799999', 9102);
      this.third = GS1.makeSscc(3, '8799999', 9103);
      this.fourth = GS1.makeSscc(3, '8799999', 9104);
      this.wh.setConfig({ groundNextPerItem: 0, checkAfterPick: true });
    }
    get step() { return this.steps[this.index] || null; }
    run(op, args) { return this.command(op, args, this.step.role === 'scanner' ? args.id || this.truckId : this.step.role); }
    scanExpected() {
      const ins = this.wh.instruction(this.truckId);
      const code = ['pickup', 'check-pallet'].includes(ins.kind) ? ins.pallet.sscc : ins.target;
      if (!code) throw new Error('No barcode expected for this step');
      return this.run('scan', { id: this.truckId, code });
    }
    get scanCode() {
      if (this.scenarioId === 'quality' && this.index === 2) return `00${this.first}`;
      if (this.scenarioId === 'shipping' && [4, 5].includes(this.index)) return `00${this.index === 4 ? this.first : this.second}`;
      if (this.scenarioId === 'manual') {
        const codes = { 3: 'O4602', 8: 'CMD-PUTAWAY', 10: this.third, 12: 'CMD-TRANSFER', 13: this.first, 14: 'AA02A1', 15: this.fourth, 16: 'AA03A1' };
        if (codes[this.index]) return codes[this.index];
      }
      if (!this.wh.trucks[this.truckId]) return null;
      const ins = this.wh.instruction(this.truckId);
      return ['pickup', 'check-pallet'].includes(ins.kind) ? ins.pallet.sscc : ins.target || null;
    }
    command(op, args, by) {
      const result = Commands.COMMANDS[op](this.wh, args, by);
      if (result && result.ok === false && !(op === 'scan' && args.code === 'CMD-DAMAGED' && this.wh.pallets[this.first].status === 'blocked')) throw new Error(result.text);
      const actor = ['scan', 'deskStart', 'stationScan'].includes(op) ? args.id : by;
      this.journal.push({ op, args, by: actor, title: this.step.title, t: this.time, result: result && result.text });
      return result;
    }
    next() {
      if (!this.step) return;
      const run = (op, args) => this.run(op, args);
      if (this.step.execute) { this.step.execute(this, run); this.index++; return; }
      switch (this.index) {
        case 0: run('applyTemplate', { from: 'AP', to: 'AP', category: 'PRO' }); break;
        case 1: run('addTruck', { id: 'RT-PRO', categories: ['PRO'] }); break;
        case 2: run('addDelivery', { id: 'DEMO-IN', supplier: 'Demo drinks supplier', category: 'PRO', at: 'desk', list: [
          { sscc: this.first, itemNo: 'P3001', batch: 'PRO-EARLY', expiry: '2027-01-06', qty: 72 },
          { sscc: this.second, itemNo: 'P3001', batch: 'PRO-LATER', expiry: '2027-02-05', qty: 72 },
        ] }); break;
        case 3: run('deskStart', { id: 'DESK1', deliveryId: 'DEMO-IN' }); break;
        case 4: case 5: run('scan', { id: 'DESK1', code: `00${this.index === 4 ? this.first : this.second}` }); break;
        case 10: run('addOrder', { id: 'DEMO-OUT', customer: 'Fresh Market', lane: 'OUT-01', lines: [{ itemNo: 'P3001', pallets: 1, process: 'CHANGE' }] }); break;
        case 11:
          run('scan', { id: 'RT-PRO', code: 'CMD-DAMAGED' });
          run('scan', { id: 'RT-PRO', code: 'CMD-DAMAGED' });
          break;
        case 14: run('stationScan', { id: 'PRESS', code: this.second }); break;
        case 15:
          this.time += 5 * 60000;
          run('stationScan', { id: 'PRESS', code: this.second });
          break;
        case 20: run('shipOrder', { id: 'DEMO-OUT' }); break;
        case 21: this.trace = this.wh.trace('PRO-LATER'); break;
        default: this.scanExpected();
      }
      this.index++;
    }
  }
  return { Walkthrough, steps, scenarios };
});
