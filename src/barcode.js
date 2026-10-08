/*
 * Code 128 (set B) as SVG, for the command card the office prints. Shipping
 * and pallet labels don't need this: the label printer draws those from ZPL.
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

  /** The symbol values for `text` in set B: start, data, check, stop. */
  function encode(text) {
    const values = [START_B];
    for (const ch of String(text)) {
      const c = ch.charCodeAt(0);
      if (c < 32 || c > 126) throw new Error(`Code 128 B can't encode ${JSON.stringify(ch)}`);
      values.push(c - 32);
    }
    const check = values.reduce((sum, v, i) => sum + v * (i || 1), 0) % 103;
    return [...values, check, STOP];
  }

  /** Bars as 1s and spaces as 0s, one per module, without the quiet zones. */
  function modules(text) {
    let out = '';
    for (const v of encode(text)) {
      [...PATTERNS[v]].forEach((w, i) => { out += (i % 2 ? '0' : '1').repeat(Number(w)); });
    }
    return out;
  }

  /** An SVG of the barcode: `module` units per module, `height` units tall (unit: '' for px, or 'mm'), 10-module quiet zones. */
  function svg(text, { module = 2, height = 80, unit = '' } = {}) {
    const m = modules(text);
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

  return { encode, modules, svg };
});
