/*
 * Telnet for text terminals. Node's net module only. Plain ASCII.
 * IAC WILL ECHO, IAC WILL SGA, and IAC DO NAWS. A client that never
 * negotiates is still a line: text, then Enter.
 *
 * Telnet is plaintext. Keep it on the site LAN. The default allow list is
 * loopback and private ranges. See docs/TERMINAL.md.
 */
const net = require('node:net');
const { createSession } = require('../src/terminal');

const IAC = 255;
const WILL = 251;
const DO = 253;
const SB = 250;
const SE = 240;
const ECHO = 1;
const SGA = 3;
const NAWS = 31;

function privateAddress(ip) {
  const host = String(ip || '').replace(/^::ffff:/, '');
  if (host === '127.0.0.1' || host === '::1') return true;
  const m = /^(\d+)\.(\d+)\./.exec(host);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a === 10 || a === 127) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

function allow(ip, list) {
  if (!list || list === 'lan') return privateAddress(ip);
  return String(list).split(',').map((s) => s.trim()).filter(Boolean).some((rule) => {
    if (rule === 'lan') return privateAddress(ip);
    return String(ip || '').replace(/^::ffff:/, '') === rule;
  });
}

const DONT = 254;

// Function keys as VT100/VT220/xterm and old VT52 guns send them. Arrows and
// anything else that starts with ESC is swallowed, never typed into a field.
const KEYS = {
  '\x1bOP': 'F1', '\x1bOQ': 'F2', '\x1bOR': 'F3', '\x1bOS': 'F4',
  '\x1b[11~': 'F1', '\x1b[12~': 'F2', '\x1b[13~': 'F3', '\x1b[14~': 'F4',
  '\x1bP': 'F1', '\x1bQ': 'F2', '\x1bR': 'F3', '\x1bS': 'F4',
};

/**
 * Bytes in, lines and keys out. `echo(text)` is called for what the user
 * typed (the server said WILL ECHO, so the client shows nothing itself);
 * `mask()` says whether to echo stars, for the PIN.
 */
function createParser(onLine, onNaws, { echo = () => {}, mask = () => false, onKey = onLine, onNoEcho = () => {} } = {}) {
  let iac = false;
  let cmd = 0;
  let sub = false;
  const subBuf = [];
  let line = '';
  let esc = '';
  let lastCr = false;
  return function push(chunk) {
    for (const b of chunk) {
      if (sub) {
        if (iac && b === SE) {
          if (subBuf[0] === NAWS && subBuf.length >= 5) onNaws(subBuf[1] * 256 + subBuf[2], subBuf[3] * 256 + subBuf[4]);
          sub = false;
          subBuf.length = 0;
          iac = false;
          continue;
        }
        if (b === IAC && !iac) { iac = true; continue; }
        iac = false;
        subBuf.push(b);
        continue;
      }
      if (iac) {
        if (cmd === 0) {
          if (b === IAC) { iac = false; continue; }
          cmd = b;
          if (b === SB) { sub = true; cmd = 0; iac = false; }
          continue;
        }
        if (cmd === DONT && b === ECHO) onNoEcho();
        cmd = 0;
        iac = false;
        continue;
      }
      if (b === IAC) { iac = true; continue; }
      if (esc) {
        esc += String.fromCharCode(b);
        const key = KEYS[esc];
        if (key) { esc = ''; line = ''; onKey(key); continue; }
        // A sequence is over at a letter or ~ (after ESC [ or ESC O), or when it grows too long.
        const done = esc.length > 6 || (esc.length > 2 && /[A-Za-z~]$/.test(esc)) || (esc.length === 2 && !/[[O]/.test(esc[1]));
        if (done) esc = '';
        continue;
      }
      if (b === 27) { esc = '\x1b'; continue; }
      // Enter is CR, CR LF, CR NUL or LF, depending on the client.
      if (b === 13 || (b === 10 && !lastCr)) { lastCr = b === 13; echo('\r\n'); const text = line; line = ''; onLine(text); continue; }
      if (b === 10 || b === 0) { lastCr = false; continue; }
      lastCr = false;
      if (b === 127 || b === 8) { if (line) { line = line.slice(0, -1); echo('\b \b'); } continue; }
      if (b >= 32 && b < 127) { line += String.fromCharCode(b); echo(mask() ? '*' : String.fromCharCode(b)); }
    }
  };
}

/**
 * One screen, top to bottom: title, a rule on tall screens, the body, the
 * keys on screens with room, and the prompt on the last line. The cursor is
 * left after the prompt, where the scan goes.
 */
function layout(ui) {
  const profile = ui.session.profile || { cols: 20, rows: 16 };
  const { cols, rows } = profile;
  const lines = ui.screen();
  const meta = typeof ui.meta === 'function' ? ui.meta() : {};
  const fit = (text) => String(text || '').slice(0, cols);
  const out = [];
  let title = fit(lines[0]);
  const tag = meta.tag ? String(meta.tag) : '';
  if (tag && title.length + 1 + tag.length <= cols) title = title + ' '.repeat(cols - title.length - tag.length) + tag;
  out.push(title);
  if (rows >= 12) out.push('-'.repeat(cols));
  const footer = rows >= 10 && meta.keys ? fit(meta.keys) : null;
  const room = rows - out.length - (footer ? 1 : 0) - 1;
  let body = lines.slice(1);
  // Menus go into two columns when the screen is wide and short.
  if (meta.columns && body.length > room && cols >= 32) {
    const half = Math.ceil(body.length / 2);
    const w = Math.floor(cols / 2);
    const left = body.slice(0, half);
    const right = body.slice(half);
    body = left.map((l, i) => String(l).slice(0, w - 1).padEnd(w, ' ') + String(right[i] || '').slice(0, cols - w));
  }
  if (body.length > room) body = body.slice(0, room - 1).concat(['...']);
  for (const l of body) out.push(fit(l));
  while (out.length < rows - (footer ? 1 : 0) - 1) out.push('');
  if (footer) out.push(footer);
  return { lines: out, prompt: fit(meta.prompt || '>') + ' ' };
}

function frame(ui, vt) {
  const { lines, prompt } = layout(ui);
  const bell = ui.session.bell ? '\x07' : '';
  ui.session.bell = false;
  if (vt) return `${bell}\x1b[2J\x1b[H${lines.map((l) => l.replace(/\s+$/, '')).join('\r\n')}\r\n${prompt}`;
  return `${bell}\r\n${lines.join('\r\n').replace(/[ ]+(\r\n|$)/g, '$1')}\r\n${prompt}`;
}

/**
 * One listener. `port` 0 asks the OS for a free port (tests). Sessions are
 * dropped after `idleMs` of no input. `maxSessions` caps concurrency.
 */
function serve({ store, auth, port = 2323, host = '127.0.0.1', now = () => Date.now(), idleMs = 15 * 60 * 1000, maxSessions = 8, allowList = 'lan' } = {}) {
  const sessions = new Set();
  // RF1, RF2, ... the lowest number not in use, so two guns never share a truck.
  const nextDevice = () => {
    const used = new Set([...sessions].map((s) => s._device));
    for (let i = 1; ; i++) if (!used.has(`RF${i}`)) return `RF${i}`;
  };
  const server = net.createServer((socket) => {
    if (!allow(socket.remoteAddress, allowList)) { socket.end('This port is for the LAN only\r\n'); return; }
    if (sessions.size >= maxSessions) { socket.end('Too many terminals\r\n'); return; }
    const device = nextDevice();
    socket._device = device;
    const ui = createSession({ store, auth, device, now });
    socket._ui = ui;
    let vt = false;
    let echoOn = true;
    const write = () => { if (!socket.destroyed) socket.write(frame(ui, vt)); };
    const parser = createParser(
      (line) => { ui.input(line); write(); },
      (cols, rows) => { vt = true; ui.setProfileFromSize(cols, rows); write(); },
      {
        echo: (text) => { if (echoOn && !socket.destroyed) socket.write(text); },
        mask: () => ui.session.step === 'pin',
        onNoEcho: () => { echoOn = false; },
      },
    );
    sessions.add(socket);
    socket.on('data', (buf) => parser(buf));
    socket.on('close', () => sessions.delete(socket));
    socket.on('error', () => sessions.delete(socket));
    socket.write(Buffer.from([IAC, WILL, ECHO, IAC, WILL, SGA, IAC, DO, NAWS]));
    write();
  });
  const timer = setInterval(() => {
    for (const socket of sessions) {
      const ui = socket._ui;
      if (ui && now() - ui.session.last > idleMs) socket.end('\r\nIdle: signed out\r\n');
    }
  }, Math.min(idleMs, 1000));
  if (timer.unref) timer.unref();
  server.sessions = sessions;
  server.listen(port, host);
  const close = server.close.bind(server);
  server.close = (cb) => {
    clearInterval(timer);
    for (const socket of sessions) socket.end('\r\nTerminal switched off\r\n');
    return close(cb);
  };
  return server;
}

module.exports = { serve, privateAddress, allow, createParser, layout, frame };
