/*
 * Sends label jobs to networked label printers: ZPL over raw TCP, port 9100.
 * Printers are mapped by name in the site config, either as an address,
 * "LP-OUT-01": "10.0.4.51:9100", or with the print resolution,
 * "LP-OUT-01": { "address": "10.0.4.51:9100", "dpi": 300 } (Zebra ZT421: 203 or 300).
 * A printer with no address keeps its jobs in the queue (visible in the admin page).
 */
const net = require('node:net');
const { scaleZpl } = require('../src/labels');

class Printers {
  constructor(map = {}, { timeoutMs = 5000 } = {}) {
    this.map = {};
    for (const [name, v] of Object.entries(map)) {
      const c = typeof v === 'string' ? { address: v } : { ...v };
      this.map[name] = { address: c.address || '', dpi: Number(c.dpi) || 203 };
    }
    this.timeoutMs = timeoutMs;
    this.sentUpTo = 0;
    this.results = []; // newest first: { id, printer, ok, error, t }
  }

  list() {
    return Object.entries(this.map).map(([name, c]) => ({ name, ...c, last: this.results.find((r) => r.printer === name) || null }));
  }

  /** Send every job newer than the last one sent. Called after each command. */
  flush(queue) {
    const fresh = queue.filter((j) => j.id > this.sentUpTo).sort((a, b) => a.id - b.id);
    for (const job of fresh) {
      this.sentUpTo = job.id;
      const p = this.map[job.printer];
      if (!p || !p.address) { this._result(job, false, 'No address configured'); continue; }
      const [host, port] = this._hostPort(p.address);
      this._send(host, port, scaleZpl(job.zpl, p.dpi)).then(() => this._result(job, true), (e) => this._result(job, false, e.message));
    }
  }

  /**
   * Ask a Zebra printer how it is: ~HS (host status) on the same port.
   * Resolves { ok, paperOut, paused, headOpen, ribbonOut, labelWaiting, labelsRemaining, problems }.
   */
  status(name) {
    const p = this.map[name];
    if (!p || !p.address) return Promise.reject(new Error(`No address configured for ${name}`));
    const [host, port] = this._hostPort(p.address);
    return new Promise((resolve, reject) => {
      let data = '';
      const sock = net.connect({ host, port });
      const done = (fn, v) => { clearTimeout(timer); sock.destroy(); fn(v); };
      const timer = setTimeout(() => done(reject, new Error('Printer did not answer')), this.timeoutMs);
      sock.on('connect', () => sock.write('~HS'));
      sock.on('data', (c) => {
        data += c;
        const r = parseHostStatus(data);
        if (r) done(resolve, r);
      });
      sock.on('error', (e) => done(reject, e));
    });
  }

  _hostPort(address) {
    const [host, port = '9100'] = address.split(':');
    return [host, Number(port)];
  }

  _send(host, port, data) {
    return new Promise((resolve, reject) => {
      const sock = net.connect({ host, port });
      const timer = setTimeout(() => { sock.destroy(); reject(new Error('Printer did not answer')); }, this.timeoutMs);
      sock.on('connect', () => sock.end(data));
      sock.on('close', (hadError) => { clearTimeout(timer); if (!hadError) resolve(); });
      sock.on('error', (e) => { clearTimeout(timer); reject(e); });
    });
  }

  _result(job, ok, error = null) {
    this.results.unshift({ id: job.id, printer: job.printer, ok, error, t: Date.now() });
    if (this.results.length > 200) this.results.length = 200;
  }
}

/**
 * The ~HS answer: three <STX>…<ETX> strings of comma-separated fields.
 * String 1: comms, paper out, pause, label length, formats in buffer, …
 * String 2: function settings, unused, head up, ribbon out, mode, …, label waiting, labels remaining, …
 * Returns null until all three strings have arrived.
 */
function parseHostStatus(raw) {
  const parts = [...String(raw).matchAll(/\x02([^\x03]*)\x03/g)].map((m) => m[1].split(','));
  if (parts.length < 3) return null;
  const [a, b] = parts;
  const flag = (v) => v === '1';
  const r = {
    paperOut: flag(a[1]), paused: flag(a[2]), bufferFull: flag(a[5]),
    headOpen: flag(b[2]), ribbonOut: flag(b[3]), labelWaiting: flag(b[7]), labelsRemaining: Number(b[8]) || 0,
  };
  r.problems = [r.paperOut && 'paper out', r.headOpen && 'head open', r.ribbonOut && 'ribbon out', r.paused && 'paused', r.bufferFull && 'buffer full'].filter(Boolean);
  r.ok = !r.problems.length;
  return r;
}

module.exports = { Printers, parseHostStatus };
