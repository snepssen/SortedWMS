/*
 * Demo stock for trying the server without real data: `npm run start:demo`.
 * Everything goes in through ordinary commands, so it lands in the journal
 * like any other change. Only runs on an empty warehouse.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('../src/gs1'), require('../src/engine'));
  else root.SortedSeed = factory(root.GS1, root.SortedWMS);
})(typeof self !== 'undefined' ? self : this, function (GS1, Engine) {
  'use strict';
  const { Warehouse } = Engine;

  const DAY = 86400000;

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function seedDemo(store, { seed = 20261008 } = {}) {
    const rng = mulberry32(seed);
    const between = (a, b) => a + Math.floor(rng() * (b - a + 1));
    const pick = (arr) => arr[Math.floor(rng() * arr.length)];
    const now = store.now();
    const day = (n) => new Date(now + n * DAY).toISOString().slice(0, 10);
    const batchCode = (itemNo, expiry) => `L${expiry.slice(2, 4)}${expiry.slice(5, 7)}${itemNo.slice(-2)}${String.fromCharCode(65 + between(0, 5))}`;
    let serial = 1000;
    const sscc = () => GS1.makeSscc(0, '8712345', ++serial);

    // Work out the rows on a scratch copy, so block-lane spots come out the way importStock will stack them.
    const scratch = Warehouse.restore(JSON.parse(JSON.stringify(store.wh)), { clock: () => now });
    const rows = [];
    const put = (code, row) => { scratch.stockPallet(code, row); rows.push({ code, ...row }); };
    for (const item of Object.values(scratch.items)) {
      if (item.category === 'PRO') continue; // protein drinks: first delivery still to come
      if (item.storage === 'block') {
        const lanes = scratch.layout.blocks;
        const lane = lanes.find((l) => !scratch.laneBatches(l).length);
        if (!lane) continue;
        const expiry = day(item.minShipDays + between(10, 40));
        const batch = batchCode(item.itemNo, expiry);
        for (let i = 0; i < between(12, 30); i++) {
          const spot = scratch.nextBlockSpot(lane);
          if (!spot) break;
          put(spot, { sscc: sscc(), itemNo: item.itemNo, batch, expiry, receivedAt: now - between(2, 12) * DAY });
        }
        continue;
      }
      const free = Object.values(scratch.locations).filter((l) => l.kind === 'rack' && l.category === item.category && !l.sscc);
      let cursor = between(0, Math.max(0, free.length - 60));
      for (let b = 0; b < between(3, 5); b++) {
        const expiry = day(item.minShipDays + between(3, 10) + b * 14);
        const batch = batchCode(item.itemNo, expiry);
        for (let i = 0; i < between(4, 9); i++) {
          let loc = free[cursor++];
          if (rng() < 0.15) loc = pick(free); // the odd pallet put away somewhere else
          if (!loc || loc.sscc) continue;
          put(loc.code, { sscc: sscc(), itemNo: item.itemNo, batch, expiry, receivedAt: now - between(2, 20) * DAY });
        }
      }
    }
    const stock = store.exec('importStock', { rows }, 'seed');

    // Handhelds: two yoghurt, two cheese, all on Auto.
    for (const [id, categories] of [['HH01', ['YOG']], ['HH02', ['YOG']], ['HH03', ['CHE']], ['HH04', ['CHE']]]) {
      store.exec('addTruck', { id, categories }, 'seed');
    }

    // Two orders, and a delivery announced with its pallet list (one scan per pallet at the dock).
    const items = store.wh.stockSummary().filter((r) => r.available >= 2);
    store.exec('addOrder', { id: '4501', customer: 'Fresh Market', lane: 'OUT-01', lines: [{ itemNo: items[0].item.itemNo, pallets: 2 }] }, 'seed');
    store.exec('addOrder', { id: '4502', customer: 'City Deli', lane: 'OUT-02', lines: [{ itemNo: items[items.length - 1].item.itemNo, pallets: 1 }] }, 'seed');
    const pro = Object.values(store.wh.items).find((i) => i.category === 'PRO');
    const list = [];
    if (pro) {
      const expiry = day(240);
      for (let i = 0; i < 3; i++) list.push({ sscc: GS1.makeSscc(3, '8799999', 5000 + i), itemNo: pro.itemNo, batch: batchCode(pro.itemNo, expiry), expiry, qty: pro.palletQty });
      store.exec('addDelivery', { id: 'D-2041', supplier: 'Drinks supplier', category: 'PRO', pallets: list.length, list }, 'seed');
    }
    return [
      `Demo stock: ${stock.added} pallets${stock.errors.length ? ` (${stock.errors.length} skipped)` : ''}, handhelds HH01–HH04, orders 4501 and 4502.`,
      list.length ? `Delivery D-2041 (protein drinks) is announced with its list. Scan these SSCCs at the dock to receive it:\n  ${list.map((p) => `00${p.sscc}`).join('\n  ')}` : '',
    ].filter(Boolean).join('\n');
  }

  return { seedDemo };
});
