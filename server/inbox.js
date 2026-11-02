/*
 * The drop folder: for a system that can only write files. A .json or .csv
 * file put in the inbox folder is taken in like POST /api/inbox, then moved to
 * done/ or failed/ with a .result.json beside it saying what became of each
 * document. A file that failed can be fixed and dropped again: documents it
 * already took in answer "duplicate", so nothing is booked twice.
 *
 * JSON: one document, a list of them, or { documents: [...] }.
 * CSV: the file name says what it holds, orders… or asn… (orders-1102.csv).
 * A file still being written (changed in the last two seconds) waits.
 */
'use strict';
const fs = require('fs');
const path = require('path');

function bodyFor(name, text) {
  if (/\.csv$/i.test(name)) {
    const type = /^asn/i.test(name) ? 'asn' : /^order/i.test(name) ? 'order' : null;
    if (!type) throw new Error('A CSV file name starts with orders or asn, so the warehouse knows what it holds');
    return { type, csv: text };
  }
  let doc;
  try { doc = JSON.parse(text); } catch (e) { throw new Error(`Not valid JSON: ${e.message}`); }
  if (Array.isArray(doc)) return { documents: doc };
  return doc;
}

function watchInbox({ dir, api, every = 5000, settle = 2000, log = console, now = () => Date.now() }) {
  const done = path.join(dir, 'done');
  const failed = path.join(dir, 'failed');
  for (const d of [dir, done, failed]) fs.mkdirSync(d, { recursive: true });

  function take(name) {
    const file = path.join(dir, name);
    const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-');
    let result;
    try {
      const out = api.handle('POST', '/api/inbox', bodyFor(name, fs.readFileSync(file, 'utf8')), 'inbox');
      result = out.status >= 400 ? { ok: false, error: out.body.error, ...out.body } : { ok: !out.body.refused, ...out.body };
    } catch (e) {
      result = { ok: false, error: e.message };
    }
    const to = result.ok ? done : failed;
    fs.renameSync(file, path.join(to, `${stamp}-${name}`));
    fs.writeFileSync(path.join(to, `${stamp}-${name}.result.json`), `${JSON.stringify({ file: name, at: new Date(now()).toISOString(), ...result }, null, 2)}\n`);
    if (!result.ok) log.warn(`Inbox: ${name} → failed/: ${result.error || `${result.refused} document(s) refused`}`);
    return result;
  }

  /** Take in every file that is ready. Returns what happened to each. */
  function poll() {
    const out = {};
    let names = [];
    try { names = fs.readdirSync(dir); } catch (e) { return out; }
    for (const name of names.sort()) {
      if (name.startsWith('.') || !/\.(json|csv)$/i.test(name)) continue;
      const file = path.join(dir, name);
      let st;
      try { st = fs.statSync(file); } catch (e) { continue; }
      if (!st.isFile() || now() - st.mtimeMs < settle) continue;
      out[name] = take(name);
    }
    return out;
  }

  const timer = every ? setInterval(() => { try { poll(); } catch (e) { log.error('inbox', e); } }, every) : null;
  if (timer && timer.unref) timer.unref();
  return { poll, stop: () => timer && clearInterval(timer), dir };
}

module.exports = { watchInbox, bodyFor };
