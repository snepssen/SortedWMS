/*
 * The demo: a made-up mixed distribution centre worked by bots on the real
 * WMS. Four clients store paint, garden stock, adhesives and power tools in
 * reach-truck racks, block stacks and a wall of bins. Bots stand in for the
 * people on the floor: the office takes in orders and books deliveries, reach
 * trucks receive, put away and pick pallets, a man-up and a bin picker work the
 * pick waves, a packer closes cartons and a loader ships. Each bot only does
 * what the system asks of that role, through the same commands a person's
 * screen sends, so every step lands in the journal and on every screen.
 *
 * A person can take over any role; that bot then waits. Nothing here keeps
 * state of its own: what a bot does next is read from the warehouse, so a
 * reload carries on where it was.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./gs1'), require('./drivers'));
  else root.SortedDemo = factory(root.GS1, root.SortedDrivers);
})(typeof self !== 'undefined' ? self : this, function (GS1, Drivers) {
  'use strict';

  const SEC = 1000;
  const MIN = 60 * SEC;
  const DAY = 86400000;

  // The building: racks for the reach trucks, two block-stack lanes, a dock and four out lanes.
  const SITE = {
    name: 'Demo distribution centre',
    layout: { aisles: [1, 2, 3, 4], bays: 12, levels: 4, positions: [10, 40], outLanes: 4 },
    categories: { GEN: 'General', BULK: 'Bulk', SMALL: 'Small parts' },
    blocks: [{ id: 'BL01', stacks: 6, height: 4, category: 'BULK' }, { id: 'BL02', stacks: 6, height: 4, category: 'BULK' }],
    features: { lotExpiry: true, fefo: true },
    naming: 'row',
    // Aisles AA and AB hold general stock, AC small parts, AD bulk.
    templates: [{ from: 'AA01A1', to: 'AB12D2', category: 'GEN' }, { from: 'AC01A1', to: 'AC12D2', category: 'SMALL' }, { from: 'AD01A1', to: 'AD12D2', category: 'BULK' }],
    config: { aisleCap: 2 },
    desks: [{ id: 'DESK1', name: 'Receiving desk' }],
  };

  const CLIENTS = [
    { id: 'CL-PAINT', name: 'Brightwall Paints', contact: 'Planning', email: 'orders@paints.example' },
    { id: 'CL-GARDEN', name: 'Fieldstone Garden', contact: 'Planning', email: 'orders@garden.example' },
    { id: 'CL-FIX', name: 'Fixwell Adhesives', contact: 'Customer service', email: 'orders@fixwell.example' },
    { id: 'CL-VOLT', name: 'Voltline Tools', contact: 'Logistics', email: 'orders@voltline.example' },
  ];

  // [itemNo, name, category, client, pallet qty, storage, best-before days, min days left to ship, packs, kg each]
  // order: 'pallets' ships whole pallets, 'units' ships pieces from the pick waves.
  const ITEMS = [
    ['W1001', 'Wall paint white 10 L', 'GEN', 'CL-PAINT', 60, 'rack', 540, 60, [{ unit: 'case', per: 4 }], 11, 'pallets'],
    ['W1002', 'Wall paint grey 10 L', 'GEN', 'CL-PAINT', 60, 'rack', 540, 60, [{ unit: 'case', per: 4 }], 11, 'pallets'],
    ['W1003', 'Primer 5 L', 'GEN', 'CL-PAINT', 96, 'rack', 400, 60, [{ unit: 'case', per: 4 }], 5.5, 'pallets'],
    ['G2001', 'Potting soil 40 L', 'BULK', 'CL-GARDEN', 60, 'rack', 365, 30, [], 14, 'pallets'],
    ['G2002', 'Bark mulch 50 L', 'BULK', 'CL-GARDEN', 50, 'rack', 365, 30, [], 12, 'pallets'],
    ['G2005', 'Paving slabs, crate', 'BULK', 'CL-GARDEN', 24, 'block', 3650, 0, [], 25, 'pallets'],
    ['F3001', 'Wood glue 750 ml', 'SMALL', 'CL-FIX', 480, 'rack', 360, 90, [{ unit: 'box', per: 12 }], 0.85, 'units'],
    ['F3002', 'Sealant cartridge 310 ml', 'SMALL', 'CL-FIX', 960, 'rack', 270, 90, [{ unit: 'box', per: 24 }], 0.4, 'units'],
    ['F3003', 'Tile grout 5 kg', 'SMALL', 'CL-FIX', 120, 'rack', 300, 60, [{ unit: 'box', per: 4 }], 5, 'units'],
    ['T4001', 'Cordless drill 18 V', 'GEN', 'CL-VOLT', 40, 'rack', 0, 0, [{ unit: 'case', per: 4 }], 2.1, 'pallets', true],
    ['T4002', 'Drill bit set, 10 pieces', 'SMALL', 'CL-VOLT', 600, 'rack', 0, 0, [{ unit: 'box', per: 10 }], 0.3, 'units'],
  ].map(([itemNo, name, category, clientId, palletQty, storage, life, minShipDays, packs, kg, sells, serialized], i) => ({
    itemNo, name, category, clientId, palletQty, storage, life, minShipDays, packs, kg, sells, serialized: Boolean(serialized),
    gtin: GS1.makeGtin13('614141', 10 + i),
  }));
  const ITEM = Object.fromEntries(ITEMS.map((i) => [i.itemNo, i]));

  // Made-up names only.
  const CUSTOMERS = ['Harbour Hardware', 'Main Street DIY', 'Corner Builders', 'Hillside Hotel', 'Riverside School', 'Northgate Garage', 'Old Town Florist', 'Bayview Homes', 'Site Office North', 'Greenway Nursery'];
  const SUPPLIERS = { 'CL-PAINT': 'Brightwall factory', 'CL-GARDEN': 'Fieldstone yard', 'CL-FIX': 'Fixwell plant', 'CL-VOLT': 'Voltline import' };
  const LANES = ['OUT-01', 'OUT-02', 'OUT-03', 'OUT-04'];
  const DESK_CLIENTS = ['CL-FIX'];
  const RETURN_REASONS = ['Ordered too many', 'Damaged in transit', 'Wrong item sent', 'Ordered too many'];
  const PACK = 'PACK';

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** Six in the morning, local time, on the day of `t`: when the demo shift starts. */
  function morning(t) {
    const d = new Date(t);
    d.setHours(6, 0, 0, 0);
    return d.getTime();
  }

  const isoDay = (t) => new Date(t).toISOString().slice(0, 10);
  const lotFor = (itemNo, expiry, n) => `L${expiry ? expiry.slice(2, 4) + expiry.slice(5, 7) : '00'}${itemNo.slice(-2)}${String.fromCharCode(65 + (n % 26))}`;
  const serialsFor = (itemNo, sscc, qty) => Array.from({ length: qty }, (_, i) => `${itemNo}-${sscc.slice(-7, -1)}${String(i + 1).padStart(2, '0')}`);

  /**
   * Fill the empty building, through ordinary commands: clients, items one by
   * one, bins, the packing bench, stock, trucks, rate cards and the first orders.
   * `x(op, args)` runs one command; `wh()` is the warehouse as it is now.
   */
  function seed(x, now, wh) {
    const rng = mulberry32(20261102);
    const between = (a, b) => a + Math.floor(rng() * (b - a + 1));
    for (const c of CLIENTS) x('addClient', c);
    for (const it of ITEMS) {
      x('addItem', { itemNo: it.itemNo, name: it.name, category: it.category, clientId: it.clientId, palletQty: it.palletQty, storage: it.storage, gtin: it.gtin, minShipDays: it.minShipDays, bestBefore: Boolean(it.life), uom: it.storage === 'block' ? 'crate' : 'piece' });
      x('setItemUnits', { itemNo: it.itemNo, packs: it.packs, unitWeightKg: it.kg });
      if (it.serialized) x('setItemSerials', { itemNo: it.itemNo, on: true });
    }
    // The bin wall for small picks: 4 shelves, 6 bins wide, 3 high.
    x('generateGuided', { answers: { sections: { count: 1, name: 'Pick' }, layouts: [{ type: 'shelf', aisles: { count: 1 }, bays: { count: 4, name: 'Shelf 1' }, positions: { count: 6, name: 'Bin 1' }, levels: { count: 3, name: 'Low, Mid, High' } }] } });
    x('createLocation', { code: PACK, kind: 'virtual', role: 'staging', name: 'Packing bench' });
    x('setWaveConfig', { config: { postPick: PACK, maxWaitMin: 30, maxOrders: 6 } });

    // Stock: three to five batches of every rack item, oldest batch first to expire.
    let n = 0;
    const sscc = () => GS1.makeSscc(0, '0614141', 100000 + ++n);
    const rows = [];
    const used = new Set();
    for (const it of ITEMS.filter((i) => i.storage === 'rack')) {
      const free = Object.values(wh().locations).filter((l) => l.kind === 'rack' && l.category === it.category && !l.sscc && !used.has(l.code)).map((l) => l.code);
      const batches = between(3, 4);
      for (let b = 0; b < batches; b++) {
        const expiry = it.life ? isoDay(now + (it.minShipDays + 20 + b * 35 + between(0, 10)) * DAY) : null;
        for (let p = between(2, 4); p > 0; p--) {
          const code = free.splice(between(0, Math.min(free.length - 1, 12)), 1)[0];
          if (!code) break;
          used.add(code);
          rows.push({ code, sscc: sscc(), itemNo: it.itemNo, qty: it.palletQty, batch: it.life || it.serialized ? lotFor(it.itemNo, expiry, b) : null, expiry, receivedAt: now - between(3, 40) * DAY });
        }
      }
    }
    x('importStock', { rows });
    for (const r of rows) if (ITEM[r.itemNo].serialized) x('palletSerials', { sscc: r.sscc, serials: serialsFor(r.itemNo, r.sscc, r.qty) });
    // Paving slabs: one block lane, stacked from the back.
    const slabs = ITEM.G2005;
    for (let p = 0; p < 14; p++) x('importStock', { rows: [{ code: wh().nextBlockSpot('BL01'), sscc: sscc(), itemNo: slabs.itemNo, qty: slabs.palletQty, batch: 'SLAB-2611', expiry: isoDay(now + slabs.life * DAY), receivedAt: now - 20 * DAY }] });

    // Bins: what the small picks take from first.
    const bins = Object.values(wh().locations).filter((l) => l.kind === 'bin').map((l) => l.code).sort();
    const loose = [['F3001', 24], ['F3002', 48], ['F3003', 4], ['T4002', 40], ['F3001', 24], ['F3002', 48], ['T4002', 30], ['F3003', 4]];
    // One bin of grout close to its best-before: too short to ship, waiting for someone to write it off.
    x('binPut', { loc: bins[30], itemNo: 'F3003', qty: 2, batch: lotFor('F3003', isoDay(now + 9 * DAY), 25), expiry: isoDay(now + 9 * DAY) });
    loose.forEach(([itemNo, qty], i) => {
      const it = ITEM[itemNo];
      const expiry = it.life ? isoDay(now + (it.minShipDays + 15 + i * 9) * DAY) : null;
      x('binPut', { loc: bins[i * 2], itemNo, qty, batch: it.life ? lotFor(itemNo, expiry, 20 + i) : null, expiry });
    });

    // The floor: three reach trucks (two for general and small parts, one for bulk), a man-up, the bin cart.
    for (const [id, categories, equipment] of [['R1', ['GEN', 'SMALL'], 'reach'], ['R2', ['GEN', 'SMALL'], 'reach'], ['R3', ['BULK'], 'reach'], ['MU1', ['SMALL'], 'manup']]) {
      x('addTruck', { id, categories });
      x('setTruckEquipment', { id, equipment });
    }
    const tariff = { storageBasis: 'pallet-day', storageRate: 0.45, inboundBasis: 'pallet', inboundRate: 3.5, outboundBasis: 'line', outboundRate: 0.9, valRate: 0, monthlyMinimum: 150 };
    for (const c of CLIENTS) x('setTariff', { clientId: c.id, tariff });

    // A first order for each kind of work, so the floor starts moving at once.
    x('addOrder', newOrder(wh(), 0, now));
    x('addOrder', newOrder(wh(), 1, now));
    x('addOrder', newOrder(wh(), 2, now));
    // Fixwell's supplier is at the dock already, without a pallet list: the receiving desk takes it.
    const glue = newDelivery(wh(), 0, ITEM.F3001, now);
    if (glue) x('addDelivery', { ...glue, pallets: Math.min(glue.pallets, 4) });
    return `${rows.length + 14} pallets in stock for ${CLIENTS.length} clients, ${ITEMS.length} items, ${bins.length} bins`;
  }

  // ---- What the floor can do right now ----

  /** Pallets of an item that a pallet order can still take. */
  function freePallets(wh, itemNo) {
    let n = 0;
    for (const p of wh._livePallets()) {
      if (p.itemNo !== itemNo || !p.loc || p.orderId || p.proc || wh._liveTaskFor(p.sscc)) continue;
      const loc = wh.locations[p.loc];
      if (!loc || (loc.kind !== 'rack' && loc.kind !== 'block')) continue;
      if (wh.shipState(p) !== 'ok') continue;
      n++;
    }
    return n;
  }

  /** Units of an item still free for piece orders: bins plus rack pallets, less what open orders want. */
  function freeUnits(wh, itemNo) {
    let n = 0;
    for (const p of wh._livePallets()) if (p.itemNo === itemNo && p.loc && !p.orderId && wh.locations[p.loc] && wh.locations[p.loc].kind === 'rack') n += p.qty;
    for (const r of Object.values(wh.binStock || {})) if (r.itemNo === itemNo) n += r.qty;
    for (const o of wh._liveOrders()) for (const l of o.lines) if (l.kind === 'each' && l.itemNo === itemNo) n -= l.units - (l.picked || 0);
    return n;
  }

  /**
   * Order number `k` of the demo: the same every time for the same k, so the
   * office bot needs no memory. Even numbers ship whole pallets, odd ones
   * pieces for the pick waves. Another `variant` draws another order, for
   * when the first one finds nothing in stock.
   */
  function newOrder(wh, k, now, variant = 0) {
    const rng = mulberry32(7919 * (k + 1) + 104729 * variant);
    const between = (a, b) => a + Math.floor(rng() * (b - a + 1));
    const pick = (arr) => arr[Math.floor(rng() * arr.length)];
    const sells = k % 2 ? 'units' : 'pallets';
    const clients = [...new Set(ITEMS.filter((i) => i.sells === sells).map((i) => i.clientId))];
    const clientId = pick(clients);
    const items = ITEMS.filter((i) => i.sells === sells && i.clientId === clientId);
    const lines = [];
    for (let l = between(1, Math.min(3, items.length)); l > 0; l--) {
      const it = items.splice(Math.floor(rng() * items.length), 1)[0];
      if (sells === 'pallets') {
        const want = Math.min(between(1, 3), freePallets(wh, it.itemNo));
        if (want > 0) lines.push({ itemNo: it.itemNo, pallets: want });
      } else {
        const per = it.packs[0] ? it.packs[0].per : 1;
        const want = Math.min(rng() < 0.4 ? per * between(1, 3) : between(2, Math.max(3, Math.floor(per * 1.5))), freeUnits(wh, it.itemNo));
        if (want > 0) lines.push({ itemNo: it.itemNo, units: want });
      }
    }
    const day = new Date(now);
    const id = `${String(day.getMonth() + 1).padStart(2, '0')}${String(day.getDate()).padStart(2, '0')}-${String(k + 1).padStart(3, '0')}`;
    return { id: `SO-${id}`, customer: pick(CUSTOMERS), lane: pick(LANES), clientId, lines };
  }

  /**
   * A delivery for one client's category, with the supplier's pallet list (and
   * serials for traced items). Fixwell's supplier sends no list, and its labels
   * carry no batch or best-before barcode: those go to the receiving desk.
   */
  function newDelivery(wh, k, it, now) {
    const rng = mulberry32(104729 * (k + 1));
    const between = (a, b) => a + Math.floor(rng() * (b - a + 1));
    const room = Object.values(wh.locations).filter((l) => l.kind === 'rack' && l.category === it.category && !l.sscc && !l.reservedBy && !l.blocked).length;
    const size = Math.min(between(6, 12), room - 4);
    if (size < 2) return null;
    const mates = ITEMS.filter((i) => i.clientId === it.clientId && i.category === it.category && i.storage === 'rack' && i.itemNo !== it.itemNo);
    const taken = new Set(Object.keys(wh.pallets));
    for (const d of Object.values(wh.deliveries)) for (const s of Object.keys(d.list || {})) taken.add(s);
    let serial = 200000 + k * 100;
    const list = [];
    for (let i = 0; i < size; i++) {
      const item = i % 3 === 2 && mates.length ? mates[i % mates.length] : it;
      const expiry = item.life ? isoDay(now + (item.life - between(10, 40)) * DAY) : null;
      let sscc;
      do sscc = GS1.makeSscc(1, '0614141', ++serial); while (taken.has(sscc));
      const row = { sscc, itemNo: item.itemNo, qty: item.palletQty, batch: lotFor(item.itemNo, expiry, k), expiry };
      if (item.serialized) row.serials = serialsFor(item.itemNo, sscc, item.palletQty);
      list.push(row);
    }
    const id = `IN-${String(k + 1).padStart(4, '0')}`;
    if (DESK_CLIENTS.includes(it.clientId)) return { id, supplier: SUPPLIERS[it.clientId], category: it.category, clientId: it.clientId, pallets: list.length, list: null, at: 'desk' };
    return { id, supplier: SUPPLIERS[it.clientId], category: it.category, clientId: it.clientId, pallets: list.length, list, at: 'dock' };
  }

  /** Pallet `i` of a delivery that came without a list: what is physically on the dock. */
  function deskPallet(delivery, i) {
    const seed = [...delivery.id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7) + i * 7919;
    const rng = mulberry32(seed);
    const items = ITEMS.filter((x) => x.clientId === delivery.clientId && x.category === delivery.category && x.storage === 'rack');
    const item = items[i % 3 === 2 ? 1 % items.length : 0];
    const expiry = item.life ? isoDay(delivery.createdAt + (item.life - 10 - Math.floor(rng() * 30)) * DAY) : null;
    const sscc = GS1.makeSscc(2, '0614141', 300000 + (Math.abs(seed) % 600000));
    return { sscc, item, qty: item.palletQty, batch: lotFor(item.itemNo, expiry, Number(delivery.id.slice(-2)) || 0), expiry };
  }

  // ---- The bots ----
  // Each returns the next thing that role would do: { op, args, ms, what, key? }
  // with ms the time it takes in the warehouse, or null when there is nothing.

  const jitter = (rand, ms) => Math.round(ms * (0.75 + rand() * 0.5));

  const office = {
    id: 'office', name: 'Office', screen: 'app.html#orders', card: 'officeCard',
    next(wh, now, rand) {
      // New orders keep coming, one every 4 to 12 minutes.
      const orders = Object.values(wh.orders);
      const last = orders.reduce((t, o) => Math.max(t, o.createdAt || 0), 0);
      const k = orders.length;
      const gap = (4 + Math.floor(mulberry32(31 * (k + 1))() * 9)) * MIN;
      // A delivery for whatever runs low, one open delivery per client at a time.
      const open = Object.values(wh.deliveries).filter((d) => d.status === 'open');
      for (const it of ITEMS) {
        if (it.storage !== 'rack' || open.some((d) => d.clientId === it.clientId)) continue;
        // Pallet items: fewer than 3 free pallets. Piece items: less than a pallet's worth.
        const low = it.sells === 'pallets' ? freePallets(wh, it.itemNo) < 3 : freeUnits(wh, it.itemNo) < it.palletQty;
        if (!low) continue;
        const d = newDelivery(wh, Object.keys(wh.deliveries).length, it, now);
        if (d) return { op: 'addDelivery', args: d, ms: 2 * MIN, what: `book delivery ${d.id} from ${d.supplier}: ${d.pallets} pallets`, key: `delivery:${d.id}` };
      }
      if (now < last + gap) return { wait: true, what: 'waiting for the next order', ms: last + gap - now, key: `wait:${k}` };
      let order = null;
      for (let v = 0; v < 8 && !(order && order.lines.length); v++) order = newOrder(wh, k, now, v);
      if (!order.lines.length) return { wait: true, what: 'nothing in stock to sell: waiting for a delivery', ms: 10 * MIN, key: `empty:${k}` };
      return { op: 'addOrder', args: order, ms: 30 * SEC, what: `take in order ${order.id} for ${order.customer}`, key: `order:${order.id}` };
    },
  };

  /** A reach truck on Auto: whatever the handheld asks for next. */
  function truck(id, name) {
    return {
      id, name, screen: `handheld.html?device=${id}`, card: 'truckCard',
      next(wh, now, rand) {
        const act = Drivers.next(wh, id, rand);
        if (!act) return null;
        const key = `${wh.trucks[id].taskId}:${act.what}`;
        if (act.qty) return { op: 'confirmQty', args: { id, qty: null }, ms: act.ms, what: act.what, key };
        return { op: 'scan', args: { id, code: act.code }, ms: act.ms, what: act.what, key };
      },
    };
  }

  /** A picker for one kind of wave task: claim the nearest, walk there, scan and confirm. */
  function picker(id, name, kinds, screen) {
    return {
      id, name, screen, card: 'pickCard',
      next(wh, now, rand) {
        const tasks = wh.waveTasks({ for: id }).filter((t) => kinds.includes(t.kind) && !t.serialized);
        const t = tasks[0];
        if (!t) return null;
        if (t.claimedBy !== id) return { op: 'claimWaveTask', args: { task: t.id }, ms: jitter(rand, 10 * SEC), what: `take task ${t.id}`, key: `claim:${t.id}` };
        const walk = t.kind === 'bin' ? 40 * SEC : 90 * SEC;
        // Now and then a bin holds less than the system thinks: report it, and stock control counts it.
        if (t.kind === 'bin' && t.qty >= 2 && shortAt(t.id)) {
          const found = t.qty - 1 - (shortAt(t.id) % 2);
          return { op: 'shortWaveTask', args: { task: t.id, found }, ms: jitter(rand, walk), what: `report a short pick: only ${found} of ${t.qty} × ${t.itemNo} at ${wh.label(t.loc)}`, key: `short:${t.id}` };
        }
        return { op: 'confirmWaveTask', args: { task: t.id, scan: t.sscc || t.loc }, ms: jitter(rand, walk + 5 * SEC * Math.min(t.qty, 12)), what: `pick ${t.qty} × ${t.itemNo} at ${wh.label(t.loc)}`, key: `pick:${t.id}` };
      },
    };
  }

  /** About one bin pick in five comes up short: the same picks every time. */
  function shortAt(taskId) {
    const h = [...String(taskId)].reduce((a, c) => (a * 33 + c.charCodeAt(0)) >>> 0, 5381);
    return h % 5 === 1 ? 1 + (h % 2) : 0;
  }

  const cartonsOf = (wh, orderId) => Object.values(wh.holders || {}).filter((h) => h.orderId === orderId && h.series === 'OUT' && h.cartonStatus);
  const pieceOnly = (o) => o.lines.length && o.lines.every((l) => l.kind === 'each' && !(l.wholePallets || []).length);

  /** The packing bench: picked pieces into a carton, closed with its size and weight. */
  const packer = {
    id: 'packer', name: 'Packing bench', screen: 'app.html#pack', card: 'packCard',
    next(wh, now, rand) {
      for (const o of wh._liveOrders().sort((a, b) => a.createdAt - b.createdAt)) {
        if (o.status !== 'ready' || !pieceOnly(o)) continue;
        const open = cartonsOf(wh, o.id).find((h) => h.cartonStatus === 'open');
        const left = (o.staged || []).filter((s) => s.qty > 0);
        if (!open) {
          if (!left.length) continue;
          return { op: 'openCarton', args: { orderId: o.id }, ms: jitter(rand, 30 * SEC), what: `open a carton for ${o.id}`, key: `open:${o.id}` };
        }
        if (left.length) {
          const s = left[0];
          return { op: 'packIntoCarton', args: { carton: open.id, code: s.holder, qty: s.qty }, ms: jitter(rand, 10 * SEC + s.qty * 2 * SEC), what: `pack ${s.qty} × ${s.itemNo} into ${open.id}`, key: `pack:${open.id}:${s.holder}:${s.itemNo}:${s.qty}` };
        }
        const kg = open.packed.reduce((sum, p) => sum + p.qty * ((ITEM[p.itemNo] && ITEM[p.itemNo].kg) || 1), 0);
        const size = kg > 15 ? [600, 400, 400] : kg > 5 ? [400, 300, 300] : [300, 200, 150];
        return { op: 'closeCarton', args: { carton: open.id, lengthMm: size[0], widthMm: size[1], heightMm: size[2], weightKg: Math.round((kg + 0.4) * 10) / 10 }, ms: jitter(rand, 45 * SEC), what: `close carton ${open.id}`, key: `close:${open.id}` };
      }
      return null;
    },
  };

  /** The loader: stage what is ready on its lane, scan each pallet and carton onto the truck, dispatch. */
  const loader = {
    id: 'loader', name: 'Loading', screen: 'app.html#ship', card: 'loadCard',
    next(wh, now, rand) {
      for (const o of wh._liveOrders().sort((a, b) => a.createdAt - b.createdAt)) {
        const ship = o.shipment;
        if (ship && ship.status !== 'dispatched') {
          const h = ship.holders.find((x) => !x.loaded);
          if (h) return { op: 'scanShipment', args: { orderId: o.id, code: h.sscc || h.id }, ms: jitter(rand, h.kind === 'pallet' ? 70 * SEC : 20 * SEC), what: `load ${h.kind} ${h.sscc ? `…${h.sscc.slice(-6)}` : h.id} for ${o.id}`, key: `load:${o.id}:${h.id}` };
          return { op: 'dispatchShipment', args: { orderId: o.id }, ms: jitter(rand, 60 * SEC), what: `dispatch ${o.id} to ${o.customer}`, key: `dispatch:${o.id}` };
        }
        const pallets = o.lines.some((l) => l.pallets);
        const ready = pallets ? o.status === 'ready' && o.lines.every((l) => (l.allocated || []).every((s) => wh.pallets[s] && wh.pallets[s].loc === o.lane)) : o.status === 'packed';
        if (ready) return { op: 'stageShipment', args: { orderId: o.id, truck: `Carrier ${o.lane.slice(-1)}` }, ms: jitter(rand, 40 * SEC), what: `stage ${o.id} on ${o.lane}`, key: `stage:${o.id}` };
      }
      return null;
    },
  };

  /** The receiving desk: two people, one scanning, one typing what the labels lack. */
  const desk = {
    id: 'DESK1', name: 'Receiving desk', screen: 'desk.html', card: 'deskCard',
    next(wh, now, rand) {
      const d = wh.desks.DESK1;
      if (!d) return null;
      const task = d.taskId && wh.tasks[d.taskId];
      if (!task) {
        const waiting = wh._liveTasks().find((t) => t.type === 'RECEIVE' && t.status === 'open' && t.deskOnly);
        if (!waiting) return null;
        return { op: 'deskStart', args: { id: 'DESK1', deliveryId: waiting.deliveryId }, ms: jitter(rand, 3 * MIN), what: `take delivery ${waiting.deliveryId} to the desk`, key: `desk:${waiting.deliveryId}` };
      }
      const delivery = wh.deliveries[task.deliveryId];
      const n = delivery.received.length;
      const p = deskPallet(delivery, n);
      const draft = task.draft || {};
      const key = (f) => `${delivery.id}:${n}:${f}`;
      const what = (x) => `pallet ${n + 1} of ${delivery.expected}: ${x}`;
      if (!draft.batch) return { op: 'deskEnter', args: { id: 'DESK1', field: 'batch', value: p.batch }, ms: jitter(rand, 25 * SEC), what: what(`type batch ${p.batch}`), key: key('batch') };
      if (!draft.sscc) return { op: 'scan', args: { id: 'DESK1', code: `00${p.sscc}` }, ms: jitter(rand, 15 * SEC), what: what('scan the pallet label'), key: key('sscc') };
      if (!draft.item) return { op: 'scan', args: { id: 'DESK1', code: `(02)${GS1.gtin14(p.item.gtin)}(37)${p.qty}` }, ms: jitter(rand, 10 * SEC), what: what('scan the item and count'), key: key('item') };
      if (p.expiry && !draft.expiry) return { op: 'deskEnter', args: { id: 'DESK1', field: 'expiry', value: `${p.expiry.slice(8, 10)}-${p.expiry.slice(5, 7)}-${p.expiry.slice(0, 4)}` }, ms: jitter(rand, 20 * SEC), what: what('type the best-before'), key: key('expiry') };
      if (!draft.qty) return { op: 'deskEnter', args: { id: 'DESK1', field: 'qty', value: String(p.qty) }, ms: jitter(rand, 10 * SEC), what: what('type the quantity'), key: key('qty') };
      return null;
    },
  };

  /** When the demo day began: the first orders go in with the stock. */
  const dayStart = (wh) => Object.values(wh.orders).reduce((t, o) => Math.min(t, o.createdAt || t), Infinity);

  /** What a bin is short of, as found by the picker: "only 3 of 5" in the check's note. */
  function missingFor(check) {
    const m = /only (\d+) of (\d+)/.exec(check.note || '');
    return m ? Number(m[2]) - Number(m[1]) : 0;
  }

  /** Free rack pallets of an item for refilling bins, earliest best-before first. */
  function refillSource(wh, itemNo) {
    const waved = new Set(wh._openWaveTasks().map((t) => t.sscc).filter(Boolean));
    return wh._livePallets()
      .filter((p) => p.itemNo === itemNo && p.loc && wh.locations[p.loc] && wh.locations[p.loc].kind === 'rack' && !wh.locations[p.loc].checkHold
        && !p.orderId && !wh._liveTaskFor(p.sscc) && !waved.has(p.sscc) && wh.shipState(p) === 'ok')
      .sort((a, b) => String(a.expiry || '9999').localeCompare(String(b.expiry || '9999')) || a.qty - b.qty)[0] || null;
  }

  /** A bin with room for `kg` more of this item: one that already holds it, else an empty one. */
  function binFor(wh, item, kg) {
    const bins = Object.values(wh.locations).filter((l) => l.kind === 'bin' && !l.checkHold).sort((a, b) => a.code.localeCompare(b.code));
    const room = (l) => ((l.capacity && l.capacity.maxWeightKg) || 25) - wh._binWeight(l.code);
    const holds = (l) => (wh.binStock[l.code] || []).some((x) => x.itemNo === item.itemNo);
    const empty = (l) => !(wh.binStock[l.code] || []).length;
    return bins.find((l) => holds(l) && room(l) >= kg) || bins.find((l) => empty(l) && room(l) >= kg) || null;
  }

  /** Stock control: clears stock checks, keeps the bins filled from rack pallets, counts a bin now and then. */
  const stock = {
    id: 'S1', name: 'Stock control S1', screen: 'app.html?as=stock#stockctl', card: 'stockCard',
    next(wh, now, rand) {
      // 1. A check: count what is there, put the books right, close it.
      for (const c of wh.openChecks()) {
        const place = wh.locations[c.loc];
        if (place && place.kind === 'bin' && c.itemNo && !(place.lastCount >= c.raisedAt)) {
          const before = (wh.binStock[c.loc] || []).filter((l) => l.itemNo === c.itemNo).reduce((n, l) => n + l.qty, 0);
          const counted = Math.max(0, before - missingFor(c));
          return { op: 'binCount', args: { loc: c.loc, itemNo: c.itemNo, counted, reason: 'recount' }, ms: jitter(rand, 3 * MIN), what: `count ${c.itemNo} in ${c.loc} for check ${c.id}`, key: `count:${c.id}` };
        }
        const corrected = place && place.kind === 'bin' && missingFor(c) > 0;
        return { op: 'closeCheck', args: { id: c.id, outcome: corrected ? 'corrected' : 'ok', note: corrected ? `Bin was ${missingFor(c)} short; count corrected` : 'Counted, stock is right' }, ms: jitter(rand, 40 * SEC), what: `close check ${c.id}`, key: `close:${c.id}` };
      }
      // 2. Bins running low: boxes off a rack pallet into a bin.
      for (const item of ITEMS.filter((i) => i.sells === 'units' && !i.serialized)) {
        const per = item.packs[0] ? item.packs[0].per : 1;
        const inBins = Object.values(wh.binStock || {}).reduce((n, lines) => n + lines.filter((l) => l.itemNo === item.itemNo).reduce((m, l) => m + l.qty, 0), 0);
        if (inBins >= 2 * per) continue;
        const source = refillSource(wh, item.itemNo);
        if (!source) continue;
        const boxes = Math.min(3, Math.floor(source.qty / per), Math.max(1, Math.floor(20 / (per * item.kg))));
        if (boxes < 1) continue;
        const qty = boxes * per;
        const bin = binFor(wh, item, qty * item.kg + 0.01);
        if (!bin) continue;
        return { op: 'binRefill', args: { loc: bin.code, sscc: source.sscc, qty }, ms: jitter(rand, 4 * MIN), what: `refill ${bin.code} with ${boxes} box${boxes === 1 ? '' : 'es'} of ${item.itemNo} from ${wh.label(source.loc)}`, key: `refill:${item.itemNo}:${source.sscc}:${bin.code}` };
      }
      // 3. A cycle count every 45 minutes: the bin counted longest ago.
      const stocked = Object.keys(wh.binStock || {}).filter((code) => (wh.binStock[code] || []).length && !wh.locations[code].checkHold).map((code) => wh.locations[code]);
      const lastAny = stocked.reduce((t, l) => Math.max(t, l.lastCount || 0), 0);
      const due = (lastAny || dayStart(wh)) + 45 * MIN;
      if (!stocked.length) return null;
      if (now < due) return { wait: true, what: 'walking the bins until the next cycle count', ms: due - now, key: `cycle-wait:${lastAny}` };
      const bin = stocked.sort((a, b) => (a.lastCount || 0) - (b.lastCount || 0) || a.code.localeCompare(b.code))[0];
      const line = wh.binStock[bin.code][0];
      const counted = wh.binStock[bin.code].filter((l) => l.itemNo === line.itemNo).reduce((n, l) => n + l.qty, 0);
      return { op: 'binCount', args: { loc: bin.code, itemNo: line.itemNo, counted, reason: 'recount' }, ms: jitter(rand, 3 * MIN), what: `cycle count ${line.itemNo} in ${bin.code}`, key: `cycle:${bin.code}:${lastAny}` };
    },
  };

  /** What went out on an order, per item: the batch and best-before packed, so a restock keeps them. */
  function packedLot(wh, orderId, itemNo) {
    for (const h of Object.values(wh.holders || {})) {
      if (h.orderId !== orderId || !h.packed) continue;
      const row = h.packed.find((p) => p.itemNo === itemNo);
      if (row) return { batch: row.batch || null, expiry: row.expiry || null };
    }
    return { batch: null, expiry: null };
  }

  /** Returns: a customer sends something back now and then; it is booked, then graded. */
  const returns = {
    id: 'returns', name: 'Returns', screen: 'app.html?as=office#returns', card: 'returnsCard',
    next(wh, now, rand) {
      const all = Object.values(wh.returns || {});
      // Grade what waits: damaged goes to scrap, a wrong item on hold, the rest back into a bin.
      for (const rma of all) {
        const line = rma.lines.find((l) => wh._returnLeft(l));
        if (!line) continue;
        const qty = wh._returnLeft(line);
        const item = wh.items[line.itemNo];
        if (/Damaged/.test(rma.reason || '')) return { op: 'gradeReturn', args: { id: rma.id, itemNo: line.itemNo, grade: 'scrap', qty }, ms: jitter(rand, 2 * MIN), what: `scrap ${qty} × ${line.itemNo} from ${rma.id}`, key: `grade:${rma.id}:${line.itemNo}` };
        if (/Wrong/.test(rma.reason || '')) return { op: 'gradeReturn', args: { id: rma.id, itemNo: line.itemNo, grade: 'quarantine', qty }, ms: jitter(rand, 2 * MIN), what: `hold ${qty} × ${line.itemNo} from ${rma.id} for a look`, key: `grade:${rma.id}:${line.itemNo}` };
        const kg = (ITEM[line.itemNo] || { kg: 1 }).kg * qty + 0.01;
        const bin = binFor(wh, item, kg);
        if (!bin) return { op: 'gradeReturn', args: { id: rma.id, itemNo: line.itemNo, grade: 'quarantine', qty }, ms: jitter(rand, 2 * MIN), what: `hold ${qty} × ${line.itemNo} from ${rma.id}: no bin free`, key: `grade:${rma.id}:${line.itemNo}` };
        const lot = packedLot(wh, rma.orderId, line.itemNo);
        return { op: 'gradeReturn', args: { id: rma.id, itemNo: line.itemNo, grade: 'restock', qty, to: bin.code, batch: lot.batch, expiry: lot.expiry }, ms: jitter(rand, 3 * MIN), what: `restock ${qty} × ${line.itemNo} from ${rma.id} into ${bin.code}`, key: `grade:${rma.id}:${line.itemNo}` };
      }
      // A new return about every hour and a half, against a piece order shipped a while ago.
      const k = all.length;
      const last = all.reduce((t, r) => Math.max(t, r.receivedAt || 0), dayStart(wh));
      const due = last + (60 + Math.floor(mulberry32(97 * (k + 1))() * 60)) * MIN;
      if (now < due) return { wait: true, what: 'waiting for a customer to send something back', ms: due - now, key: `rwait:${k}` };
      const shipped = Object.values(wh.orders).filter((o) => o.status === 'shipped' && o.shippedAt < now - 30 * MIN && o.lines.every((l) => l.kind === 'each') && !all.some((r) => r.orderId === o.id));
      if (!shipped.length) return { wait: true, what: 'waiting for a customer to send something back', ms: 15 * MIN, key: `rnone:${k}` };
      const pickOne = mulberry32(131 * (k + 1));
      const order = shipped[Math.floor(pickOne() * shipped.length)];
      const line = wh.returnable(order.id).lines.find((l) => l.left > 0 && !l.serialized);
      if (!line) return null;
      const qty = Math.min(line.left, 1 + Math.floor(pickOne() * 3));
      const reason = RETURN_REASONS[k % RETURN_REASONS.length];
      return { op: 'receiveReturn', args: { orderId: order.id, itemNo: line.itemNo, qty, reason }, ms: jitter(rand, 3 * MIN), what: `book a return from ${order.customer}: ${qty} × ${line.itemNo} (${reason.toLowerCase()})`, key: `return:${order.id}` };
    },
  };

  // ---- What just happened ----

  const WINDOW = 90 * MIN;
  const tail = (sscc) => `…${String(sscc).slice(-6)}`;

  /**
   * The things worth pointing at right now, newest first: what the system
   * just did or is waiting on, which roles it concerns, and which screen
   * shows it. Read from the warehouse, like everything the bots do. A
   * `standing` one is a state that holds until someone acts, not an event.
   */
  function highlights(wh, now) {
    const out = [];
    const recent = (t) => t && now - t <= WINDOW && t <= now;
    for (const c of Object.values(wh.checks || {})) {
      if (c.status === 'open') {
        const short = /Short pick/.test(c.note || '');
        out.push({ at: c.raisedAt, roles: ['S1', 'P1', 'manager'], kind: 'check', go: 'app.html?as=stock#stockctl',
          text: short ? `${c.raisedBy} found ${c.loc} short of ${c.itemNo}. The bin is held for check ${c.id}: no picks from it until stock control counts it.` : `${c.loc} is held for stock check ${c.id}: ${c.note}` });
      } else if (recent(c.closedAt) && c.outcome === 'corrected') {
        const adj = (wh.adjustments || []).find((a) => a.loc === c.loc && a.itemNo === c.itemNo && a.t <= c.closedAt && a.t >= c.raisedAt);
        out.push({ at: c.closedAt, roles: ['S1', 'P1', 'manager', 'admin'], kind: 'corrected', go: 'app.html?as=stock#history',
          text: `${c.closedBy} counted ${c.loc}${adj ? `: ${adj.before} on the books, ${adj.after} in the bin` : ''}. The books are corrected and check ${c.id} is closed; the picks go on from other stock.` });
      }
    }
    for (const d of Object.values(wh.deliveries)) {
      if (d.status !== 'open') continue;
      if (d.at === 'desk') {
        out.push({ at: d.createdAt, roles: ['DESK1', 'office'], kind: 'desk', go: 'desk.html',
          text: `Delivery ${d.id} from ${d.supplier} came without a pallet list, and its labels have no batch or best-before barcode: the receiving desk types them. ${d.received.length} of ${d.expected} pallets in.` });
      } else {
        out.push({ at: d.createdAt, roles: ['R1', 'R2', 'R3', 'office'], kind: 'dock', go: 'app.html?as=office#inbound',
          text: `Delivery ${d.id} from ${d.supplier} is at the dock with its pallet list: one scan per pallet receives it. ${d.received.length} of ${d.expected} in.` });
      }
    }
    for (const r of Object.values(wh.returns || {})) {
      const waiting = r.lines.filter((l) => wh._returnLeft(l));
      if (waiting.length) {
        out.push({ at: r.receivedAt, roles: ['returns', 'office'], kind: 'return', go: 'app.html?as=office#returns',
          text: `Return ${r.id} from ${(wh.orders[r.orderId] || {}).customer || r.orderId} (${String(r.reason || '').toLowerCase()}): ${waiting.map((l) => `${wh._returnLeft(l)} × ${l.itemNo}`).join(', ')} waiting to be graded.` });
        continue;
      }
      const last = r.history && r.history[r.history.length - 1];
      if (last && recent(last.t)) {
        const how = last.event === 'restock' ? `back into ${last.to}` : last.event === 'quarantine' ? `on hold at ${last.to}` : 'scrapped';
        out.push({ at: last.t, roles: ['returns', 'admin'], kind: 'graded', go: 'app.html?as=office#returns',
          text: `Return ${r.id}: ${last.qty} × ${last.itemNo} ${how}${last.event === 'restock' ? ', with the batch it went out with' : ''}.` });
      }
    }
    for (const w of Object.values(wh.waves || {})) {
      if (!recent(w.createdAt)) continue;
      const n = (k) => w.tasks.filter((t) => t.kind === k).length;
      out.push({ at: w.createdAt, roles: ['MU1', 'P1', 'office', 'manager'], kind: 'wave', go: 'app.html?as=office#waves',
        text: `Wave ${w.id} dropped from the queue: ${w.orders.length} order${w.orders.length === 1 ? '' : 's'}, ${n('case')} box pick${n('case') === 1 ? '' : 's'} for the man-up, ${n('bin')} bin pick${n('bin') === 1 ? '' : 's'}.` });
    }
    for (const sh of (wh.shipments || []).slice(-6)) {
      if (!recent(sh.t)) continue;
      const what = [sh.pallets.length && `${sh.pallets.length} pallet${sh.pallets.length === 1 ? '' : 's'}`, sh.cartons.length && `${sh.cartons.length} carton${sh.cartons.length === 1 ? '' : 's'}`].filter(Boolean).join(' and ');
      const traced = sh.pallets.some((p) => wh.items[p.itemNo] && wh.items[p.itemNo].serialized);
      out.push({ at: sh.t, roles: ['loader', 'packer', 'office'], kind: 'shipped', go: `app.html?as=office#outbound`,
        text: `${sh.orderId} left for ${sh.customer}${sh.truck ? ` with ${sh.truck}` : ''}: ${what}.${traced ? ' The drills’ serial numbers went with their pallets, without a scan each.' : ''}` });
    }
    const near = wh.bestBeforeWatch({ days: 14 });
    if (near.length) {
      const b = near[0];
      out.push({ at: now, standing: true, roles: ['S1', 'manager'], kind: 'bestbefore', go: 'app.html?as=stock#stockctl',
        text: `${b.qty} × ${b.itemNo} batch ${b.batch} in ${b.loc} is best before ${b.expiry}: too short to ship to anyone. The waves skip it; write it off on the Stock control screen.` });
    }
    for (const t of wh._liveTasks()) {
      if (t.type === 'SHIFT' && t.reason === 'replenish') continue;
      if (t.urgent && t.status !== 'done') out.push({ at: t.createdAt, roles: ['R1', 'R2', 'R3', 'manager'], kind: 'urgent', go: 'app.html?as=manager#tasks', text: `Job ${t.id} (${t.type.toLowerCase()}${t.orderId ? ` for ${t.orderId}` : ''}) is marked urgent: the next free truck takes it first.` });
    }
    return out.sort((a, b) => b.at - a.at).filter((h, i, all) => all.findIndex((x) => x.text === h.text) === i);
  }

  /** Everyone on the demo floor, in the order the role list shows them. */
  function crew() {
    return [
      office,
      truck('R1', 'Reach truck R1'),
      truck('R2', 'Reach truck R2'),
      truck('R3', 'Reach truck R3 (bulk)'),
      picker('MU1', 'Man-up MU1', ['case', 'pallet'], 'app.html#picks'),
      picker('P1', 'Bin picker P1', ['bin'], 'bins.html?as=P1'),
      packer,
      loader,
      desk,
      stock,
      returns,
    ];
  }

  /**
   * Runs the bots on the warehouse clock. Each bot's next step is planned with
   * the time it takes; when that time has passed and the step is still what
   * the system asks for, it is sent. Roles in `you` are left to a person.
   */
  class Runner {
    constructor({ bots = crew(), rand = Math.random } = {}) {
      this.bots = bots;
      this.rand = rand;
      this.plans = {};
      this.last = {};
    }

    /** Where each bot is: what it is doing and when it will be done. */
    status(you = new Set()) {
      return this.bots.map((b) => {
        const plan = (!you.has(b.id) && this.plans[b.id]) || {};
        return { id: b.id, name: b.name, screen: b.screen, you: you.has(b.id), doing: plan.what || null, wait: Boolean(plan.wait), at: plan.at || null, last: this.last[b.id] || null };
      });
    }

    step(wh, now, exec, you = new Set()) {
      const done = [];
      for (const bot of this.bots) {
        if (you.has(bot.id)) { delete this.plans[bot.id]; continue; }
        let act;
        try { act = bot.next(wh, now, this.rand); } catch (e) { act = null; }
        if (!act) { delete this.plans[bot.id]; continue; }
        const key = act.key || JSON.stringify([act.op, act.args]);
        const plan = this.plans[bot.id];
        if (!plan || plan.key !== key) { this.plans[bot.id] = { key, at: now + act.ms, what: act.what, wait: Boolean(act.wait) }; continue; }
        if (now < plan.at || act.wait) continue;
        delete this.plans[bot.id];
        let error = null;
        try {
          const r = exec(act.op, act.args, bot.id);
          if (r && r.ok === false && r.text) error = r.text;
        } catch (e) { error = e.message; }
        this.last[bot.id] = { what: act.what, t: now, error };
        done.push({ bot: bot.id, op: act.op, what: act.what, error });
      }
      return done;
    }
  }

  return { SITE, CLIENTS, ITEMS, CUSTOMERS, seed, morning, newOrder, newDelivery, crew, Runner, PACK, highlights };
});
