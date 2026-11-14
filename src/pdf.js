/*
 * A small PDF writer. A4 pages, one built-in font, no libraries.
 * Text is WinAnsi: characters outside Latin-1 become a question mark.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SortedPdf = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const A4 = [595, 842];

  function pdfString(text) {
    let out = '';
    for (const ch of String(text == null ? '' : text)) {
      const c = ch.codePointAt(0);
      if (c === 0x28 || c === 0x29 || c === 0x5c) out += '\\' + ch;
      else if (c >= 32 && c <= 126) out += ch;
      else if (c >= 160 && c <= 255) out += '\\' + c.toString(8).padStart(3, '0');
      else if (c === 10) out += '\\n';
      else out += '?';
    }
    return `(${out})`;
  }

  /** One A4 page. `lines` are { text, size, gap }. y starts near the top. */
  function pageStream(lines) {
    const parts = ['BT'];
    let y = 800;
    let size = 11;
    parts.push('/F1 11 Tf');
    for (const line of lines) {
      const next = line.size || 11;
      const gap = line.gap == null ? next + 4 : line.gap;
      if (y - gap < 48) break;
      if (next !== size) {
        size = next;
        parts.push(`/F1 ${size} Tf`);
      }
      y -= gap;
      parts.push(`1 0 0 1 48 ${y} Tm ${pdfString(line.text)} Tj`);
    }
    parts.push('ET');
    return parts.join('\n');
  }

  /**
   * pages: array of line arrays. Returns a Buffer (or Uint8Array in the browser).
   */
  function document(pages) {
    const list = pages && pages.length ? pages : [[{ text: '' }]];
    const objects = [];
    const add = (body) => { objects.push(String(body)); return objects.length; };
    const pageIds = [];
    const fontId = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
    for (const lines of list) {
      const stream = pageStream(lines);
      const contentId = add(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
      pageIds.push(add(`<< /Type /Page /Parent PAGES /MediaBox [0 0 ${A4[0]} ${A4[1]}] /Contents ${contentId} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> >>`));
    }
    const pagesId = add(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`);
    const catalogId = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
    const body = objects.map((obj, i) => obj.replace('Parent PAGES', `Parent ${pagesId} 0 R`).replace(/^/, `${i + 1} 0 obj\n`) + '\nendobj\n');
    let pdf = '%PDF-1.4\n';
    const offsets = [0];
    for (const obj of body) {
      offsets.push(Buffer.byteLength(pdf));
      pdf += obj;
    }
    const xrefAt = Buffer.byteLength(pdf);
    pdf += `xref\n0 ${objects.length + 1}\n`;
    pdf += '0000000000 65535 f \n';
    for (let i = 1; i <= objects.length; i++) pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
    pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
    return Buffer.from(pdf);
  }

  /** Split lines into pages of `per` lines. */
  function paginate(lines, per = 42) {
    const pages = [];
    for (let i = 0; i < lines.length; i += per) pages.push(lines.slice(i, i + per));
    return pages.length ? pages : [[]];
  }

  return { document, paginate, A4, pdfString };
});
