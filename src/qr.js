/*
 * QR codes, byte mode, versions 1 to 5, error correction L.
 * Public domain algorithm (ISO/IEC 18004). No dependencies.
 * Enough for a short local URL.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SortedQr = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const ECC = { 1: [19, 7], 2: [34, 10], 3: [55, 15], 4: [80, 20], 5: [108, 26] };
  const ALIGN = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30] };
  const FORMAT_GEN = 0x537;
  const FORMAT_MASK = 0x5412;

  const EXP = new Uint8Array(512);
  const LOG = new Uint8Array(256);
  (function gf() {
    let x = 1;
    for (let i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  })();

  function mul(a, b) {
    if (!a || !b) return 0;
    return EXP[LOG[a] + LOG[b]];
  }

  function rs(data, nsym) {
    let gen = [1];
    for (let i = 0; i < nsym; i++) {
      const next = new Array(gen.length + 1).fill(0);
      for (let j = 0; j < gen.length; j++) {
        next[j] ^= gen[j];
        next[j + 1] ^= mul(gen[j], EXP[i]);
      }
      gen = next;
    }
    const out = data.concat(new Array(nsym).fill(0));
    for (let i = 0; i < data.length; i++) {
      const coef = out[i];
      if (!coef) continue;
      for (let j = 0; j < gen.length; j++) out[i + j] ^= mul(gen[j], coef);
    }
    return out.slice(data.length);
  }

  function bytesOf(text) {
    const s = String(text);
    const out = [];
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c > 255) throw new Error('The QR text is ASCII');
      out.push(c);
    }
    return out;
  }

  function chooseVersion(len) {
    for (let v = 1; v <= 5; v++) {
      const data = ECC[v][0];
      const bits = data * 8 - 4 - 8;
      if (Math.floor(bits / 8) >= len) return v;
    }
    throw new Error('That text is too long for this QR code');
  }

  function dataCodewords(payload, version) {
    const [n] = ECC[version];
    const bits = [];
    const push = (value, len) => { for (let i = len - 1; i >= 0; i--) bits.push((value >> i) & 1); };
    push(0b0100, 4);
    push(payload.length, 8);
    for (const b of payload) push(b, 8);
    const cap = n * 8;
    for (let i = 0; i < 4 && bits.length < cap; i++) bits.push(0);
    while (bits.length % 8) bits.push(0);
    const bytes = [];
    for (let i = 0; i < bits.length; i += 8) {
      let v = 0;
      for (let b = 0; b < 8; b++) v = (v << 1) | bits[i + b];
      bytes.push(v);
    }
    for (let pad = 0; bytes.length < n; pad++) bytes.push(pad % 2 ? 0x11 : 0xec);
    return bytes;
  }

  function formatBits(mask) {
    const data = (0b01 << 3) | mask; // ECC L
    let rem = data << 10;
    for (let i = 14; i >= 10; i--) if ((rem >> i) & 1) rem ^= FORMAT_GEN << (i - 10);
    return ((data << 10) | rem) ^ FORMAT_MASK;
  }

  function inFinder(size, r, c) {
    const boxes = [[0, 0], [0, size - 7], [size - 7, 0]];
    return boxes.some(([y, x]) => r >= y && r < y + 7 && c >= x && c < x + 7);
  }

  function inAlign(version, r, c) {
    const pos = ALIGN[version];
    for (const y of pos) for (const x of pos) {
      if (inFinder(21 + 4 * (version - 1), y - 2, x - 2) || inFinder(21 + 4 * (version - 1), y - 2, x + 2)) {
        if ((r >= y - 2 && r <= y + 2 && c >= x - 2 && c <= x + 2) && (y < 8 || x < 8)) continue;
      }
      if (Math.abs(r - y) <= 2 && Math.abs(c - x) <= 2) {
        if (y <= 8 && x <= 8) continue;
        if (y <= 8 && x >= 21 + 4 * (version - 1) - 8) continue;
        if (x <= 8 && y >= 21 + 4 * (version - 1) - 8) continue;
        return true;
      }
    }
    return false;
  }

  function reserved(version, r, c) {
    const size = 21 + 4 * (version - 1);
    if (r < 0 || c < 0 || r >= size || c >= size) return true;
    if (r <= 8 && c <= 8) return true; // finder, separator, format
    if (r <= 8 && c >= size - 8) return true;
    if (c <= 8 && r >= size - 8) return true;
    if (r === 6 || c === 6) return true; // timing
    if (inAlign(version, r, c)) return true;
    return false;
  }

  function paintFunction(version) {
    const size = 21 + 4 * (version - 1);
    const m = Array.from({ length: size }, () => Array(size).fill(0));
    const mark = (r, c) => { if (r >= 0 && c >= 0 && r < size && c < size) m[r][c] = 1; };
    const finder = (y, x) => {
      for (let r = 0; r < 7; r++) for (let c = 0; c < 7; c++) {
        const edge = r === 0 || r === 6 || c === 0 || c === 6;
        const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        if (edge || core) mark(y + r, x + c);
      }
    };
    finder(0, 0); finder(0, size - 7); finder(size - 7, 0);
    for (let i = 8; i < size - 8; i++) if (i % 2 === 0) { mark(6, i); mark(i, 6); }
    for (const y of ALIGN[version]) for (const x of ALIGN[version]) {
      if ((y < 9 && x < 9) || (y < 9 && x > size - 10) || (x < 9 && y > size - 10)) continue;
      for (let r = -2; r <= 2; r++) for (let c = -2; c <= 2; c++) {
        if (Math.max(Math.abs(r), Math.abs(c)) !== 1) mark(y + r, x + c);
      }
    }
    mark(4 * version + 9, 8);
    return m;
  }

  function placeData(version, codewords, mask) {
    const size = 21 + 4 * (version - 1);
    const m = paintFunction(version);
    const bits = [];
    for (const byte of codewords) for (let i = 7; i >= 0; i--) bits.push((byte >> i) & 1);
    let i = 0;
    let upward = true;
    for (let col = size - 1; col > 0; col -= 2) {
      if (col === 6) col--;
      for (let step = 0; step < size; step++) {
        const r = upward ? size - 1 - step : step;
        for (const c of [col, col - 1]) {
          if (reserved(version, r, c)) continue;
          let bit = i < bits.length ? bits[i++] : 0;
          const flip = [((r + c) % 2) === 0, r % 2 === 0, c % 3 === 0, (r + c) % 3 === 0, (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0, ((r * c) % 2 + (r * c) % 3) === 0, (((r * c) % 2 + (r * c) % 3) % 2) === 0, (((r + c) % 2 + (r * c) % 3) % 2) === 0][mask];
          if (flip) bit ^= 1;
          m[r][c] = bit;
        }
      }
      upward = !upward;
    }
    const fmt = formatBits(mask);
    const coords = [];
    for (let i = 0; i < 8; i++) coords.push([8, i < 6 ? i : i + 1]);
    for (let i = 0; i < 8; i++) coords.push([i < 6 ? i : i + 1, 8]);
    for (let i = 0; i < 15; i++) {
      const bit = (fmt >> i) & 1;
      m[coords[i][0]][coords[i][1]] = bit;
    }
    const other = [];
    for (let i = 0; i < 7; i++) other.push([size - 1 - i, 8]);
    for (let i = 0; i < 8; i++) other.push([8, size - 8 + i]);
    for (let i = 0; i < 15; i++) m[other[i][0]][other[i][1]] = (fmt >> (14 - i)) & 1;
    return m;
  }

  function penalty(m) {
    const n = m.length;
    let score = 0;
    const rowRun = (r, c, dr, dc) => {
      const bit = m[r][c];
      let k = 0;
      while (r + dr * k >= 0 && c + dc * k >= 0 && r + dr * k < n && c + dc * k < n && m[r + dr * k][c + dc * k] === bit) k++;
      return k;
    };
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
      if (c + 5 <= n && rowRun(r, c, 0, 1) === 5) score += 3;
      if (r + 5 <= n && rowRun(r, c, 1, 0) === 5) score += 3;
    }
    let dark = 0;
    for (const row of m) for (const bit of row) dark += bit;
    score += Math.floor(Math.abs(dark / (n * n) - 0.5) * 20) * 10;
    return score;
  }

  function encode(text) {
    const payload = bytesOf(text);
    const version = chooseVersion(payload.length);
    const data = dataCodewords(payload, version);
    const ecc = rs(data, ECC[version][1]);
    const codewords = data.concat(ecc);
    let best = null;
    let bestScore = Infinity;
    for (let mask = 0; mask < 8; mask++) {
      const matrix = placeData(version, codewords, mask);
      const score = penalty(matrix);
      if (score < bestScore) { bestScore = score; best = { matrix, mask, version }; }
    }
    return best;
  }

  function svg(text, module = 4) {
    const { matrix } = encode(text);
    const n = matrix.length;
    const quiet = 4;
    const size = (n + quiet * 2) * module;
    let rects = '';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (matrix[r][c]) {
      rects += `<rect x="${(c + quiet) * module}" y="${(r + quiet) * module}" width="${module}" height="${module}"/>`;
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/>${rects}</svg>`;
  }

  /** Read the data bytes back out of a matrix produced here. Used by the tests. */
  function readData(matrix, version, mask) {
    const size = matrix.length;
    const bits = [];
    let upward = true;
    for (let col = size - 1; col > 0; col -= 2) {
      if (col === 6) col--;
      for (let step = 0; step < size; step++) {
        const r = upward ? size - 1 - step : step;
        for (const c of [col, col - 1]) {
          if (reserved(version, r, c)) continue;
          let bit = matrix[r][c];
          const flip = [((r + c) % 2) === 0, r % 2 === 0, c % 3 === 0, (r + c) % 3 === 0, (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0, ((r * c) % 2 + (r * c) % 3) === 0, (((r * c) % 2 + (r * c) % 3) % 2) === 0, (((r + c) % 2 + (r * c) % 3) % 2) === 0][mask];
          if (flip) bit ^= 1;
          bits.push(bit);
        }
      }
      upward = !upward;
    }
    const bytes = [];
    for (let i = 0; i + 8 <= bits.length && bytes.length < ECC[version][0]; i += 8) {
      let v = 0;
      for (let b = 0; b < 8; b++) v = (v << 1) | bits[i + b];
      bytes.push(v);
    }
    return bytes;
  }

  return { encode, svg, readData, chooseVersion };
});
