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
      '^XZ',
    ].join('\n');
  }

  return { shippingLabel, palletLabel };
});
