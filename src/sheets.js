/*
 * Labels for people without a warehouse label printer: a printable page of
 * location, item or plate labels laid out for a sticker sheet (A4 or US
 * Letter) or a roll in a cheap label printer, one label per page. Print it
 * from the browser at 100% (no "fit to page") so the labels land on the
 * stickers. `skip` leaves the stickers already used on a part sheet.
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SortedSheets = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  // Sizes in mm. A sheet has columns × rows of labels with margins and gaps;
  // a roll is one label per page.
  const LAYOUTS = {
    'a4-21': { name: 'A4, 21 per sheet (Avery L7160, 63.5 × 38.1 mm)', page: [210, 297], label: [63.5, 38.1], cols: 3, rows: 7, top: 15.15, left: 7.25, gapX: 2.5, gapY: 0 },
    'a4-14': { name: 'A4, 14 per sheet (Avery L7163, 99.1 × 38.1 mm)', page: [210, 297], label: [99.1, 38.1], cols: 2, rows: 7, top: 15.15, left: 4.65, gapX: 2.5, gapY: 0 },
    'a4-8': { name: 'A4, 8 per sheet (Avery L7165, 99.1 × 67.7 mm)', page: [210, 297], label: [99.1, 67.7], cols: 2, rows: 4, top: 13.1, left: 4.65, gapX: 2.5, gapY: 0 },
    'letter-30': { name: 'US Letter, 30 per sheet (Avery 5160, 66.7 × 25.4 mm)', page: [215.9, 279.4], label: [66.7, 25.4], cols: 3, rows: 10, top: 12.7, left: 4.8, gapX: 3.2, gapY: 0 },
    'roll-62x29': { name: 'Roll 62 × 29 mm (Brother QL)', roll: true, label: [62, 29] },
    'roll-57x32': { name: 'Roll 57 × 32 mm (2¼ × 1¼ in)', roll: true, label: [57, 32] },
    'roll-102x152': { name: 'Roll 4 × 6 in (102 × 152 mm)', roll: true, label: [101.6, 152.4] },
  };

  function barcodeLib() {
    if (root && root.SortedBarcode) return root.SortedBarcode;
    if (typeof require === 'function') { try { return require('./barcode'); } catch (e) { /* browser */ } }
    return null;
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /** A Code 128 barcode as wide as `maxW` mm allows, between 0.19 and 0.5 mm a module. */
  function barcode(text, maxW, height) {
    const Barcode = barcodeLib();
    if (!Barcode || !text) return '';
    const n = Barcode.modules(String(text)).length + 20;
    const module = Math.max(0.19, Math.min(0.5, maxW / n));
    return Barcode.svg(String(text), { module: +module.toFixed(3), height: +height.toFixed(1), unit: 'mm' });
  }

  /**
   * labels: [{ big, small, barcode, corner }]. `big` is the readable code,
   * `small` a line under it, `corner` a short mark (check digits).
   */
  function sheetHtml({ labels, layout = 'a4-21', skip = 0, title = 'Labels' } = {}) {
    const L = LAYOUTS[layout];
    if (!L) throw new Error(`Layout is one of ${Object.keys(LAYOUTS).join(', ')}`);
    const blank = Math.max(0, Math.min(Number(skip) || 0, L.roll ? 0 : L.cols * L.rows - 1));
    const [w, h] = L.label;
    const big = Math.min(h * 0.3, w / 7);
    const barH = h * 0.36;
    // The readable code is what people look for: as large as fits on one line, wrapping only when it is very long.
    const fit = (text) => Math.max(2.6, Math.min(big, (w - 4 - (text.length > 6 ? 0 : 8)) / (0.62 * Math.max(1, String(text).length))));
    const one = (d) => `<div class="label">${d.corner ? `<span class="corner">${esc(d.corner)}</span>` : ''}<div class="big" style="font-size:${fit(d.big).toFixed(2)}mm">${esc(d.big)}</div><div class="bar">${barcode(d.barcode, w - 4, barH)}</div><div class="small">${esc(d.small || '')}</div></div>`;
    const cells = Array.from({ length: blank }, () => '<div class="label empty"></div>').concat(labels.map(one));
    let pages = '';
    if (L.roll) pages = cells.map((c) => `<section class="page">${c}</section>`).join('');
    else for (let i = 0; i < cells.length; i += L.cols * L.rows) pages += `<section class="page">${cells.slice(i, i + L.cols * L.rows).join('')}</section>`;
    const pageSize = L.roll ? `${w}mm ${h}mm` : `${L.page[0]}mm ${L.page[1]}mm`;
    const grid = L.roll ? `display: block; padding: 0;` : `display: grid; grid-template-columns: repeat(${L.cols}, ${w}mm); grid-auto-rows: ${h}mm; column-gap: ${L.gapX}mm; row-gap: ${L.gapY}mm; padding: ${L.top}mm 0 0 ${L.left}mm;`;
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; background: #e8e8e8; color: #000; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  .bar-top { padding: 10px 14px; background: #fff; border-bottom: 1px solid #ccc; display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
  .bar-top button { font: inherit; font-weight: 600; padding: 8px 14px; }
  .bar-top span { color: #444; }
  .page { width: ${L.roll ? w : L.page[0]}mm; height: ${L.roll ? h : L.page[1]}mm; margin: 12px auto; background: #fff; overflow: hidden; ${grid} page-break-after: always; break-after: page; }
  .label { position: relative; width: ${w}mm; height: ${h}mm; padding: 1.5mm 2mm; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 0.6mm; overflow: hidden; outline: 1px dashed #ddd; }
  .label.empty { outline-color: #f0f0f0; }
  .big { font: 800 ${big.toFixed(1)}mm/1.05 ui-monospace, Menlo, Consolas, monospace; max-width: 100%; text-align: center; overflow-wrap: anywhere; }
  .bar svg { display: block; max-width: 100%; }
  .small { font-size: ${Math.min(3.2, h * 0.09).toFixed(1)}mm; max-width: 100%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .corner { position: absolute; top: 1.2mm; right: 1.8mm; font: 800 ${Math.min(5, h * 0.14).toFixed(1)}mm/1 system-ui, sans-serif; border: 0.4mm solid #000; border-radius: 1mm; padding: 0.3mm 0.8mm; }
  @media print {
    body { background: #fff; }
    .bar-top { display: none; }
    .page { margin: 0; }
    .label { outline: 0; }
    @page { size: ${pageSize}; margin: 0; }
  }
</style></head><body>
<div class="bar-top"><button onclick="print()">Print</button><span>${esc(L.name)} · ${labels.length} label${labels.length === 1 ? '' : 's'}${blank ? `, starting after ${blank} used` : ''}. Print at 100% (actual size), no margins.</span></div>
${pages || '<p style="padding:16px">No labels to print.</p>'}
</body></html>`;
  }

  function install(Warehouse) {
    const proto = Warehouse.prototype;

    /**
     * Labels for locations (codes, or every stock location starting with a
     * prefix), items (with their pack barcodes) or plates.
     */
    proto.labelSheet = function ({ kind = 'locations', codes = null, prefix = null, items = null, ids = null, layout = 'a4-21', skip = 0 } = {}) {
      const list = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\s,;]+/)).map((x) => String(x).trim()).filter(Boolean);
      const labels = [];
      if (kind === 'locations') {
        let locs;
        if (codes) locs = list(codes).map((c) => this._loc(this.resolve(c)));
        else {
          const p = String(prefix || '').trim().toUpperCase();
          locs = Object.values(this.locations)
            .filter((l) => !l.structural && ['rack', 'bin', 'mezzanine', 'block', 'lane', 'virtual'].includes(l.kind) && l.code.toUpperCase().startsWith(p))
            .sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
        }
        if (locs.length > 1000) throw new Error(`That is ${locs.length} labels. Narrow it to 1000`);
        for (const l of locs) {
          const check = typeof this.checkDigit === 'function' ? this.checkDigit(l.code) : null;
          labels.push({ big: l.code, barcode: l.code, corner: check, small: [l.name && l.name !== l.code ? l.name : null, l.category ? this.categories[l.category] || l.category : null, l.kind === 'rack' ? null : l.kind].filter(Boolean).join(' · ') });
        }
      } else if (kind === 'items') {
        const wanted = list(items);
        const chosen = wanted.length ? wanted.map((n) => { const i = this.items[n]; if (!i) throw new Error(`Unknown item ${n}`); return i; }) : Object.values(this.items).filter((i) => i.status !== 'archived');
        for (const i of chosen) {
          labels.push({ big: i.itemNo, barcode: i.gtin || i.itemNo, small: `${i.name}${i.uom ? ` · per ${i.uom}` : ''}` });
          for (const p of i.packs || []) if (p.barcode) labels.push({ big: `${i.itemNo} ${p.unit}`, barcode: p.barcode, small: `${i.name} · ${p.unit} of ${p.per}` });
        }
      } else if (kind === 'plates') {
        for (const id of list(ids)) {
          const h = this._holder(id);
          const line = (h.contents || [])[0] || {};
          labels.push({ big: h.id, barcode: h.id, small: [line.itemNo, line.qty != null ? `× ${line.qty}` : null, h.loc].filter(Boolean).join(' ') });
        }
      } else throw new Error('Kind is locations, items or plates');
      return sheetHtml({ labels, layout, skip, title: `${kind[0].toUpperCase()}${kind.slice(1)} labels` });
    };
  }

  return { install, LAYOUTS, sheetHtml };
});
