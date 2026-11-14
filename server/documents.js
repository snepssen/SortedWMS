/*
 * A4 PDFs for the documents module. Dates use the warehouse timezone.
 * Label printers stay on ZPL; this file does not touch them.
 */
'use strict';

const { document, paginate } = require('../src/pdf');

function tr(wh, key) {
  const lang = (wh.config && wh.config.language) || 'en';
  try {
    const api = require('../src/i18n');
    return api.t(lang, key);
  } catch (e) {
    return key;
  }
}

function stamp(wh, ms) {
  return wh.formatLocal ? wh.formatLocal(ms == null ? wh.now() : ms) : '';
}

function line(text, size, gap) {
  return { text: String(text == null ? '' : text), size: size || 11, gap };
}

function orderOrThrow(wh, orderId) {
  const order = wh.orders && wh.orders[String(orderId)];
  if (!order) throw new Error(`Unknown order ${orderId}`);
  return order;
}

function head(wh, title, extra) {
  return [
    line(title, 18, 22),
    line(stamp(wh), 11, 16),
    line(extra || '', 11, 18),
  ];
}

function deliveryNote(wh, orderId) {
  const order = orderOrThrow(wh, orderId);
  const rows = head(wh, `${tr(wh, 'Delivery note')} ${order.id}`, `${order.customer || ''} · ${tr(wh, 'Lane')} ${order.lane || ''}`);
  if (order.carrierName || order.tracking) rows.push(line(`${order.carrierName || ''} ${order.tracking || ''} ${order.trackingUrl || ''}`.trim()));
  rows.push(line(tr(wh, 'Lines'), 13, 18));
  for (const item of order.lines || []) {
    rows.push(line(`${item.itemNo}  ${item.units || item.pallets || ''}  ${item.name || (wh.items[item.itemNo] && wh.items[item.itemNo].name) || ''}`));
  }
  const ship = order.shipment;
  if (ship) {
    rows.push(line(`${tr(wh, 'Shipment')} ${ship.status || ''} ${stamp(wh, ship.stagedAt)}`, 13, 18));
    for (const holder of ship.holders || []) rows.push(line(`${holder.kind} ${holder.id || holder.sscc || ''}  ${holder.itemNo || ''}  ${holder.qty}`));
  }
  return document(paginate(rows));
}

function pickList(wh, orderId) {
  const order = orderOrThrow(wh, orderId);
  const rows = head(wh, `${tr(wh, 'Pick list')} ${order.id}`, order.customer || '');
  for (const item of order.lines || []) {
    const name = item.name || (wh.items[item.itemNo] && wh.items[item.itemNo].name) || '';
    rows.push(line(`${item.itemNo}  ${name}`));
    rows.push(line(`${tr(wh, 'Qty')} ${item.units || item.pallets || 0}    ${tr(wh, 'Picked')} ${item.picked || 0}`));
  }
  return document(paginate(rows));
}

function packingList(wh, orderId) {
  const order = orderOrThrow(wh, orderId);
  const rows = head(wh, `${tr(wh, 'Packing list')} ${order.id}`, order.customer || '');
  const boxes = Object.values(wh.holders || {}).filter((h) => h.orderId === order.id && h.series === 'OUT');
  if (!boxes.length) rows.push(line(tr(wh, 'No carton yet')));
  for (const box of boxes) {
    rows.push(line(`${box.id}  ${box.cartonStatus || ''}  ${box.weightKg ? box.weightKg + ' kg' : ''}`, 12, 16));
    for (const packed of box.packed || []) rows.push(line(`  ${packed.qty}  ${packed.itemNo}  ${packed.batch || ''}  ${packed.expiry || ''}`));
  }
  return document(paginate(rows));
}

function statement(wh, clientId, { from = null, to = null } = {}) {
  const inv = wh.invoice({ clientId, from, to });
  const rows = head(wh, `${tr(wh, 'Statement')} ${inv.clientId}`, inv.name);
  rows.push(line(`${inv.periodFrom || ''} ${tr(wh, 'to')} ${inv.periodTo || ''} ${inv.timeZone || wh.timeZone()}`));
  for (const item of inv.lines || []) rows.push(line(`${item.label}  ${item.qty}  ${item.amount}`));
  rows.push(line(`${tr(wh, 'Total')} ${inv.total}`, 14, 20));
  return document(paginate(rows));
}

module.exports = { deliveryNote, pickList, packingList, statement };
