/*
 * Intake: orders and ASNs from other systems (a webshop, an ERP, a
 * supplier's advance shipping notice), as JSON documents or CSV.
 *
 * Every document carries the sender's own reference (`ref`). Sending the same
 * document again is safe: it is recognised and answered with the order or
 * delivery it made the first time, so a system that is not sure its last
 * call arrived just sends it again. The same ref with different content is
 * refused, so nothing is booked twice or quietly changed. The ref goes with
 * the order or delivery and comes back on its messages (src/messages.js).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SortedIntake = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const TYPES = ['order', 'asn'];
  const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;

  // A stable text for a document, so a resend can be told from a change.
  function canonical(v) {
    if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
    if (v && typeof v === 'object') return `{${Object.keys(v).filter((k) => v[k] !== undefined && v[k] !== null && v[k] !== '').sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
    return JSON.stringify(v);
  }

  function text(v, label, max = 80) {
    const s = String(v == null ? '' : v).trim();
    if (!s) throw new Error(`${label} is required`);
    if (s.length > max) throw new Error(`${label} is longer than ${max} characters`);
    return s;
  }

  function install(Warehouse) {
    const proto = Warehouse.prototype;

    /** An item by item number, GTIN or any of its codes. */
    proto._intakeItem = function (line, n) {
      const key = line.itemNo || line.item || line.gtin || line.ean || line.sku;
      const item = key != null && key !== '' && (this.items[String(key).trim()] || this.findItem(String(key).trim()));
      if (!item) throw new Error(`Line ${n}: unknown item ${key == null || key === '' ? '(none given)' : key}`);
      if (line && line.value != null && line.value !== '') this.updateItem(item.itemNo, { value: line.value });
      return item;
    };

    /** A free id: the ref itself when it can be one, else the ref behind the client, else numbered. */
    proto._intakeId = function (ref, clientId, taken, prefix) {
      if (ID.test(ref) && !taken[ref]) return ref;
      const own = clientId ? `${clientId}-${ref}` : null;
      if (own && ID.test(own) && !taken[own]) return own;
      let n = Object.keys(taken).length + 1;
      while (taken[`${prefix}${String(n).padStart(5, '0')}`]) n++;
      return `${prefix}${String(n).padStart(5, '0')}`;
    };

    /** The shipping lane with the fewest open orders, for an order that names none. */
    proto._intakeLane = function () {
      const lanes = Object.values(this.locations).filter((l) => l.kind === 'lane' && l.role === 'out').map((l) => l.code).sort();
      if (!lanes.length) throw new Error('This warehouse has no shipping lane');
      const load = Object.fromEntries(lanes.map((l) => [l, 0]));
      for (const o of this._liveOrders()) if (o.lane in load) load[o.lane]++;
      return lanes.reduce((best, l) => (load[l] < load[best] ? l : best), lanes[0]);
    };

    /**
     * Take in one document: { type: 'order' | 'asn', ref, … }. Returns
     * { status: 'created' | 'duplicate', type, ref, id }; a ref sent before
     * with other content throws.
     */
    proto.intake = function (doc = {}) {
      const type = String(doc.type || '').trim().toLowerCase();
      if (!TYPES.includes(type)) throw new Error('A document is an order or an asn (type)');
      const ref = text(doc.ref, 'The sender’s reference (ref)', 60);
      const clientId = doc.clientId || doc.client ? String(doc.clientId || doc.client).trim().toUpperCase() : null;
      const key = `${type}:${clientId || ''}:${ref}`;
      const sum = canonical({ ...doc, type, clientId });
      this.intakeRefs = this.intakeRefs || {};
      const seen = this.intakeRefs[key];
      if (seen) {
        if (seen.sum !== sum) throw new Error(`${type === 'order' ? 'Order' : 'ASN'} ${ref} was sent before with other content (it is ${seen.id}): change it in the warehouse, or send it under a new ref`);
        return { status: 'duplicate', type, ref, id: seen.id };
      }
      const id = type === 'order' ? this._intakeOrder(doc, ref, clientId) : this._intakeAsn(doc, ref, clientId);
      this.intakeRefs[key] = { id, sum, t: this.now() };
      return { status: 'created', type, ref, id };
    };

    proto._intakeOrder = function (doc, ref, clientId) {
      const customer = text(doc.customer || doc.shipTo, 'Customer', 80);
      if (!Array.isArray(doc.lines) || !doc.lines.length) throw new Error('An order needs lines');
      const lines = doc.lines.map((l, i) => {
        const item = this._intakeItem(l || {}, i + 1);
        const out = { itemNo: item.itemNo };
        if (l.pallets != null && l.pallets !== '') out.pallets = Number(l.pallets);
        else out.units = Number(l.units != null && l.units !== '' ? l.units : l.qty);
        return out;
      });
      const id = this._intakeId(String(doc.id || ref), clientId, this.orders, 'EXT');
      const order = this.addOrder({ id, customer, lane: doc.lane ? this.resolve(String(doc.lane)) : this._intakeLane(), lines, clientId, minDays: doc.minDays == null ? null : doc.minDays, verifyLoading: doc.verifyLoading === true });
      order.ref = ref;
      return order.id;
    };

    proto._intakeAsn = function (doc, ref, clientId) {
      const supplier = text(doc.supplier, 'Supplier', 80);
      const raw = Array.isArray(doc.pallets) ? doc.pallets : null;
      if (!raw || !raw.length) throw new Error('An ASN lists its pallets');
      const seen = new Set();
      const list = raw.map((p, i) => {
        const item = this._intakeItem(p || {}, i + 1);
        const sscc = String(p.sscc || '').trim().replace(/^\(00\)|^00(?=\d{18}$)/, '');
        if (!/^\d{18}$/.test(sscc)) throw new Error(`Line ${i + 1}: an SSCC is 18 digits`);
        if (seen.has(sscc)) throw new Error(`Line ${i + 1}: SSCC ${sscc} is on the ASN twice`);
        if (this.pallets[sscc] && this.pallets[sscc].status !== 'shipped') throw new Error(`Line ${i + 1}: SSCC ${sscc} is in stock already`);
        seen.add(sscc);
        const qty = p.qty == null || p.qty === '' ? item.palletQty : Number(p.qty);
        if (!Number.isInteger(qty) || qty < 1) throw new Error(`Line ${i + 1}: quantity must be a whole number above 0`);
        const row = { sscc, itemNo: item.itemNo, qty, batch: p.batch ? String(p.batch).trim() : null, expiry: p.expiry ? String(p.expiry).trim().slice(0, 10) : null };
        const sns = Array.isArray(p.serials) ? p.serials : p.serials ? String(p.serials).split(/[\s,;]+/) : [];
        if (sns.filter(Boolean).length) row.serials = sns.map((s) => String(s).trim()).filter(Boolean);
        return row;
      });
      const cats = [...new Set(list.map((r) => this.items[r.itemNo].category))];
      const category = doc.category ? String(doc.category).trim().toUpperCase() : cats.length === 1 ? cats[0] : null;
      if (!category) throw new Error(`The pallets are of ${cats.length} categories (${cats.join(', ')}): send one ASN per category, or name the category`);
      const id = this._intakeId(String(doc.id || ref), clientId, this.deliveries, 'IN-X');
      const delivery = this.addDelivery({ id, supplier, category, pallets: list.length, list, at: doc.at === 'desk' ? 'desk' : 'dock', asn: ref, clientId, expectedAt: doc.expectedAt ? String(doc.expectedAt).slice(0, 10) : null });
      delivery.ref = ref;
      return delivery.id;
    };
  }

  /**
   * CSV into documents: one row per line, rows with the same ref make one
   * document. Comma or semicolon; a header row names the columns (case and
   * spaces do not matter). Orders: ref, customer, client, lane, item (or
   * gtin), units or pallets, minDays, value. ASNs: ref, supplier, client, category,
   * expected, sscc, item (or gtin), qty, batch, expiry, serials, value.
   */
  function fromCsv(type, csv) {
    const kind = String(type || '').trim().toLowerCase();
    if (!TYPES.includes(kind)) throw new Error('Say what the CSV holds: order or asn');
    const rows = parse(String(csv || ''));
    if (rows.length < 2) throw new Error('The CSV needs a header row and at least one line');
    const head = rows[0].map((h) => h.trim().toLowerCase().replace(/[\s_-]+/g, ''));
    const col = (row, ...names) => {
      for (const n of names) { const i = head.indexOf(n); if (i >= 0 && row[i] != null && String(row[i]).trim() !== '') return String(row[i]).trim(); }
      return null;
    };
    const docs = new Map();
    rows.slice(1).forEach((row, i) => {
      if (row.every((c) => !String(c).trim())) return;
      const ref = col(row, 'ref', 'reference', 'orderref', 'asn', 'order');
      if (!ref) throw new Error(`Row ${i + 2}: no ref`);
      if (!docs.has(ref)) {
        docs.set(ref, kind === 'order'
          ? { type: 'order', ref, customer: col(row, 'customer', 'shipto'), clientId: col(row, 'client', 'clientid'), lane: col(row, 'lane'), minDays: col(row, 'mindays'), lines: [] }
          : { type: 'asn', ref, supplier: col(row, 'supplier'), clientId: col(row, 'client', 'clientid'), category: col(row, 'category'), expectedAt: col(row, 'expected', 'expectedat'), pallets: [] });
      }
      const doc = docs.get(ref);
      const item = col(row, 'item', 'itemno', 'sku');
      const gtin = col(row, 'gtin', 'ean');
      const value = col(row, 'value', 'unitvalue');
      if (kind === 'order') doc.lines.push({ itemNo: item || undefined, gtin: gtin || undefined, units: col(row, 'units', 'qty'), pallets: col(row, 'pallets'), value: value || undefined });
      else doc.pallets.push({ sscc: col(row, 'sscc'), itemNo: item || undefined, gtin: gtin || undefined, qty: col(row, 'qty', 'units'), batch: col(row, 'batch', 'lot'), expiry: col(row, 'expiry', 'bestbefore'), serials: col(row, 'serials'), value: value || undefined });
    });
    for (const d of docs.values()) for (const k of Object.keys(d)) if (d[k] == null) delete d[k];
    return [...docs.values()];
  }

  // RFC 4180-ish: quoted fields with "" inside, comma or semicolon, whichever the header uses.
  function parse(src) {
    const first = src.split(/\r?\n/, 1)[0] || '';
    const sep = (first.match(/;/g) || []).length > (first.match(/,/g) || []).length ? ';' : ',';
    const rows = [];
    let row = [];
    let cell = '';
    let quoted = false;
    for (let i = 0; i < src.length; i++) {
      const c = src[i];
      if (quoted) {
        if (c === '"' && src[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') quoted = false; else cell += c;
      } else if (c === '"') quoted = true;
      else if (c === sep) { row.push(cell); cell = ''; } else if (c === '\n' || c === '\r') {
        if (c === '\r' && src[i + 1] === '\n') i++;
        row.push(cell); rows.push(row); row = []; cell = '';
      } else cell += c;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows;
  }

  return { install, fromCsv, parse, TYPES };
});
