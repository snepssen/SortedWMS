/*
 * Label output for networked label printers. Produces ZPL, the command
 * language Zebra and most compatible thermal printers accept on raw TCP
 * port 9100. Runs in the browser (window.Labels) and Node.
 */
(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('./gs1') : root.GS1);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Labels = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (GS1) {
  'use strict';

  // ZPL field data cannot contain ^ or ~ unescaped.
  const clean = (s) => String(s == null ? '' : s).replace(/[\^~]/g, ' ');

  const ddmmyyyy = (iso) => `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}`;

  /**
   * 4×6 inch shipping label at 203 dpi. The top barcode is the shipping
   * label code the driver scans to confirm the label is on; the bottom one
   * is the GS1-128 SSCC so the customer can scan the pallet on arrival.
   */
  function shippingLabel(d) {
    return [
      '^XA',
      '^CI28',
      '^PW812^LL1218',
      `^FO40,40^A0N,34,34^FDSHIP TO^FS`,
      `^FO40,85^A0N,64,64^FD${clean(d.customer)}^FS`,
      `^FO40,170^A0N,34,34^FDOrder ${clean(d.orderId)}   Pallet ${clean(d.index)} of ${clean(d.total)}^FS`,
      '^FO40,220^GB732,3,3^FS',
      `^FO40,250^A0N,44,44^FD${clean(d.itemName)}^FS`,
      `^FO40,305^A0N,34,34^FDItem ${clean(d.itemNo)}   Qty ${clean(d.qty)}^FS`,
      `^FO40,350^A0N,34,34^FDBatch ${clean(d.batch)}   Best before ${clean(ddmmyyyy(d.expiry))}^FS`,
      '^FO40,400^GB732,3,3^FS',
      `^FO40,430^A0N,30,30^FDLabel ${clean(d.labelCode)}^FS`,
      `^FO40,470^BY3^BCN,140,N,N,N^FD${clean(d.labelCode)}^FS`,
      '^FO40,650^GB732,3,3^FS',
      `^FO40,680^A0N,30,30^FDSSCC^FS`,
      `^FO40,720^BY3^BCN,220,N,N,N^FD>;>800${clean(d.sscc)}^FS`,
      `^FO40,960^A0N,40,40^FD(00) ${clean(d.sscc)}^FS`,
      `^FO40,1040^A0N,28,28^FDLane ${clean(d.lane)}   Printed ${clean(d.printedAt)}^FS`,
      '^XZ',
    ].join('\n');
  }

  /** Pallet label for receiving when a supplier pallet arrives without a usable one. */
  function palletLabel(d) {
    return [
      '^XA',
      '^CI28',
      '^PW812^LL1218',
      `^FO40,40^A0N,64,64^FD${clean(d.itemName)}^FS`,
      `^FO40,120^A0N,34,34^FDItem ${clean(d.itemNo)}   Qty ${clean(d.qty)}^FS`,
      `^FO40,170^A0N,34,34^FDBatch ${clean(d.batch)}   Best before ${clean(ddmmyyyy(d.expiry))}^FS`,
      `^FO40,260^BY3^BCN,220,N,N,N^FD>;>800${clean(d.sscc)}^FS`,
      `^FO40,500^A0N,40,40^FD${clean(GS1.hri({ sscc: d.sscc }))}^FS`,
      ...(d.client ? [`^FO40,560^A0N,30,30^FDClient ${clean(d.client)}^FS`] : []),
      ...(d.gtin ? [`^FO40,600^A0N,28,28^FDGTIN ${clean(d.gtin)}^FS`] : []),
      ...(d.location ? [`^FO40,640^A0N,28,28^FDLocation ${clean(d.location)}^FS`] : []),
      '^XZ',
    ].join('\n');
  }

  /**
   * Logistic-unit (master) label. The barcode is the GS1-128 SSCC of the
   * master; child SSCCs are listed in clear so a later scan of any of them
   * still finds the unit.
   */
  function masterLabel(d) {
    const children = d.children || [];
    const lines = children.slice(0, 8).map((c, i) => `^FO40,${760 + i * 36}^A0N,28,28^FD${clean(typeof c === 'string' ? c : c.sscc)}  ${clean(c.itemNo || '')}  ${c.qty == null ? '' : clean(c.qty)}^FS`);
    return [
      '^XA',
      '^CI28',
      '^PW812^LL1218',
      '^FO40,40^A0N,36,36^FDMASTER^FS',
      `^FO40,90^A0N,48,48^FD${clean(d.title || d.customer || 'Logistic unit')}^FS`,
      d.orderId ? `^FO40,150^A0N,32,32^FDOrder ${clean(d.orderId)}^FS` : '',
      '^FO40,200^GB732,3,3^FS',
      '^FO40,230^A0N,30,30^FDSSCC^FS',
      `^FO40,270^BY3^BCN,180,N,N,N^FD>;>800${clean(d.sscc)}^FS`,
      `^FO40,470^A0N,36,36^FD(00) ${clean(d.sscc)}^FS`,
      `^FO40,530^A0N,28,28^FDContains ${clean(children.length)} unit${children.length === 1 ? '' : 's'}^FS`,
      '^FO40,580^GB732,3,3^FS',
      ...lines,
      '^XZ',
    ].filter(Boolean).join('\n');
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /** Printable 4×6 label. The browser's print dialog is the PDF path. */
  function labelHtml(d) {
    const rows = (d.lines || []).map(([k, v]) => `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`).join('');
    const kids = (d.children || []).map((c) => `<li><span class="mono">(00) ${escapeHtml(c.sscc || c)}</span> ${escapeHtml(c.itemNo || '')}${c.qty == null ? '' : ` × ${escapeHtml(c.qty)}`}</li>`).join('');
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(d.kind === 'master' ? 'Master label' : 'Pallet label')} ${escapeHtml(d.sscc)}</title>
<style>
  body { margin: 0; font: 14px/1.35 system-ui, sans-serif; color: #111; }
  .sheet { width: 4in; min-height: 6in; margin: 12px auto; padding: 0.25in; border: 1px solid #111; box-sizing: border-box; }
  h1 { font-size: 13px; letter-spacing: .12em; margin: 0 0 6px; }
  h2 { font-size: 22px; margin: 0 0 8px; }
  table { width: 100%; border-collapse: collapse; margin: 8px 0; }
  th, td { text-align: left; vertical-align: top; padding: 3px 6px 3px 0; border-bottom: 1px solid #ddd; }
  th { width: 34%; color: #444; font-weight: 600; }
  .sscc { font: 600 18px ui-monospace, monospace; margin: 8px 0; }
  .mono { font-family: ui-monospace, monospace; }
  ul { margin: 6px 0; padding-left: 18px; }
  .bar { margin: 8px 0; }
  .actions { margin: 12px auto; width: 4in; }
  button { font: inherit; padding: 8px 14px; }
  @media print { .actions { display: none; } .sheet { margin: 0; border: 0; } @page { size: 4in 6in; margin: 0.15in; } }
</style></head><body>
<div class="actions"><button onclick="print()">Print / save as PDF</button></div>
<article class="sheet">
  <h1>${escapeHtml(d.kind === 'master' ? 'MASTER LABEL' : 'PALLET LABEL')}</h1>
  <h2>${escapeHtml(d.title || d.itemName || '')}</h2>
  ${d.barcodeSvg ? `<div class="bar">${d.barcodeSvg}</div>` : ''}
  <p class="sscc">(00) ${escapeHtml(d.sscc)}</p>
  <table>${rows}</table>
  ${kids ? `<p><b>Contains</b></p><ul>${kids}</ul>` : ''}
</article>
</body></html>`;
  }

  /**
   * The labels above are laid out in dots at 203 dpi. A 300 dpi printer (the
   * Zebra ZT421 comes in both) would print them at two thirds of the size, so
   * every position, font, line and barcode size is scaled to the printer.
   */
  function scaleZpl(zpl, dpi = 203) {
    const f = Number(dpi) / 203;
    if (!f || f === 1) return zpl;
    const n = (v) => Math.round(Number(v) * f);
    return zpl
      .replace(/\^PW(\d+)/g, (m, w) => `^PW${n(w)}`)
      .replace(/\^LL(\d+)/g, (m, l) => `^LL${n(l)}`)
      .replace(/\^FO(\d+),(\d+)/g, (m, x, y) => `^FO${n(x)},${n(y)}`)
      .replace(/\^A0N,(\d+),(\d+)/g, (m, h, w) => `^A0N,${n(h)},${n(w)}`)
      .replace(/\^GB(\d+),(\d+),(\d+)/g, (m, w, h, t) => `^GB${n(w)},${n(h)},${Math.max(1, n(t))}`)
      .replace(/\^BY(\d+)/g, (m, w) => `^BY${Math.max(1, Math.round(Number(w) * f))}`)
      .replace(/\^BCN,(\d+)/g, (m, h) => `^BCN,${n(h)}`);
  }

  /**
   * License-plate label. The plate id (PAL0000001, MASTER0000001, …) is the
   * barcode the floor scans. An SSCC is an optional second barcode.
   */
  function licenseLabel(d) {
    const kids = (d.children || []).slice(0, 8).map((c, i) => `^FO40,${820 + i * 32}^A0N,26,26^FD${clean(c.plate || c.sscc || c)}^FS`);
    const lines = [
      '^XA',
      '^CI28',
      '^PW812^LL1218',
      `^FO40,30^A0N,32,32^FD${clean(d.series === 'MASTER' || d.kind === 'master' ? 'MASTER LABEL' : 'PALLET LABEL')}^FS`,
      `^FO40,80^A0N,64,64^FD${clean(d.plate || d.title || '')}^FS`,
      d.itemName ? `^FO40,160^A0N,36,36^FD${clean(d.itemName)}^FS` : '',
      d.itemNo ? `^FO40,210^A0N,28,28^FDItem ${clean(d.itemNo)}   Qty ${clean(d.qty == null ? '' : d.qty)}^FS` : '',
      d.batch || d.expiry ? `^FO40,250^A0N,28,28^FDBatch ${clean(d.batch || '')}   Best before ${clean(d.expiry || '')}^FS` : '',
      d.location ? `^FO40,290^A0N,28,28^FDLocation ${clean(d.location)}^FS` : '',
      '^FO40,340^GB732,3,3^FS',
      `^FO40,370^BY3^BCN,160,Y,N,N^FD${clean(d.plate || d.title || '')}^FS`,
    ];
    if (d.sscc) {
      lines.push('^FO40,580^A0N,24,24^FDSSCC^FS', `^FO40,610^BY2^BCN,80,N,N,N^FD>;>800${clean(d.sscc)}^FS`, `^FO40,700^A0N,28,28^FD(00) ${clean(d.sscc)}^FS`);
    }
    if (kids.length) lines.push('^FO40,760^A0N,26,26^FDPAL under this MASTER^FS', ...kids);
    lines.push('^XZ');
    return lines.filter(Boolean).join('\n');
  }

  return { shippingLabel, palletLabel, masterLabel, licenseLabel, labelHtml, scaleZpl, escapeHtml };
});
