/*
 * Location codes for any building: Cell > Aisle > Bay > Position > Height.
 * A level can be skipped. Each level is numbers, letters, letters-and-numbers,
 * or words. Colours and pictures are written out as text (Red, Blue).
 * The guided wizard reads the scheme from what the first one is called.
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
      const prefix = level.prefix == null ? '' : String(level.prefix).replace(/\s+/g, '');
      if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from || to - from > 500) rangeError(key, 'number range must be whole numbers, from <= to, at most 501 values');
      if (!Number.isInteger(width) || width < 0 || width > 6) rangeError(key, 'pad is 0 to 6');
      if (prefix && !/^[A-Za-z][A-Za-z0-9]{0,11}$/.test(prefix)) rangeError(key, 'a prefix starts with a letter and has letters and digits');
      const out = [];
      for (let n = from; n <= to; n++) out.push(prefix + padNumber(n, width));
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

  /*
   * The guided wizard asks "how many?" and "what do you want to call it?"
   * and works out the scheme from the first name, so nobody picks one:
   *   (empty)        1, 2, 3   (padded to the widest number: 01..12)
   *   01             01, 02, 03
   *   7              7, 8, 9
   *   A              A, B, C
   *   R1 / Shelf 01  R1, R2 / Shelf01, Shelf02
   *   Bin            Bin (one) or Bin1, Bin2 (more than one)
   *   Left, Right    every name written out, one per count
   * One of something with no name is left out of the code.
   */
  const GUIDED_STEPS = ['sections', 'aisles', 'bays', 'positions', 'levels'];
  const GUIDED_KEYS = { sections: 'cell', aisles: 'aisle', bays: 'bay', positions: 'position', levels: 'height' };
  const SECTION_TYPES = {
    rack: { kind: 'rack', label: 'Rack', capacity: { heightMm: 1800, widthMm: 1000, depthMm: 1200, maxWeightKg: 1000 } },
    shelf: { kind: 'bin', label: 'Shelf', capacity: { heightMm: 400, widthMm: 600, depthMm: 400, maxWeightKg: 25 } },
  };

  function seriesFromName(name, count, key = 'level') {
    const n = Number(count);
    if (!Number.isInteger(n) || n < 1 || n > 501) rangeError(key, 'how many is a whole number from 1 to 501');
    const text = String(name == null ? '' : name).trim();
    if (!text) {
      if (n === 1) return { key, skip: true };
      return { key, scheme: 'number', from: 1, to: n, pad: String(n).length > 1 ? String(n).length : 0 };
    }
    if (/[,\n|]/.test(text)) {
      const words = text.split(/[,\n|]/).map((w) => w.trim()).filter(Boolean);
      if (words.length !== n) rangeError(key, `you have ${n} but named ${words.length}. Give one name each, or name only the first`);
      if (new Set(words.map((w) => w.replace(/\s+/g, '').toUpperCase())).size !== words.length) rangeError(key, 'two names are the same');
      return { key, scheme: 'word', words };
    }
    let m = /^(\d+)$/.exec(text);
    if (m) {
      const from = Number(m[1]);
      return { key, scheme: 'number', from, to: from + n - 1, pad: m[1].length > 1 ? Math.max(m[1].length, String(from + n - 1).length) : 0 };
    }
    if (/^[A-Za-z]$/.test(text)) {
      const from = text.toUpperCase();
      const last = from.charCodeAt(0) + n - 1;
      if (last > 90) rangeError(key, `letters run out at Z. Starting at ${from} gives ${90 - from.charCodeAt(0) + 1}. Try A1 or a number instead`);
      return { key, scheme: 'letter', from, to: String.fromCharCode(last) };
    }
    m = /^([A-Za-z][A-Za-z ]*?)\s*(\d+)$/.exec(text);
    if (m) {
      const from = Number(m[2]);
      return { key, scheme: 'number', prefix: m[1].replace(/\s+/g, ''), from, to: from + n - 1, pad: m[2].length > 1 ? m[2].length : 0 };
    }
    if (/^[A-Za-z][A-Za-z ]{0,11}$/.test(text)) {
      if (n === 1) return { key, scheme: 'word', words: [text] };
      return { key, scheme: 'number', prefix: text.replace(/\s+/g, ''), from: 1, to: n, pad: String(n).length > 1 ? String(n).length : 0 };
    }
    rangeError(key, 'a name is a number (1, 01), a letter (A), a word with a number (R1, Shelf 1), or names split by commas');
  }

  function answerOf(step, answer) {
    const a = answer || {};
    return seriesFromName(a.name, a.count == null || a.count === '' ? 1 : a.count, step);
  }

  /**
   * Turn the wizard's answers into one plan per section.
   * answers: { sections: {count, name}, layouts: [{ type, aisles, bays, positions, levels }] }
   * One layout per section; a missing layout copies the one before it.
   */
  function guided(answers, { limit = 24 } = {}) {
    const a = answers || {};
    const separator = a.separator == null ? '-' : String(a.separator);
    const sectionSeries = answerOf('sections', a.sections);
    const names = sectionSeries.skip ? [null] : tokens(sectionSeries);
    const layouts = Array.isArray(a.layouts) ? a.layouts : [];
    if (!layouts.length) throw new Error('Describe the first section: rack or shelf, aisles, bays, positions and levels');
    const plans = [];
    const codes = [];
    const seen = new Set();
    let previous = null;
    names.forEach((section, i) => {
      const layout = layouts[i] || previous;
      previous = layout;
      const type = SECTION_TYPES[layout.type] ? layout.type : 'rack';
      const where = section == null ? 'The building' : (/^\d+$/.test(section) ? `Section ${section}` : section);
      const levels = [section == null ? { key: 'cell', skip: true } : { key: 'cell', scheme: 'word', words: [section] }];
      for (const step of GUIDED_STEPS.slice(1)) {
        try { levels.push({ ...answerOf(step, layout[step]), key: GUIDED_KEYS[step] }); }
        catch (e) { throw new Error(`${where}: ${e.message}`); }
      }
      const plan = { separator, levels };
      let built;
      try { built = expand(plan, { limit }); }
      catch (e) {
        if (/at least one level/.test(e.message)) throw new Error(`${where}: name at least one thing, or give more than one of something`);
        throw new Error(`${where}: ${e.message}`);
      }
      for (const code of built.codes) {
        if (seen.has(code.toUpperCase())) throw new Error(`${code} would be created twice. Give each section its own name`);
        seen.add(code.toUpperCase());
        codes.push(code);
      }
      if (codes.length > MAX_CODES) throw new Error(`That would create more than ${MAX_CODES} locations. Narrow it.`);
      const capacity = { ...SECTION_TYPES[type].capacity, ...(layout.capacity || {}) };
      plans.push({ section, type, kind: SECTION_TYPES[type].kind, capacity, plan, total: built.total, sampleCode: built.sampleCode, lastCode: built.codes[built.codes.length - 1] });
    });
    return { total: codes.length, codes, sample: codes.slice(0, limit), sampleCode: codes[0] || '', plans, separator };
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

  return { LEVELS, SCHEMES, EXAMPLES, expand, tokens, MAX_CODES, GUIDED_STEPS, SECTION_TYPES, seriesFromName, guided };
});
