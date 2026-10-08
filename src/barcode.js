/*
 * Code 128 as SVG, for what the office prints on paper or shows on a screen:
 * the command card, and the demo kit's sample pallet and location labels.
 * GS1-128 (FNC1 first, FNC1 as the separator) for pallet labels; long digit
 * runs use set C so a label barcode stays short enough to scan. Labels on
 * the label printers don't need this: the printer draws those from ZPL.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SortedBarcode = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Bar/space widths of each symbol value 0–106, in modules.
  const PATTERNS = [
    '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
    '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
    '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
    '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
    '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
    '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
    '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
    '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
    '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
    '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
    '114131', '311141', '411131', '211412', '211214', '211232', '2331112',
  ];
  const START_B = 104;
  const STOP = 106;

  const START_C = 105;
  const CODE_B = 100; // switch to set B (from set C)
  const CODE_C = 99; // switch to set C (from set B)
  const FNC1 = 102;
  const GS = '\x1d'; // in the text, a GS1 separator: encoded as FNC1

  const isDigit = (ch) => ch >= '0' && ch <= '9';
  const digitRun = (t, i) => { let n = 0; while (i + n < t.length && isDigit(t[i + n])) n++; return n; };

  /**
   * The symbol values for `text`: start, data, check, stop. Plain text is set
   * B throughout (the command card). With { gs1: true } the symbol starts with
   * FNC1, a GS character in the text becomes FNC1, and runs of four or more
   * digits are packed in pairs (set C).
   */
  function encode(text, { gs1 = false } = {}) {
    const t = String(text);
    for (const ch of t) {
      const c = ch.charCodeAt(0);
      if (ch !== GS && (c < 32 || c > 126)) throw new Error(`Code 128 B can't encode ${JSON.stringify(ch)}`);
    }
    if (!gs1) {
      if (t.includes(GS)) throw new Error('A GS separator needs gs1: true');
      const values = [START_B, ...[...t].map((ch) => ch.charCodeAt(0) - 32)];
      return finish(values);
    }
    let set = digitRun(t, 0) >= 2 && digitRun(t, 0) % 2 === 0 ? 'C' : 'B';
    const values = [set === 'C' ? START_C : START_B, FNC1];
    let i = 0;
    while (i < t.length) {
      if (t[i] === GS) { values.push(FNC1); i++; continue; }
      const run = digitRun(t, i);
      if (set === 'C') {
        if (run >= 2) { values.push(Number(t.slice(i, i + 2))); i += 2; continue; }
        values.push(CODE_B); set = 'B'; continue;
      }
      // Set B: switch to C for a run of 4+ digits (an odd one keeps its first digit in B).
      if (run >= 4) {
        if (run % 2) { values.push(t.charCodeAt(i) - 32); i++; }
        values.push(CODE_C); set = 'C'; continue;
      }
      values.push(t.charCodeAt(i) - 32); i++;
    }
    return finish(values);
  }

  function finish(values) {
    const check = values.reduce((sum, v, i) => sum + v * (i || 1), 0) % 103;
    return [...values, check, STOP];
  }

  /** Bars as 1s and spaces as 0s, one per module, without the quiet zones. */
  function modules(text, opts) {
    let out = '';
    for (const v of encode(text, opts)) {
      [...PATTERNS[v]].forEach((w, i) => { out += (i % 2 ? '0' : '1').repeat(Number(w)); });
    }
    return out;
  }

  /** An SVG of the barcode: `module` units per module, `height` units tall (unit: '' for px, or 'mm'), 10-module quiet zones. */
  function svg(text, { module = 2, height = 80, unit = '', gs1 = false } = {}) {
    const m = modules(text, { gs1 });
    const quiet = 10;
    let x = quiet;
    let rects = '';
    for (let i = 0; i < m.length;) {
      let j = i;
      while (j < m.length && m[j] === m[i]) j++;
      if (m[i] === '1') rects += `<rect x="${x}" y="0" width="${j - i}" height="1"/>`;
      x += j - i;
      i = j;
    }
    const w = m.length + 2 * quiet;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${+(w * module).toFixed(2)}${unit}" height="${height}${unit}" viewBox="0 0 ${w} 1" preserveAspectRatio="none" shape-rendering="crispEdges"><rect width="${w}" height="1" fill="#fff"/><g fill="#000">${rects}</g></svg>`;
  }

  return { encode, modules, svg, GS };
});
