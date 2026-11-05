/*
 * Languages. English is the default. Dutch (nl) is the second language.
 * A user's language wins; otherwise the warehouse default; otherwise English.
 * Numbers, dates and money follow that language. Dates use the warehouse timezone.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SortedI18n = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const catalogs = {};

  function load(lang) {
    if (catalogs[lang]) return catalogs[lang];
    if (typeof require === 'function') {
      try { catalogs[lang] = require(`../locales/${lang}`); } catch (e) { catalogs[lang] = null; }
    } else if (typeof globalThis !== 'undefined' && globalThis.SortedLocales) {
      catalogs[lang] = globalThis.SortedLocales[lang] || null;
    }
    return catalogs[lang];
  }

  function languages() {
    return ['en', 'nl'];
  }

  function has(lang) {
    return languages().includes(String(lang || '').toLowerCase());
  }

  /** User language, then the warehouse default, then English. */
  function choose(userLang, warehouseLang) {
    const user = String(userLang || '').trim().toLowerCase();
    const warehouse = String(warehouseLang || '').trim().toLowerCase();
    if (has(user)) return user;
    if (has(warehouse)) return warehouse;
    return 'en';
  }

  function lookup(lang, key) {
    const primary = load(lang) || {};
    if (Object.prototype.hasOwnProperty.call(primary, key) && primary[key] !== '') return primary[key];
    const en = load('en') || {};
    if (Object.prototype.hasOwnProperty.call(en, key)) return en[key];
    return null;
  }

  function t(lang, key, vars) {
    const found = lookup(lang, key);
    let text = found == null ? String(key) : String(found);
    if (vars) {
      for (const [name, value] of Object.entries(vars)) text = text.split(`{${name}}`).join(value == null ? '' : String(value));
    }
    return text;
  }

  /** Keys present in English and missing or blank in `lang`. */
  function missing(lang) {
    const en = load('en') || {};
    const other = load(lang) || {};
    return Object.keys(en).filter((key) => !Object.prototype.hasOwnProperty.call(other, key) || other[key] === '' || other[key] == null).sort();
  }

  function localeTag(lang) {
    return lang === 'nl' ? 'nl-NL' : 'en-GB';
  }

  function formatNumber(lang, value, options) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '';
    return new Intl.NumberFormat(localeTag(lang), options).format(n);
  }

  function formatDate(lang, ms, timeZone, options) {
    const date = ms instanceof Date ? ms : new Date(ms);
    if (Number.isNaN(date.getTime())) return '';
    return new Intl.DateTimeFormat(localeTag(lang), { timeZone: timeZone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit', ...options }).format(date);
  }

  function formatMoney(lang, value, currency) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '';
    const code = currency || 'EUR';
    try {
      return new Intl.NumberFormat(localeTag(lang), { style: 'currency', currency: code }).format(n);
    } catch (e) {
      return `${formatNumber(lang, n, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${code}`;
    }
  }

  /** Drop accents so a terminal that only speaks ASCII still shows the words. */
  function fold(text) {
    return String(text == null ? '' : text)
      .replace(/ß/g, 'ss')
      .replace(/æ/g, 'ae').replace(/Æ/g, 'AE')
      .replace(/œ/g, 'oe').replace(/Œ/g, 'OE')
      .replace(/ø/g, 'o').replace(/Ø/g, 'O')
      .replace(/€/g, 'EUR')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
  }

  /**
   * Replace text nodes and a few attributes whose whole text is a catalog key
   * (the English sentence). Already translated text is left as it is.
   */
  function apply(root, lang) {
    if (!root || typeof document === 'undefined') return;
    const en = load('en') || {};
    const want = has(lang) ? lang : 'en';
    const visit = (node) => {
      if (node.nodeType === 3) {
        const raw = node.nodeValue;
        const trimmed = raw.trim();
        if (trimmed && Object.prototype.hasOwnProperty.call(en, trimmed) && lookup(want, trimmed) !== trimmed) {
          node.nodeValue = raw.replace(trimmed, t(want, trimmed));
        }
        return;
      }
      if (node.nodeType !== 1 || node.tagName === 'SCRIPT' || node.tagName === 'STYLE') return;
      for (const attr of ['placeholder', 'title', 'aria-label']) {
        const value = node.getAttribute && node.getAttribute(attr);
        if (value && Object.prototype.hasOwnProperty.call(en, value)) node.setAttribute(attr, t(want, value));
      }
      if (node.dataset && node.dataset.i18n) node.textContent = t(want, node.dataset.i18n);
      for (const child of [...node.childNodes]) visit(child);
    };
    visit(root);
    if (root.ownerDocument && root.ownerDocument.documentElement) root.ownerDocument.documentElement.lang = want === 'nl' ? 'nl' : 'en';
  }

  return { t, missing, choose, languages, has, formatNumber, formatDate, formatMoney, fold, apply, localeTag, load };
});
