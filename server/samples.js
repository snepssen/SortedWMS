/*
 * Sample warehouses to try SortedWMS on, without real data: a home bin wall,
 * a maker's workshop and a small 3PL. Each one starts from the blank site and
 * goes in through ordinary commands, so it lands in the journal like any other
 * change. `./start.sh sample home` keeps it in its own database file.
 */
'use strict';

const BY = 'sample';

function units(x, itemNo, packs, unitWeightKg) {
  x('setItemUnits', { itemNo, packs, unitWeightKg });
}

const SAMPLES = {
  home: {
    name: 'Home bin wall',
    load(x) {
      x('applyPreset', { id: 'home-garage' });
      x('generateGuided', { answers: { sections: { count: 1, name: 'Garage' }, layouts: [{ type: 'shelf', aisles: { count: 1 }, bays: { count: 3, name: 'Shelf 1' }, positions: { count: 4, name: 'Bin 1' }, levels: { count: 3, name: 'Floor, Middle, Top' } }] } });
      const items = [
        ['M3-10', 'M3 × 10 mm screw', [{ unit: 'box', per: 100, barcode: '2000000000305' }], 0.001],
        ['M4-16', 'M4 × 16 mm screw', [{ unit: 'box', per: 100 }], 0.002],
        ['WP-6', '6 mm wall plug', [{ unit: 'bag', per: 50 }], 0.001],
        ['CT-200', 'Cable tie 200 mm', [{ unit: 'bag', per: 100 }], 0.002],
        ['AA', 'AA battery', [{ unit: 'pack', per: 4 }], 0.023],
        ['FUSE-5', '5 A fuse', [{ unit: 'box', per: 10 }], 0.002],
        ['LED-5M', 'LED strip, 5 m', [], 0.2],
        ['TAPE-B', 'Electrical tape, black', [], 0.05],
      ];
      for (const [itemNo, name] of items) x('addItem', { itemNo, name, category: 'HOME', palletQty: 1, uom: 'piece' });
      for (const [itemNo, , packs, kg] of items) units(x, itemNo, packs, kg);
      const put = [
        ['Garage-Shelf1-Bin1-Middle', 'M3-10', 340], ['Garage-Shelf1-Bin2-Middle', 'M4-16', 180], ['Garage-Shelf1-Bin3-Middle', 'WP-6', 120],
        ['Garage-Shelf1-Bin4-Middle', 'CT-200', 250], ['Garage-Shelf2-Bin1-Top', 'AA', 24], ['Garage-Shelf2-Bin1-Top', 'FUSE-5', 30],
        ['Garage-Shelf3-Bin1-Floor', 'LED-5M', 4], ['Garage-Shelf2-Bin2-Top', 'TAPE-B', 6],
      ];
      for (const [loc, itemNo, qty] of put) x('binPut', { loc, itemNo, qty });
      x('setBinMode', { code: 'Garage-Shelf1-Bin1-Middle', mixed: false });
      x('addOrder', { id: 'HOME-1', customer: 'Neighbour', lane: 'OUT-01', lines: [{ itemNo: 'M3-10', units: 40 }, { itemNo: 'AA', units: 8 }] });
      return '36 bins in the garage, 8 kinds of parts, one order to pick from the Bins screen';
    },
  },

  maker: {
    name: "Maker's workshop",
    load(x, now) {
      x('applyPreset', { id: 'small-maker' });
      x('generateGuided', { answers: { sections: { count: 1, name: 'Workshop' }, layouts: [{ type: 'shelf', aisles: { count: 1 }, bays: { count: 2, name: 'Rack 1' }, positions: { count: 4, name: 'Bin 1' }, levels: { count: 2, name: 'Low, High' } }] } });
      x('createLocation', { code: 'PACKTABLE', kind: 'virtual', role: 'staging', name: 'Packing table' });
      const day = (n) => new Date(now + n * 86400000).toISOString().slice(0, 10);
      const items = [
        ['SOAP-LAV', 'Lavender soap bar', 'MADE', [{ unit: 'box', per: 12 }], 0.1],
        ['CANDLE-S', 'Small soy candle', 'MADE', [{ unit: 'box', per: 6 }], 0.2],
        ['GIFTSET', 'Gift set: soap and candle', 'MADE', [], 0.4],
        ['JAR-200', '200 ml glass jar', 'PACK', [{ unit: 'box', per: 24 }], 0.15],
        ['LABEL-R', 'Round label', 'PACK', [{ unit: 'roll', per: 500 }], 0.001],
        ['GIFTBOX', 'Gift box', 'PACK', [], 0.08],
      ];
      for (const [itemNo, name, category] of items) x('addItem', { itemNo, name, category, palletQty: 1, uom: 'piece' });
      for (const [itemNo, , , packs, kg] of items) units(x, itemNo, packs, kg);
      x('binPut', { loc: 'Workshop-Rack1-Bin1-Low', itemNo: 'SOAP-LAV', qty: 36, batch: 'S-0912', expiry: day(150) });
      x('binPut', { loc: 'Workshop-Rack1-Bin2-Low', itemNo: 'SOAP-LAV', qty: 48, batch: 'S-1020', expiry: day(300) });
      x('binPut', { loc: 'Workshop-Rack1-Bin3-Low', itemNo: 'CANDLE-S', qty: 30, batch: 'C-1015', expiry: day(700) });
      x('binPut', { loc: 'Workshop-Rack2-Bin1-High', itemNo: 'JAR-200', qty: 96 });
      x('binPut', { loc: 'Workshop-Rack2-Bin2-High', itemNo: 'LABEL-R', qty: 1500 });
      x('binPut', { loc: 'Workshop-Rack2-Bin3-High', itemNo: 'GIFTBOX', qty: 40 });
      x('addKit', { id: 'GIFT', name: 'Gift set', base: { itemNo: 'GIFTBOX', qty: 1 }, components: [{ itemNo: 'SOAP-LAV', qty: 1 }, { itemNo: 'CANDLE-S', qty: 1 }], output: 'GIFTSET' });
      x('addValStation', { id: 'BENCH', name: 'Packing bench', kitId: 'GIFT' });
      x('addOrder', { id: 'SHOP-1001', customer: 'Online shop', lane: 'OUT-01', lines: [{ itemNo: 'SOAP-LAV', units: 30 }, { itemNo: 'CANDLE-S', units: 4 }] });
      return '16 bins in the workshop, soap in two batches (earliest best-before picks first), a gift-set kit, one shop order';
    },
  },

  '3pl': {
    name: 'Small 3PL',
    load(x, now, wh) {
      x('applyPreset', { id: 'high-value' });
      x('generateGuided', { answers: { sections: { count: 2, name: 'Hall, Mezz' }, layouts: [
        { type: 'rack', aisles: { count: 2, name: '01' }, bays: { count: 4, name: '01' }, positions: { count: 2 }, levels: { count: 3, name: 'A' } },
        { type: 'shelf', aisles: { count: 1 }, bays: { count: 2, name: 'Shelf 1' }, positions: { count: 4, name: 'Bin 1' }, levels: { count: 1 } },
      ] } });
      const racks = Object.values(wh().locations).filter((l) => l.kind === 'rack' && !l.structural && l.code.startsWith('Hall-')).map((l) => l.code).sort();
      // Aisle 01 holds electronics, aisle 02 computers.
      x('importLocations', { rows: racks.map((code) => ({ code, category: code.startsWith('Hall-01') ? 'ELEC' : 'COMP' })) });
      x('createLocation', { code: 'POSTPICK', kind: 'virtual', role: 'staging', name: 'Post-pick lane' });
      x('setWaveConfig', { config: { postPick: 'POSTPICK', maxWaitMin: 60 } });
      x('addClient', { id: 'CL-NORTH', name: 'North Gadgets', contact: 'Noor', email: 'orders@north.example' });
      x('addClient', { id: 'CL-SOUTH', name: 'South Computers', contact: 'Sami', email: 'orders@south.example' });
      const items = [
        ['PHONE-X', 'Phone X, boxed', 'ELEC', 'CL-NORTH', 400, [{ unit: 'case', per: 10 }], 0.4],
        ['CABLE-C', 'USB-C cable 1 m', 'ELEC', 'CL-NORTH', 2000, [{ unit: 'box', per: 50 }], 0.03],
        ['LAPTOP-14', 'Laptop 14 in', 'COMP', 'CL-SOUTH', 40, [{ unit: 'case', per: 2 }], 2.1],
        ['MOUSE-W', 'Wireless mouse', 'COMP', 'CL-SOUTH', 600, [{ unit: 'box', per: 20 }], 0.1],
      ];
      for (const [itemNo, name, category, clientId, palletQty] of items) x('addItem', { itemNo, name, category, clientId, palletQty, uom: 'piece' });
      for (const [itemNo, , , , , packs, kg] of items) units(x, itemNo, packs, kg);
      const stock = [];
      const slot = { ELEC: racks.filter((c) => c.startsWith('Hall-01')), COMP: racks.filter((c) => c.startsWith('Hall-02')) };
      for (const [itemNo, , category, , palletQty] of items) {
        for (let i = 0; i < 2; i++) stock.push({ code: slot[category].shift(), itemNo, qty: i ? palletQty : Math.round(palletQty * 0.6), receivedAt: now - (10 - i) * 86400000 });
      }
      x('importStock', { rows: stock });
      x('binPut', { loc: 'Mezz-Shelf1-Bin1', itemNo: 'CABLE-C', qty: 140 });
      x('binPut', { loc: 'Mezz-Shelf1-Bin2', itemNo: 'MOUSE-W', qty: 35 });
      x('binPut', { loc: 'Mezz-Shelf1-Bin3', itemNo: 'PHONE-X', qty: 7 });
      const tariff = { storageBasis: 'pallet-day', storageRate: 0.45, inboundBasis: 'pallet', inboundRate: 3.5, outboundBasis: 'line', outboundRate: 0.9, valRate: 0, monthlyMinimum: 150 };
      x('setTariff', { clientId: 'CL-NORTH', tariff });
      x('setTariff', { clientId: 'CL-SOUTH', tariff: { ...tariff, storageRate: 0.5 } });
      x('addTruck', { id: 'RT01' });
      x('setTruckEquipment', { id: 'RT01', equipment: 'reach' });
      x('addTruck', { id: 'MU01' });
      x('setTruckEquipment', { id: 'MU01', equipment: 'manup' });
      x('addOrder', { id: 'N-5001', customer: 'Gadget shop', lane: 'OUT-01', clientId: 'CL-NORTH', lines: [{ itemNo: 'PHONE-X', units: 245 }, { itemNo: 'CABLE-C', units: 120 }] });
      x('addOrder', { id: 'S-7001', customer: 'School', lane: 'OUT-02', clientId: 'CL-SOUTH', lines: [{ itemNo: 'LAPTOP-14', units: 24 }, { itemNo: 'MOUSE-W', units: 24 }] });
      return '48 rack slots and 8 mezzanine bins, two clients with rate cards, a reach truck and a man-up, two orders for the pick wave';
    },
  },
};

/** Load a sample into an empty warehouse. */
function loadSample(store, kind) {
  const sample = SAMPLES[kind];
  if (!sample) throw new Error(`Sample is one of ${Object.keys(SAMPLES).join(', ')}`);
  const wh = () => store.wh;
  const busy = Object.keys(wh().items).length || Object.keys(wh().pallets).length || Object.keys(wh().binStock || {}).length || Object.keys(wh().orders).length;
  if (busy) return `Sample ${kind} skipped: this warehouse already has items, stock or orders`;
  const x = (op, args) => store.exec(op, args, BY);
  const text = sample.load(x, store.now(), wh);
  return `Sample loaded: ${sample.name}. ${text}.`;
}

module.exports = { SAMPLES, loadSample };
