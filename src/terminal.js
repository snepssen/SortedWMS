/*
 * Text screens for a scanner terminal. The same warehouse commands as the
 * handhelds. English and Dutch come from src/i18n.js when that file is
 * present, and from the packs below otherwise. Output is ASCII.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SortedTerminal = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const PROFILES = {
    '20x16': { cols: 20, rows: 16 },
    '40x8': { cols: 40, rows: 8 },
    '16x20': { cols: 16, rows: 20 },
    '80x24': { cols: 80, rows: 24 },
  };

  const EN = {
    size: 'Screen size',
    user: 'User',
    pin: 'PIN or badge',
    menu: 'Menu',
    off: 'Terminal is off',
    locked: 'PIN locked. Wait.',
    denied: 'Unknown user or PIN',
    back: '0 back',
    help: '? help',
    receive: '1 Receive',
    putaway: '2 Put away',
    move: '3 Move',
    replenish: '4 Replenish',
    pick: '5 Pick',
    plates: '6 Plates',
    count: '7 Count',
    enquiry: '8 Enquiry',
    more: '9 More',
    kit: '1 Kitting',
    out: '9 Sign out',
    scan: 'Scan',
    qty: 'Quantity',
    reason: 'Reason',
    slot: 'Scan the slot',
    pallet: 'Scan the pallet',
    none: 'Nothing waiting',
    blind: 'Booked qty is hidden',
    return: 'Return the remainder',
    helpText: '0 back  ? help  c cancel',
    keys: '0 Back  ? Help',
    menuKeys: 'Number  ? Help',
    lan: 'This port is for the LAN only',
  };
  const NL = {
    size: 'Scherm',
    user: 'Gebruiker',
    pin: 'PIN of badge',
    menu: 'Menu',
    off: 'Terminal staat uit',
    locked: 'PIN geblokkeerd. Wacht.',
    denied: 'Onbekend of foute PIN',
    back: '0 terug',
    help: '? help',
    receive: '1 Ontvangst',
    putaway: '2 Wegzetten',
    move: '3 Verplaatsen',
    replenish: '4 Aanvullen',
    pick: '5 Picken',
    plates: '6 Platen',
    count: '7 Tellen',
    enquiry: '8 Opzoeken',
    more: '9 Meer',
    kit: '1 Kitting',
    out: '9 Afmelden',
    scan: 'Scan',
    qty: 'Aantal',
    reason: 'Reden',
    slot: 'Scan de locatie',
    pallet: 'Scan de pallet',
    none: 'Niets te doen',
    blind: 'Geboekt aantal verborgen',
    return: 'Restant terugbrengen',
    helpText: '0 terug  ? help  c stop',
    keys: '0 Terug  ? Help',
    menuKeys: 'Nummer  ? Help',
    lan: 'Deze poort is alleen voor het LAN',
  };

  function fold(text) {
    return String(text == null ? '' : text)
      .replace(/ß/g, 'ss').replace(/€/g, 'EUR')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^\x09\x0a\x0d\x20-\x7e]/g, '');
  }

  function say(lang, key) {
    let text = null;
    try {
      const api = typeof require === 'function' ? require('./i18n') : (typeof globalThis !== 'undefined' ? globalThis.SortedI18n : null);
      if (api) {
        const hit = api.t(lang, `terminal.${key}`);
        if (hit && hit !== `terminal.${key}`) text = api.fold ? api.fold(hit) : hit;
      }
    } catch (e) { /* catalogs are not on this tree */ }
    if (!text) text = (lang === 'nl' ? NL : EN)[key] || EN[key] || key;
    return fold(text);
  }

  function missingDutch() {
    return Object.keys(EN).filter((key) => !NL[key]);
  }

  function wrap(text, cols) {
    const clean = fold(text);
    const out = [];
    let line = '';
    for (const word of clean.split(/\s+/).filter(Boolean)) {
      const piece = word.length > cols ? word.slice(0, cols) : word;
      if (!line) line = piece;
      else if (line.length + 1 + piece.length <= cols) line += ` ${piece}`;
      else { out.push(line); line = piece; }
    }
    if (line) out.push(line);
    return out.length ? out : [''];
  }

  function can(user, perm) {
    if (!user) return false;
    if (user.role === 'administrator') return true;
    return (user.permissions || []).includes(perm);
  }

  function createSession({ store, auth, device, lang = 'en', profile = null, now = () => Date.now() }) {
    const session = {
      device, lang, profile, user: null, step: profile ? 'user' : 'size',
      sub: null, lines: [], last: 0, now,
    };

    function note(text) {
      try { store.exec('terminalNote', { device, text }, session.user ? session.user.username : 'terminal'); } catch (e) { /* journal is best-effort on the sign-in screen */ }
    }

    function paint(title, rows, { error = false } = {}) {
      const cols = session.profile ? session.profile.cols : 20;
      const seen = new Set();
      const unique = rows.filter((row) => { const k = String(row); if (seen.has(k)) return false; seen.add(k); return true; });
      const heading = say(session.lang, title).replace(/^[\d?]+\s+/, '');
      const body = [heading, ...unique.flatMap((row) => wrap(error ? `! ${row}` : row, cols))];
      session.lines = body;
      session.last = now();
      if (error) session.bell = true;
    }

    // What the frame shows around the body: a tag on the title line, the keys, the prompt.
    function meta() {
      const step = session.step;
      const tag = session.user ? session.user.username : device;
      if (step === 'size') return { tag: device, prompt: '#' };
      if (step === 'user') return { tag: device, prompt: say(session.lang, 'user') };
      if (step === 'pin') return { tag: device, prompt: 'PIN' };
      if (step === 'menu' || step === 'more') return { tag, columns: true, keys: say(session.lang, 'menuKeys'), prompt: '#' };
      return { tag, keys: say(session.lang, 'keys'), prompt: '>' };
    }

    function wh() {
      return store.warehouse ? store.warehouse(store.siteId || 'MAIN') : store.wh;
    }

    function ensureTruck(mode) {
      const w = wh();
      if (!w.module('terminal')) throw new Error(say(session.lang, 'off'));
      if (!w.trucks[device]) store.exec('addTruck', { id: device, mode: mode || 'auto' }, session.user.username);
      else if (mode) store.exec('setTruckMode', { id: device, mode }, session.user.username);
    }

    function menuRows() {
      const u = session.user;
      const rows = [];
      const w = wh();
      const on = (id) => !w.module || w.module(id);
      if (can(u, 'inbound.write')) rows.push(say(session.lang, 'receive'));
      if (can(u, 'putaway.execute')) rows.push(say(session.lang, 'putaway'));
      if (can(u, 'moves.execute') && on('trucks')) rows.push(say(session.lang, 'move'));
      if (can(u, 'replenish.execute')) rows.push(say(session.lang, 'replenish'));
      if (can(u, 'picks.execute')) rows.push(say(session.lang, 'pick'));
      if (can(u, 'holders.write')) rows.push(say(session.lang, 'plates'));
      if (can(u, 'counts.execute') && on('abc')) rows.push(say(session.lang, 'count'));
      if (can(u, 'stock.read')) rows.push(say(session.lang, 'enquiry'));
      rows.push(say(session.lang, 'more'));
      return rows;
    }

    function showMenu() {
      session.step = 'menu';
      session.sub = null;
      paint('menu', menuRows());
    }

    function showHelp() {
      paint('help', [say(session.lang, 'helpText'), ...menuRows()]);
    }

    function jobText() {
      const ins = wh().instruction(device);
      const task = ins && ins.task;
      const rows = [];
      if (task && task.reason === 'return-split') rows.push(say(session.lang, 'return'));
      if (ins && ins.target) rows.push(ins.targetName || ins.target);
      if (ins && ins.pallet) rows.push(`${ins.pallet.itemNo || ''} ${String(ins.pallet.sscc || '').slice(-6)}`);
      // Stacked pickup: the other pallets on the forks, each with its drop.
      for (const s of (ins && ins.stack) || []) if (!s.current) rows.push(`+${String(s.sscc).slice(-6)} > ${s.to}`);
      const truck = wh().trucks[device];
      if (truck && truck.message && truck.message.text) rows.push(truck.message.text);
      return rows;
    }

    function openReceive() {
      ensureTruck('auto');
      try { store.exec('tick', {}, session.user.username); } catch (e) { /* no timers */ }
      session.step = 'receive';
      note('receive');
      paint('receive', [say(session.lang, 'scan'), ...jobText()]);
    }

    function openPutaway() {
      ensureTruck('putaway');
      session.step = 'putaway';
      note('put-away');
      paint('putaway', [say(session.lang, 'pallet'), ...jobText()]);
    }

    function openMove() {
      ensureTruck('transfer');
      session.step = 'move';
      note('move');
      paint('move', [say(session.lang, 'pallet'), ...jobText()]);
    }

    function openReplenish() {
      ensureTruck('shift');
      session.step = 'replenish';
      note('replenish');
      const tasks = Object.values(wh().tasks).filter((t) => ['SHIFT', 'MOVE'].includes(t.type) && ['open', 'active'].includes(t.status));
      const rows = tasks.slice(0, 6).map((t) => `${t.id} ${t.reason === 'return-split' ? say(session.lang, 'return') : (t.to || '')}`);
      paint('replenish', rows.length ? rows : [say(session.lang, 'none')]);
    }

    function openPick() {
      ensureTruck('pick');
      session.step = 'pick';
      note('pick');
      paint('pick', [say(session.lang, 'scan')]);
    }

    function openPlates() {
      session.step = 'plates';
      session.sub = 'series';
      note('plates');
      paint('plates', ['PAL MASTER ST INB OUT', say(session.lang, 'scan')]);
    }

    function openCount() {
      if (!wh().module('abc')) { paint('count', [say(session.lang, 'off')]); return; }
      session.step = 'count';
      session.sub = null;
      note('count');
      const mine = wh().abcMine(session.user.username);
      if (!mine) { paint('count', [say(session.lang, 'none')]); return; }
      session.sub = mine;
      paint('count', [mine.loc, mine.itemNo, say(session.lang, 'blind'), say(session.lang, 'qty')]);
    }

    function openEnquiry() {
      session.step = 'enquiry';
      note('enquiry');
      paint('enquiry', [say(session.lang, 'scan')]);
    }

    function openKit() {
      session.step = 'kitting';
      note('kitting');
      const stations = Object.keys(wh().valStations || {});
      paint('kit', stations.length ? [stations[0], say(session.lang, 'scan')] : [say(session.lang, 'none')]);
    }

    function openMore() {
      session.step = 'more';
      const rows = [];
      if (can(session.user, 'val.execute') && wh().module('kitting')) rows.push(say(session.lang, 'kit'));
      rows.push(say(session.lang, 'out'));
      rows.push(say(session.lang, 'back'));
      paint('more', rows);
    }

    function act(line) {
      const code = String(line || '').trim();
      if (!code) return showMenu();
      if (code === '?' || code.toLowerCase() === 'help' || code === 'F2') return showHelp();
      if (code === '0' || code.toLowerCase() === 'back' || code === 'F1') return showMenu();
      if (code.toLowerCase() === 'c' || code === 'F3') return showMenu();
      try {
        if (session.step === 'receive' || session.step === 'putaway' || session.step === 'move' || session.step === 'pick') {
          const out = store.exec('scan', { id: device, code }, session.user.username);
          paint(session.step, [out && out.text ? out.text : 'OK', ...jobText(), say(session.lang, 'scan')]);
          return;
        }
        if (session.step === 'replenish') {
          const out = store.exec('scan', { id: device, code }, session.user.username);
          paint('replenish', [out && out.text ? out.text : 'OK', ...jobText()]);
          return;
        }
        if (session.step === 'count') {
          if (!session.sub) return openCount();
          if (session.sub.waitReason) {
            store.exec('submitAbc', { id: session.sub.id, qty: session.sub.qty, reason: code }, session.user.username);
            note(`count ${session.sub.id}`);
            session.sub = null;
            return openCount();
          }
          const qty = Number(code);
          const mine = wh().abcMine(session.user.username);
          if (mine && mine.expected == null && String(session.lines.join(' ')).includes(String(wh().abcBoard({ reveal: true }).lines.find((l) => l.id === mine.id)?.expected))) {
            /* the blind screen must not have printed the booked quantity */
          }
          try {
            store.exec('submitAbc', { id: session.sub.id, qty, reason: qty === (session.sub.expected || qty) ? null : 'recount' }, session.user.username);
            note(`count ${session.sub.id} ${qty}`);
            session.sub = null;
            paint('count', ['OK']);
          } catch (e) {
            if (/Reason/.test(e.message)) {
              session.sub = { ...session.sub, waitReason: true, qty };
              paint('count', [say(session.lang, 'reason')]);
            } else throw e;
          }
          return;
        }
        if (session.step === 'enquiry') {
          const found = wh().lookup(code);
          paint('enquiry', found ? found.lines.slice(0, 8) : [say(session.lang, 'none')]);
          return;
        }
        if (session.step === 'plates') {
          const series = code.toUpperCase();
          const issued = store.exec('issueSeries', { series, by: session.user.username }, session.user.username);
          paint('plates', [issued.id || issued.plate || series]);
          return;
        }
        if (session.step === 'kitting') {
          const stationId = Object.keys(wh().valStations || {})[0];
          if (!stationId) return paint('kit', [say(session.lang, 'none')]);
          const out = store.exec('scanVal', { stationId, code }, session.user.username);
          paint('kit', [out && out.text ? out.text : 'OK']);
          return;
        }
      } catch (e) {
        paint(session.step || 'menu', [e.message], { error: true });
      }
    }

    function choose(line) {
      const n = String(line || '').trim();
      if (n === '9' && session.step === 'menu') return openMore();
      if (n === '9' && session.step === 'more') { note('sign out'); session.user = null; session.step = 'user'; return paint('user', []); }
      if (n === '1' && session.step === 'more') return openKit();
      const items = menuRows();
      const picked = items.find((row) => row.startsWith(`${n} `));
      if (!picked) return showMenu();
      if (picked === say(session.lang, 'receive')) return openReceive();
      if (picked === say(session.lang, 'putaway')) return openPutaway();
      if (picked === say(session.lang, 'move')) return openMove();
      if (picked === say(session.lang, 'replenish')) return openReplenish();
      if (picked === say(session.lang, 'pick')) return openPick();
      if (picked === say(session.lang, 'plates')) return openPlates();
      if (picked === say(session.lang, 'count')) return openCount();
      if (picked === say(session.lang, 'enquiry')) return openEnquiry();
      return showMenu();
    }

    function input(line) {
      const text = String(line || '').replace(/[\x00-\x1f]/g, '').trim();
      session.last = now();
      if (!wh().module('terminal')) { paint('off', []); return; }
      if (session.step === 'size') {
        const names = Object.keys(PROFILES);
        const name = names[Number(text) - 1] || names.find((n) => n === text);
        if (!name) { paint('size', names.map((n, i) => `${i + 1} ${n}`), { error: Boolean(text) }); return; }
        session.profile = { name, ...PROFILES[name] };
        session.step = 'user';
        paint('user', []);
        return;
      }
      if (session.step === 'user') {
        session.pendingUser = text;
        session.step = 'pin';
        paint('pin', []);
        return;
      }
      if (session.step === 'pin') {
        const result = auth.checkTerminal(session.pendingUser, text);
        if (result && result.locked) { session.step = 'user'; paint('user', [say(session.lang, 'locked')], { error: true }); return; }
        if (!result) { session.step = 'user'; paint('user', [say(session.lang, 'denied')], { error: true }); return; }
        session.user = result;
        session.lang = result.language || session.lang;
        note(`sign in ${result.username}`);
        return showMenu();
      }
      if ((session.step === 'menu' || session.step === 'more') && (text === '?' || text.toLowerCase() === 'help' || text === 'F2')) return showHelp();
      if (session.step === 'menu' || session.step === 'more') return choose(text);
      if (text === '?' || text.toLowerCase() === 'help' || text === 'F2') return showHelp();
      if (text === '0' || text.toLowerCase() === 'back' || text === 'F1' || text.toLowerCase() === 'c' || text === 'F3') return showMenu();
      return act(text);
    }

    function setProfileFromSize(cols, rows) {
      let best = '80x24';
      let score = Infinity;
      for (const [name, size] of Object.entries(PROFILES)) {
        const d = Math.abs(size.cols - cols) + Math.abs(size.rows - rows);
        if (d < score) { score = d; best = name; }
      }
      session.profile = { name: best, ...PROFILES[best] };
      if (session.step === 'size') { session.step = 'user'; paint('user', []); }
    }

    if (profile && PROFILES[profile]) {
      session.profile = { name: profile, ...PROFILES[profile] };
      session.step = 'user';
    }
    paint(session.step === 'size' ? 'size' : 'user', session.step === 'size' ? Object.keys(PROFILES).map((n, i) => `${i + 1} ${n}`) : []);
    function loadState() {
      if (!session.user || !['move', 'putaway', 'pick', 'receive', 'replenish'].includes(session.step)) return '';
      const truck = wh().trucks[device];
      return truck ? JSON.stringify([truck.taskId, truck.load, truck.carried, truck.message]) : '';
    }
    function refreshLoad() {
      const lastInput = session.last;
      const truck = wh().trucks[device];
      const handoff = truck.message?.handoff;
      const notice = handoff && session.lang === 'nl' ? `${handoff.pallet} overgenomen door ${handoff.toTruck}` : truck.message?.text;
      paint(session.step, [notice || say(session.lang, 'scan'), ...jobText()]);
      session.last = lastInput;
    }
    return { input, loadState, refreshLoad, setProfileFromSize, screen: () => session.lines.slice(), meta, session };
  }

  return { PROFILES, createSession, say, fold, missingDutch, EN, NL };
});
