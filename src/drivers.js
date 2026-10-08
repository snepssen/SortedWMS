/*
 * Simulated drivers for free play: what a reach-truck driver on Auto would scan
 * next, and roughly how long it takes to get there at real speed. The free-play
 * page sends the scan through the same API as a real handheld, so every move
 * lands in the journal and on every screen.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./gs1'));
  else root.SortedDrivers = factory(root.GS1);
})(typeof self !== 'undefined' ? self : this, function (GS1) {
  'use strict';

  const SEC = 1000;
  const PER_BAY = 4 * SEC; // driving, per bay of travel
  const PER_LEVEL = 7 * SEC; // reach up and down, per level

  function lift(wh, code) {
    const loc = wh.locations[code];
    return loc && loc.kind === 'rack' ? (Number(loc.level) || 0) * PER_LEVEL : 0;
  }

  function drive(wh, from, to) {
    if (!from || !to || !wh.locations[to]) return 20 * SEC;
    try { return wh.travel(from, to) * PER_BAY; } catch (e) { return 30 * SEC; }
  }

  /**
   * The next scan for this handheld: { code, ms, what } with ms the time from
   * now until it happens, { qty, ms } for the one receiving tap, or null when
   * there is nothing a driver on Auto would do (idle, waiting at an aisle, a
   * manual mode, labels that need typing).
   */
  function next(wh, id, rand = Math.random) {
    const truck = wh.trucks[id];
    if (!truck || truck.mode === 'paused') return null;
    const ins = wh.instruction(id);
    const jitter = (ms) => Math.round(ms * (0.8 + rand() * 0.4));
    const at = truck.position;
    switch (ins.kind) {
      case 'pickup':
        return { code: ins.pallet.sscc, what: `pick up at ${wh.label(ins.target)}`, ms: jitter(drive(wh, at, ins.target) + lift(wh, ins.target) + 15 * SEC) };
      case 'drop':
        return { code: ins.target, what: `drop at ${wh.label(ins.target)}`, ms: jitter(drive(wh, at, ins.target) + lift(wh, ins.target) + 20 * SEC) };
      case 'check-pallet':
        return { code: ins.pallet.sscc, what: 'check the pallet', ms: jitter(drive(wh, at, ins.task.from) + 20 * SEC) };
      case 'check-label':
        if (!ins.task.labelCode) return null;
        return { code: ins.task.labelCode, what: 'label on, scan it', ms: jitter(25 * SEC) };
      case 'count': {
        const loc = wh.locations[ins.target];
        if (!ins.step) return { code: ins.target, what: `count at ${wh.label(ins.target)}`, ms: jitter(drive(wh, at, ins.target) + 10 * SEC) };
        return { code: loc.sscc || ins.target, what: loc.sscc ? 'scan what is there' : 'empty: location again', ms: jitter(lift(wh, ins.target) / 2 + 8 * SEC) };
      }
      case 'receive': {
        if (ins.field === 'qty') return { qty: true, what: 'confirm the quantity', ms: jitter(5 * SEC) };
        const list = ins.delivery.list;
        if (!list) return labelScan(wh, ins, rand, jitter);
        // With a list one SSCC scan does it all: anything half-filled is a scan gone wrong, so start the pallet again.
        if (['batch', 'expiry', 'item', 'sscc', 'qty'].some((f) => ins.draft && ins.draft[f])) return { code: 'CMD-CANCEL', what: 'start this pallet again', ms: jitter(5 * SEC) };
        const sscc = Object.keys(list).find((s) => !ins.delivery.received.includes(s) && !wh.pallets[s]);
        if (!sscc) return null;
        const first = !ins.delivery.received.length;
        return { code: `00${sscc}`, what: `receive pallet ${ins.delivery.received.length + 1} of ${ins.delivery.expected}`, ms: jitter((first ? 60 : 20) * SEC) };
      }
      default:
        return null;
    }
  }

  /**
   * A delivery announced without a pallet list: the driver scans the pallet's
   * own labels. Made up here as a full GS1 label (item, count, best-before and
   * batch in the top barcode, the SSCC in the bottom one) for an item of the
   * delivery's category.
   */
  function labelScan(wh, ins, rand, jitter) {
    const d = ins.draft || {};
    const first = !ins.delivery.received.length && !d.item && !d.sscc;
    if (!d.item || !d.batch || !d.expiry) {
      const items = Object.values(wh.items).filter((i) => i.category === ins.delivery.category && i.storage !== 'block' && i.gtin);
      if (!items.length) return null;
      const item = d.item ? wh.items[d.item] : items[Math.floor(rand() * items.length)];
      const expiry = new Date(wh.now() + (item.minShipDays + 25) * 86400000).toISOString().slice(0, 10);
      const top = `02${GS1.gtin14(item.gtin)}37${item.palletQty}${GS1.GS}15${GS1.toYymmdd(expiry)}10L${expiry.slice(2, 4)}${expiry.slice(5, 7)}${ins.delivery.id.replace(/\W/g, '').slice(-3)}`;
      return { code: top, what: `receive: top label of pallet ${ins.delivery.received.length + 1}`, ms: jitter((first ? 60 : 20) * SEC) };
    }
    if (!d.sscc) {
      let sscc;
      do { sscc = GS1.makeSscc(5, '8799997', Math.floor(rand() * 9e8)); } while (wh.pallets[sscc]);
      return { code: `00${sscc}`, what: `receive: pallet label ${ins.delivery.received.length + 1}`, ms: jitter(6 * SEC) };
    }
    return null;
  }

  return { next };
});
