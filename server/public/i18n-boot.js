/*
 * After the locale files and src/i18n.js. Picks the signed-in user's
 * language, or the warehouse default, and keeps replacing English sentences
 * as screens redraw.
 */
(function () {
  'use strict';
  const I = window.SortedI18n;
  if (!I || !document.body) return;
  let lang = 'en';
  let applying = false;
  function paint() {
    if (applying) return;
    applying = true;
    try { I.apply(document.body, lang); } finally { applying = false; }
  }
  window.sortedLang = function (next) {
    lang = next || 'en';
    document.documentElement.lang = lang === 'nl' ? 'nl' : 'en';
    paint();
  };
  const obs = new MutationObserver(() => paint());
  obs.observe(document.body, { subtree: true, childList: true, characterData: true });
  function session() {
    return fetch('/api/session', { headers: { accept: 'application/json' } }).then((res) => (res.ok ? res.json() : null)).catch(() => null);
  }
  session().then((body) => {
    if (body && body.language) window.sortedLang(body.language);
    else paint();
  });
})();
