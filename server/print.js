/*
 * Sends label jobs to networked label printers: ZPL over raw TCP, port 9100.
 * Printers are mapped by name in the site config, e.g. "LP-OUT-01": "10.0.4.51:9100".
 * A printer with no address keeps its jobs in the queue (visible in the admin page).
 */
const net = require('node:net');

class Printers {
  constructor(map = {}, { timeoutMs = 5000 } = {}) {
    this.map = map;
    this.timeoutMs = timeoutMs;
    this.sentUpTo = 0;
    this.results = []; // newest first: { id, printer, ok, error, t }
  }

  /** Send every job newer than the last one sent. Called after each command. */
  flush(queue) {
    const fresh = queue.filter((j) => j.id > this.sentUpTo).sort((a, b) => a.id - b.id);
    for (const job of fresh) {
      this.sentUpTo = job.id;
      const addr = this.map[job.printer];
      if (!addr) { this._result(job, false, 'No address configured'); continue; }
      const [host, port = '9100'] = addr.split(':');
      this._send(host, Number(port), job.zpl).then(() => this._result(job, true), (e) => this._result(job, false, e.message));
    }
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

module.exports = { Printers };
