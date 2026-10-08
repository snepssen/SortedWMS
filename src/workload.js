/*
 * Random workload for free play: a coordinator drops in hundreds of picks and
 * hundreds of pallets to receive, and watches the system organise them.
 * Nothing is pre-placed: items, quantities, customers, lanes and delivery
 * sizes come from a seeded random draw over what the warehouse holds and has
 * room for. The same seed on the same state gives the same work, so the
 * journal can replay it.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./gs1'));
  else root.SortedWorkload = factory(root.GS1);
})(typeof self !== 'undefined' ? self : this, function (GS1) {
  'use strict';

  const DAY = 86400000;
  const CUSTOMERS = ['Fresh Market', 'City Deli', 'Corner Shop', 'Daily Fresh', 'Super Plus', 'Green Grocer', 'Hotel Central', 'School Kitchen', 'Farm Shop', 'Station Kiosk'];
  const SUPPLIERS = { YOG: ['Valley Dairy', 'A-ware Packaging', 'Hill Farm Yoghurt'], CHE: ['A-ware Kruibeke', 'Coast Cheese', 'Old Mill Cheese'], PRO: ['Drinks supplier', 'Sport Drinks Co'] };
  const MAX = 1000;

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /**
   * Plan the work without changing anything: orders over the stock that is
   * free to ship, deliveries into the rack space each category has left.
   */
  function plan(wh, { seed = 1, picks = 0, inbound = 0 } = {}) {
    picks = Math.max(0, Math.min(MAX, Math.floor(Number(picks) || 0)));
    inbound = Math.max(0, Math.min(MAX, Math.floor(Number(inbound) || 0)));
    const rng = mulberry32(Number(seed) || 1);
    const between = (a, b) => a + Math.floor(rng() * (b - a + 1));
    const pick = (arr) => arr[Math.floor(rng() * arr.length)];
    const now = wh.now();
    const lanes = Object.values(wh.locations).filter((l) => l.kind === 'lane' && l.role === 'out').map((l) => l.code);

    // Orders: 1 to 3 lines of 1 to 4 pallets, drawn from what can ship right now.
    const free = {};
    for (const p of Object.values(wh.pallets)) {
      if (!p.loc || p.orderId || p.proc || wh.shipState(p) !== 'ok' || wh._liveTaskFor(p.sscc)) continue;
      const loc = wh.locations[p.loc];
      if (!loc || (loc.kind !== 'rack' && loc.kind !== 'block')) continue;
      free[p.itemNo] = (free[p.itemNo] || 0) + 1;
    }
    let nextId = Math.max(6000, ...Object.keys(wh.orders).map(Number).filter(Number.isFinite)) + 1;
    const orders = [];
    let toPlace = picks;
    while (toPlace > 0) {
      const items = Object.keys(free).filter((i) => free[i] > 0);
      if (!items.length || !lanes.length) break;
      const lines = [];
      for (let n = between(1, 3); n > 0 && toPlace > 0; n--) {
        const choices = items.filter((i) => free[i] > 0 && !lines.some((l) => l.itemNo === i));
        if (!choices.length) break;
        const itemNo = pick(choices);
        const pallets = Math.min(between(1, 4), free[itemNo], toPlace);
        free[itemNo] -= pallets;
        toPlace -= pallets;
        lines.push({ itemNo, pallets });
      }
      if (!lines.length) break;
      orders.push({ id: String(nextId++), customer: pick(CUSTOMERS), lane: pick(lanes), lines });
    }

    // Deliveries: a truck of 10 to 26 pallets of one category, with the supplier's pallet list.
    const room = {};
    for (const l of Object.values(wh.locations)) if (l.kind === 'rack' && l.category && !l.sscc && !l.reservedBy && !l.blocked && !l.quarantine) room[l.category] = (room[l.category] || 0) + 1;
    for (const d of Object.values(wh.deliveries)) if (d.status === 'open') room[d.category] = (room[d.category] || 0) - (d.expected - d.received.length);
    const rackItems = Object.values(wh.items).filter((i) => i.storage !== 'block');
    const taken = new Set(Object.keys(wh.pallets));
    for (const d of Object.values(wh.deliveries)) for (const s of Object.keys(d.list || {})) taken.add(s);
    let serial = Math.floor(rng() * 900000);
    const newSscc = () => {
      let s;
      do { s = GS1.makeSscc(4, '8799998', ++serial); } while (taken.has(s));
      taken.add(s);
      return s;
    };
    let delSeq = Object.keys(wh.deliveries).length + 1;
    const deliveries = [];
    let toReceive = inbound;
    while (toReceive > 0) {
      const cats = Object.keys(room).filter((c) => room[c] > 0 && rackItems.some((i) => i.category === c));
      if (!cats.length) break;
      const category = pick(cats);
      const size = Math.min(between(10, 26), toReceive, room[category]);
      room[category] -= size;
      toReceive -= size;
      const items = rackItems.filter((i) => i.category === category);
      const mix = [pick(items), pick(items)];
      const list = [];
      for (let i = 0; i < size; i++) {
        const item = mix[i % 2 && rng() < 0.5 ? 1 : 0];
        const expiry = new Date(now + (item.minShipDays + 20 + (item.itemNo.charCodeAt(item.itemNo.length - 1) % 30)) * DAY).toISOString().slice(0, 10);
        list.push({ sscc: newSscc(), itemNo: item.itemNo, batch: `R${expiry.slice(2, 4)}${expiry.slice(5, 7)}${expiry.slice(8, 10)}${item.itemNo.slice(-2)}`, expiry, qty: item.palletQty });
      }
      let id;
      do { id = `IN-${String(delSeq++).padStart(4, '0')}`; } while (wh.deliveries[id]);
      deliveries.push({ id, supplier: pick(SUPPLIERS[category] || ['Supplier']), category, pallets: size, list, at: 'dock' });
    }
    return { orders, deliveries, picks: picks - toPlace, short: toPlace, inbound: inbound - toReceive, noRoom: toReceive };
  }

  /** Put the planned work in: orders first (they ship from stock), then the deliveries. */
  function drop(wh, opts) {
    const p = plan(wh, opts);
    for (const o of p.orders) wh.addOrder(o);
    for (const d of p.deliveries) wh.addDelivery(d);
    const bits = [];
    if (p.orders.length) bits.push(`${p.orders.length} orders, ${p.picks} pallets to pick`);
    if (p.deliveries.length) bits.push(`${p.deliveries.length} deliveries, ${p.inbound} pallets to receive`);
    if (p.short) bits.push(`${p.short} picks left out: not enough stock free to ship`);
    if (p.noRoom) bits.push(`${p.noRoom} inbound pallets left out: no rack space`);
    wh.log(`Workload dropped in: ${bits.join('; ') || 'nothing'}`);
    return { orders: p.orders.length, picks: p.picks, deliveries: p.deliveries.length, inbound: p.inbound, short: p.short, noRoom: p.noRoom, text: bits.join('. ') || 'Nothing to add' };
  }

  return { plan, drop, MAX };
});
