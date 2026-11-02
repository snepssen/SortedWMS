/*
 * One light/dark setting for every screen: Auto (follow the device), Light or
 * Dark, kept in this browser. Load it in <head> so a page never flashes the
 * wrong theme. It sets <html data-theme="light|dark">; each screen styles both.
 * A change on one screen reaches every other open screen at once, framed ones
 * included. Put <select data-theme-picker></select> where the choice belongs,
 * or SortedTheme.html() into markup drawn later.
 */
(function (root) {
  'use strict';
  const KEY = 'sorted.theme';
  const CHOICES = [['auto', 'Auto'], ['light', 'Light'], ['dark', 'Dark']];
  const mq = root.matchMedia ? root.matchMedia('(prefers-color-scheme: dark)') : null;

  function get() {
    let v = null;
    try { v = localStorage.getItem(KEY); } catch (e) { v = null; }
    return CHOICES.some(([id]) => id === v) ? v : 'auto';
  }

  function resolved() {
    const v = get();
    return v === 'auto' ? (mq && mq.matches ? 'dark' : 'light') : v;
  }

  function apply() {
    const t = resolved();
    const html = document.documentElement;
    html.dataset.theme = t;
    html.style.colorScheme = t;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta && document.body) meta.content = getComputedStyle(document.body).backgroundColor;
    for (const el of document.querySelectorAll('select[data-theme-picker]')) el.value = get();
  }

  function set(v) {
    try { localStorage.setItem(KEY, v); } catch (e) { /* storage off: this page only */ }
    apply();
  }

  function options() {
    return CHOICES.map(([id, label]) => `<option value="${id}"${id === get() ? ' selected' : ''}>${label}</option>`).join('');
  }

  /** A theme picker as markup, for screens that draw their header from script. */
  function html() {
    return `<select data-theme-picker aria-label="Theme" title="Theme">${options()}</select>`;
  }

  apply();
  if (mq && mq.addEventListener) mq.addEventListener('change', apply);
  root.addEventListener('storage', (e) => { if (e.key === KEY || e.key === null) apply(); });
  document.addEventListener('change', (e) => { if (e.target.matches && e.target.matches('select[data-theme-picker]')) set(e.target.value); });
  document.addEventListener('DOMContentLoaded', () => {
    for (const el of document.querySelectorAll('select[data-theme-picker]')) {
      if (!el.options.length) el.innerHTML = options();
      if (!el.getAttribute('aria-label')) el.setAttribute('aria-label', 'Theme');
    }
    apply();
  });

  root.SortedTheme = { get, set, resolved, html };
})(typeof self !== 'undefined' ? self : this);
