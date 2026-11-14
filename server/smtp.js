/*
 * SMTP with Node's net and tls. No packages.
 * STARTTLS and SMTPS, and AUTH PLAIN or AUTH LOGIN.
 * The password is not written into errors.
 */
'use strict';

const net = require('node:net');
const tls = require('node:tls');

function sendMail({ host, port, mode = 'starttls', auth = 'PLAIN', user = '', password = '', from, to, subject, text, timeoutMs = 15000, tls: tlsOpts = {} } = {}) {
  if (!host) throw new Error('SMTP needs a host');
  if (!from || !to) throw new Error('SMTP needs a from and a to address');
  const secure = mode === 'smtps';
  const starttls = mode === 'starttls';
  if (!secure && !starttls && mode !== 'plain') throw new Error('SMTP mode is starttls, smtps or plain');
  const recipients = (Array.isArray(to) ? to : [to]).map((addr) => String(addr).trim()).filter(Boolean);
  if (!recipients.length) throw new Error('SMTP needs a recipient');
  return new Promise((resolve, reject) => {
    let settled = false;
    let socket = null;
    let upgraded = false;
    let buf = '';
    let phase = 'greeting';
    let loginStep = 0;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      try { socket && socket.destroy(); } catch (e) { /* already closed */ }
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    const ok = () => {
      if (settled) return;
      settled = true;
      try { socket.end(); } catch (e) { /* already closed */ }
      resolve({ accepted: recipients.length });
    };
    const say = (line) => socket.write(`${line}\r\n`);
    const onSecure = () => {
      upgraded = true;
      phase = 'ehlo';
      say('EHLO sortedwms');
    };
    const consume = (line) => {
      if (line.length < 3 || line[3] === '-') return;
      const code = Number(line.slice(0, 3));
      if (phase === 'greeting' && code === 220) { phase = 'ehlo'; say('EHLO sortedwms'); return; }
      if (phase === 'ehlo' && code === 250) {
        if (starttls && !upgraded) { phase = 'starttls'; say('STARTTLS'); return; }
        if (user) { phase = 'auth'; beginAuth(); return; }
        phase = 'mail'; say(`MAIL FROM:<${from}>`); return;
      }
      if (phase === 'starttls' && code === 220) {
        const plain = socket;
        plain.removeListener('data', onData);
        socket = tls.connect({ socket: plain, servername: host, ...tlsOpts });
        socket.setTimeout(timeoutMs);
        socket.on('timeout', () => fail(new Error('SMTP did not answer in time')));
        socket.on('error', (err) => fail(new Error(err.message || 'SMTP connection failed')));
        socket.on('data', onData);
        socket.once('secureConnect', onSecure);
        return;
      }
      if (phase === 'auth' && (code === 235 || code === 250)) { phase = 'mail'; say(`MAIL FROM:<${from}>`); return; }
      if (phase === 'auth' && code === 334) { loginStep += 1; sendLogin(); return; }
      if (phase === 'mail' && code === 250) { phase = 'rcpt'; rcptAt = 0; say(`RCPT TO:<${recipients[0]}>`); return; }
      if (phase === 'rcpt' && code === 250) {
        rcptAt += 1;
        if (rcptAt < recipients.length) { say(`RCPT TO:<${recipients[rcptAt]}>`); return; }
        phase = 'data'; say('DATA'); return;
      }
      if (phase === 'data' && code === 354) {
        phase = 'body';
        const body = dotStuff(`${headers()}\r\n${text || ''}\r\n`);
        socket.write(`${body}\r\n.\r\n`);
        return;
      }
      if (phase === 'body' && code === 250) { phase = 'quit'; say('QUIT'); return; }
      if (phase === 'quit' && (code === 221 || code === 250)) { ok(); return; }
      fail(new Error(`SMTP ${code}`));
    };
    let rcptAt = 0;
    function beginAuth() {
      if (String(auth).toUpperCase() === 'LOGIN') { loginStep = 0; say('AUTH LOGIN'); return; }
      const token = Buffer.from(`\0${user}\0${password}`).toString('base64');
      say(`AUTH PLAIN ${token}`);
    }
    function sendLogin() {
      if (loginStep === 1) say(Buffer.from(user).toString('base64'));
      else say(Buffer.from(password).toString('base64'));
    }
    function headers() {
      return [`From: ${from}`, `To: ${recipients.join(', ')}`, `Subject: ${subject || 'SortedWMS'}`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8'].join('\r\n');
    }
    function onData(chunk) {
      buf += chunk.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        if (line) consume(line);
      }
    }
    const connect = secure
      ? () => tls.connect({ host, port: port || 465, servername: host, ...tlsOpts })
      : () => net.connect({ host, port: port || 587 });
    socket = connect();
    socket.setTimeout(timeoutMs);
    socket.on('timeout', () => fail(new Error('SMTP did not answer in time')));
    socket.on('error', (err) => fail(new Error(err.message || 'SMTP connection failed')));
    socket.on('data', onData);
  });
}

function dotStuff(text) {
  return String(text).replace(/\r?\n\./g, (m) => m.replace('.', '..'));
}

module.exports = { sendMail };
