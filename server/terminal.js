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

function createParser(onLine, onNaws) {
  let iac = false;
  let cmd = 0;
  let sub = false;
  const subBuf = [];
  let line = '';
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
          cmd = b;
          if (b === SB) { sub = true; cmd = 0; iac = false; }
          continue;
        }
        cmd = 0;
        iac = false;
        continue;
      }
      if (b === IAC) { iac = true; continue; }
      if (b === 13) continue;
      if (b === 10) { onLine(line); line = ''; continue; }
      if (b === 127 || b === 8) { line = line.slice(0, -1); continue; }
      if (b >= 32 && b < 127) line += String.fromCharCode(b);
    }
  };
}

function frame(ui, vt) {
  const lines = ui.screen();
  const profile = ui.session.profile || { cols: 20, rows: 16 };
  const body = [];
  for (let i = 0; i < profile.rows; i++) body.push(String(lines[i] || '').slice(0, profile.cols).padEnd(profile.cols, ' '));
  const text = body.join('\r\n');
  return vt ? `\x1b[2J\x1b[H${text}\r\n` : `${text}\r\n`;
}

/**
 * One listener. `port` 0 asks the OS for a free port (tests). Sessions are
 * dropped after `idleMs` of no input. `maxSessions` caps concurrency.
 */
function serve({ store, auth, port = 2323, host = '127.0.0.1', now = () => Date.now(), idleMs = 15 * 60 * 1000, maxSessions = 8, allowList = 'lan' } = {}) {
  const sessions = new Set();
  const server = net.createServer((socket) => {
    if (!allow(socket.remoteAddress, allowList)) { socket.end('This port is for the LAN only\r\n'); return; }
    if (sessions.size >= maxSessions) { socket.end('Too many terminals\r\n'); return; }
    const device = `RF${sessions.size + 1}`;
    const ui = createSession({ store, auth, device, now });
    socket._ui = ui;
    let vt = false;
    const write = () => { if (!socket.destroyed) socket.write(frame(ui, vt)); };
    const parser = createParser((line) => { ui.input(line); write(); }, (cols, rows) => { vt = true; ui.setProfileFromSize(cols, rows); write(); });
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
      if (ui && now() - ui.session.last > idleMs) socket.end('Idle\r\n');
    }
  }, Math.min(idleMs, 1000));
  if (timer.unref) timer.unref();
  server.sessions = sessions;
  server.listen(port, host);
  const close = server.close.bind(server);
  server.close = (cb) => { clearInterval(timer); return close(cb); };
  return server;
}

module.exports = { serve, privateAddress, allow, createParser };
