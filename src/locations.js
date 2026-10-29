/*
 * Location codes for any building: Cell > Aisle > Bay > Position > Height.
 * A level can be skipped. Each level is numbers, letters, letters-and-numbers,
 * or words. Colours and pictures are written out as text (Red, Blue).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SortedLocations = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const LEVELS = ['cell', 'aisle', 'bay', 'position', 'height'];
  const SCHEMES = ['number', 'letter', 'alphanumeric', 'word'];
  const MAX_CODES = 5000;

  function padNumber(n, pad) {
    const s = String(n);
    return pad ? s.padStart(pad, '0') : s;
  }

  function rangeError(level, message) {
    throw new Error(`${level}: ${message}`);
  }

  function tokens(level) {
    const key = level.key || 'level';
    if (level.skip) return [];
    if (!SCHEMES.includes(level.scheme)) rangeError(key, 'scheme is number, letter, alphanumeric or word');
    if (level.scheme === 'number') {
      const from = Number(level.from);
      const to = Number(level.to);
      const width = Number(level.pad) || 0;
      if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from || to - from > 500) rangeError(key, 'number range must be whole numbers, from <= to, at most 501 values');
      if (!Number.isInteger(width) || width < 0 || width > 6) rangeError(key, 'pad is 0 to 6');
      const out = [];
      for (let n = from; n <= to; n++) out.push(padNumber(n, width));
      return out;
    }
    if (level.scheme === 'letter') {
      const from = String(level.from || '').trim().toUpperCase();
      const to = String(level.to || '').trim().toUpperCase();
      if (!/^[A-Z]$/.test(from) || !/^[A-Z]$/.test(to) || from > to) rangeError(key, 'letter range is A to Z, from <= to');
      const out = [];
      for (let c = from.charCodeAt(0); c <= to.charCodeAt(0); c++) out.push(String.fromCharCode(c));
      return out;
    }
    if (level.scheme === 'alphanumeric') {
      const letters = tokens({ key, scheme: 'letter', from: level.letterFrom, to: level.letterTo });
      const numbers = tokens({ key, scheme: 'number', from: level.numberFrom, to: level.numberTo, pad: level.pad || 0 });
      const out = [];
      for (const letter of letters) for (const num of numbers) out.push(letter + num);
      return out;
    }
    const words = (Array.isArray(level.words) ? level.words : String(level.words || '').split(/[,|\n]/)).map((w) => String(w).trim()).filter(Boolean);
    if (!words.length || words.length > 100) rangeError(key, 'give one or more words, at most 100');
    if (words.some((w) => !/^[A-Za-z0-9][A-Za-z0-9 ]{0,24}$/.test(w))) rangeError(key, 'a word is letters, digits and spaces');
    return words.map((w) => w.replace(/\s+/g, ''));
  }

  function activeLevels(plan) {
    const levels = plan && Array.isArray(plan.levels) ? plan.levels : [];
    const seen = new Set();
    const active = [];
    for (const level of levels) {
      if (!level || level.skip) continue;
      if (!LEVELS.includes(level.key)) throw new Error(`Unknown level ${level.key}. Use ${LEVELS.join(', ')}`);
      if (seen.has(level.key)) throw new Error(`${level.key} is listed twice`);
      seen.add(level.key);
      active.push(level);
    }
    if (!active.length) throw new Error('Choose at least one level. A home warehouse can use just Bay and Height.');
    return active;
  }

  /**
   * Every code the plan would create, plus a short sample for the wizard preview.
   * `sampleCode` is the first code, which the worked examples assert exactly.
   */
  function expand(plan, { limit = 24 } = {}) {
    const separator = plan.separator == null ? '-' : String(plan.separator);
    if (separator !== '-' && separator !== '/') throw new Error('Separator is - or /');
    const active = activeLevels(plan);
    let combos = [[]];
    for (const level of active) {
      const parts = tokens(level);
      const next = [];
      for (const row of combos) {
        for (const part of parts) {
          next.push(row.concat(part));
          if (next.length > MAX_CODES) throw new Error(`That range would create more than ${MAX_CODES} locations. Narrow it.`);
        }
      }
      combos = next;
    }
    const codes = combos.map((parts) => parts.join(separator));
    return {
      total: codes.length,
      codes,
      sample: codes.slice(0, limit),
      sampleCode: codes[0] || '',
      levels: active.map((level) => level.key),
      separator,
    };
  }

  const EXAMPLES = {
    numbers: {
      id: 'numbers',
      title: 'Numbers only',
      blurb: 'A distribution centre that numbers every step.',
      illustrates: '01-03-12-2-04',
      plan: {
        separator: '-',
        levels: [
          { key: 'cell', scheme: 'number', from: 1, to: 1, pad: 2 },
          { key: 'aisle', scheme: 'number', from: 3, to: 3, pad: 2 },
          { key: 'bay', scheme: 'number', from: 12, to: 12, pad: 2 },
          { key: 'position', scheme: 'number', from: 2, to: 2, pad: 1 },
          { key: 'height', scheme: 'number', from: 4, to: 4, pad: 2 },
        ],
      },
    },
    mixed: {
      id: 'mixed',
      title: 'Letters and numbers',
      blurb: 'A cell letter, a numbered aisle, a bay like B12, a position and a height letter.',
      illustrates: 'A-03-B12-2-D',
      plan: {
        separator: '-',
        levels: [
          { key: 'cell', scheme: 'letter', from: 'A', to: 'A' },
          { key: 'aisle', scheme: 'number', from: 3, to: 3, pad: 2 },
          { key: 'bay', scheme: 'alphanumeric', letterFrom: 'B', letterTo: 'B', numberFrom: 12, numberTo: 12, pad: 0 },
          { key: 'position', scheme: 'number', from: 2, to: 2, pad: 0 },
          { key: 'height', scheme: 'letter', from: 'D', to: 'D' },
        ],
      },
    },
    words: {
      id: 'words',
      title: 'Words',
      blurb: 'A garage, a side, a shelf, a box and a height. Colours are words too: Red, Blue.',
      illustrates: 'Garage-Left-Shelf3-Box2-Top',
      plan: {
        separator: '-',
        levels: [
          { key: 'cell', scheme: 'word', words: ['Garage'] },
          { key: 'aisle', scheme: 'word', words: ['Left'] },
          { key: 'bay', scheme: 'word', words: ['Shelf3'] },
          { key: 'position', scheme: 'word', words: ['Box2'] },
          { key: 'height', scheme: 'word', words: ['Top'] },
        ],
      },
    },
    home: {
      id: 'home',
      title: 'Bay and height only',
      blurb: 'Skip the levels a small place does not have.',
      illustrates: 'Shelf-Top',
      plan: {
        separator: '-',
        levels: [
          { key: 'cell', skip: true },
          { key: 'aisle', skip: true },
          { key: 'bay', scheme: 'word', words: ['Shelf'] },
          { key: 'position', skip: true },
          { key: 'height', scheme: 'word', words: ['Top'] },
        ],
      },
    },
  };

  return { LEVELS, SCHEMES, EXAMPLES, expand, tokens, MAX_CODES };
});
