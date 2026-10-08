/*
 * GS1 barcode helpers: read GS1-128 pallet labels, check SSCC/GTIN check
 * digits, build label strings. Runs in the browser (window.GS1) and Node.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GS1 = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const GS = '\x1d'; // FNC1 separator as sent by most scanners

  // Application identifiers used on pallet labels in food logistics.
  const AIS = {
    '00': { key: 'sscc', len: 18 },
    '01': { key: 'gtin', len: 14 },
    '02': { key: 'gtin', len: 14 }, // GTIN of the trade items on the pallet
    '10': { key: 'batch', max: 20 },
    '11': { key: 'produced', len: 6, date: true },
    '15': { key: 'expiry', len: 6, date: true }, // best before
    '17': { key: 'expiry', len: 6, date: true }, // use by
    '37': { key: 'qty', max: 8 },
  };

  function checkDigit(body) {
    let sum = 0;
    for (let i = body.length - 1, w = 3; i >= 0; i--, w = w === 3 ? 1 : 3) sum += Number(body[i]) * w;
    return (10 - (sum % 10)) % 10;
  }

  function isValidSscc(s) {
    return /^\d{18}$/.test(s) && checkDigit(s.slice(0, 17)) === Number(s[17]);
  }

  function isValidGtin(s) {
    return /^(\d{8}|\d{12,14})$/.test(s) && checkDigit(s.slice(0, -1)) === Number(s.slice(-1));
  }

  // Normalise any GTIN length to 14 digits.
  function gtin14(s) {
    return String(s).padStart(14, '0');
  }

  // YYMMDD -> YYYY-MM-DD. Day 00 means the last day of the month (GS1 rule).
  function yymmdd(s) {
    const yy = Number(s.slice(0, 2));
    const mm = Number(s.slice(2, 4));
    let dd = Number(s.slice(4, 6));
    const yyyy = yy >= 50 ? 1900 + yy : 2000 + yy;
    if (mm < 1 || mm > 12) return null;
    const last = new Date(Date.UTC(yyyy, mm, 0)).getUTCDate();
    if (dd === 0) dd = last;
    if (dd > last) return null;
    return `${yyyy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
  }

  function toYymmdd(iso) {
    return iso.slice(2, 4) + iso.slice(5, 7) + iso.slice(8, 10);
  }

  function stripSymbology(s) {
    return s.replace(/^\][A-Za-z]\d/, '');
  }

  /**
   * Parse a GS1 element string. Accepts the bracketed human-readable form
   * "(00)…(10)…" and the raw scanner form with FNC1 separators.
   * Returns { sscc, gtin, batch, expiry, qty, produced } (only what's present),
   * or null when the input is not a GS1 string.
   */
  function parse(raw) {
    let s = stripSymbology(String(raw).trim());
    const hadPrefix = s !== String(raw).trim();
    const out = {};

    const put = (ai, value) => {
      const def = AIS[ai];
      if (!def) return false;
      if (def.len && value.length !== def.len) return false;
      if (def.max && (value.length < 1 || value.length > def.max)) return false;
      if (def.date) {
        const d = yymmdd(value);
        if (!d) return false;
        out[def.key] = d;
      } else if (def.key === 'qty') {
        if (!/^\d+$/.test(value)) return false;
        out.qty = Number(value);
      } else {
        out[def.key] = value;
      }
      return true;
    };

    if (s.startsWith('(')) {
      const re = /\((\d{2,4})\)([^(]*)/g;
      let m;
      let consumed = 0;
      while ((m = re.exec(s))) {
        if (!put(m[1], m[2].trim())) return null;
        consumed += m[0].length;
      }
      return consumed === s.length && Object.keys(out).length ? out : null;
    }

    // Raw form: only accept it when it clearly is GS1 (scanner prefix, FNC1
    // separators, an SSCC/GTIN at the start, or at least two elements),
    // so a plain batch number like "10023" is never mistaken for AI 10.
    if (!/^\d{2}/.test(s)) return null;
    const strong = hadPrefix || s.includes(GS) || (/^\d{16,}/.test(s) && /^(00|01|02)/.test(s));
    let count = 0;
    while (s.length) {
      if (s[0] === GS) { s = s.slice(1); continue; }
      const ai = AIS[s.slice(0, 2)] ? s.slice(0, 2) : null;
      if (!ai) return null;
      const def = AIS[ai];
      s = s.slice(2);
      let value;
      if (def.len) {
        value = s.slice(0, def.len);
        s = s.slice(def.len);
      } else {
        const end = s.indexOf(GS);
        value = end === -1 ? s : s.slice(0, end);
        s = end === -1 ? '' : s.slice(end + 1);
      }
      if (!put(ai, value)) return null;
      count++;
    }
    return count && (strong || count >= 2) ? out : null;
  }

  /** Human-readable label line, e.g. "(02)…(17)261031(10)L2614(37)96". */
  function hri(fields) {
    const parts = [];
    if (fields.sscc) parts.push(`(00)${fields.sscc}`);
    if (fields.gtin) parts.push(`(02)${gtin14(fields.gtin)}`);
    if (fields.expiry) parts.push(`(15)${toYymmdd(fields.expiry)}`);
    if (fields.batch) parts.push(`(10)${fields.batch}`);
    if (fields.qty) parts.push(`(37)${fields.qty}`);
    return parts.join('');
  }

  /** Build an SSCC: extension digit + company prefix + serial + check digit. */
  function makeSscc(extension, prefix, serial) {
    const body = `${extension}${prefix}${String(serial).padStart(16 - prefix.length, '0')}`;
    return body + checkDigit(body);
  }

  function makeGtin13(prefix, ref) {
    const body = `${prefix}${String(ref).padStart(12 - prefix.length, '0')}`;
    return body + checkDigit(body);
  }

  return { GS, parse, hri, checkDigit, isValidSscc, isValidGtin, gtin14, yymmdd, toYymmdd, makeSscc, makeGtin13 };
});
