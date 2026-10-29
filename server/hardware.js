/*
 * Scanners and printers without a physical device on the bench.
 *
 * Scanners: the page treats a fast run of keys ending in Enter as a keyboard
 * wedge, a typed value as manual entry, and a button as a simulated scan.
 * All three arrive here as { code, source }.
 *
 * Printers: ZPL is the real payload. `network` hands it to the existing TCP
 * transport (Printers.send). `browser` returns HTML for the print dialog,
 * which is the PDF path. `simulated` keeps the job and does not open a
 * socket. A later driver implements send() and status(); callers do not change.
 */
'use strict';

const SOURCES = ['wedge', 'manual', 'simulated'];
const PRINTER_MODES = ['simulated', 'network', 'browser'];

function normalizeScan(input, source) {
  const code = String(input ?? '').replace(/\r/g, '').trim();
  if (!code) throw new Error('Scan is empty');
  const src = source || 'manual';
  if (!SOURCES.includes(src)) throw new Error('Scan source must be wedge, manual or simulated');
  return { code, source: src };
}

function createHardware({ printers = null, store = null, now = () => Date.now() } = {}) {
  const saved = store && store.meta ? store.meta('hardware') : null;
  const settings = {
    scanner: 'wedge',
    printer: 'simulated',
    ...(saved && typeof saved === 'object' ? saved : {}),
  };
  if (!PRINTER_MODES.includes(settings.printer)) settings.printer = 'simulated';
  let scans = [];
  let jobs = [];

  function persist() {
    if (store && store.meta) store.meta('hardware', { scanner: settings.scanner, printer: settings.printer });
  }

  function recent() {
    return {
      settings: { scanner: settings.scanner, printer: settings.printer },
      scans: scans.slice(0, 40),
      jobs: jobs.slice(0, 40),
      printers: printers && printers.list ? printers.list() : [],
      modes: { scanner: ['wedge', 'manual', 'simulated'], printer: PRINTER_MODES },
    };
  }

  function setMode(patch) {
    if (patch.scanner != null) {
      if (!['wedge', 'manual', 'simulated'].includes(patch.scanner)) throw new Error('Scanner mode must be wedge, manual or simulated');
      settings.scanner = patch.scanner;
    }
    if (patch.printer != null) {
      if (!PRINTER_MODES.includes(patch.printer)) throw new Error('Printer mode must be simulated, network or browser');
      settings.printer = patch.printer;
    }
    persist();
    return recent().settings;
  }

  function recordScan(input) {
    const scan = { ...normalizeScan(input.code, input.source), at: now(), deviceId: input.deviceId || null, stationId: input.stationId || null };
    scans.unshift(scan);
    if (scans.length > 40) scans.length = 40;
    return scan;
  }

  async function print(job) {
    const zpl = String(job.zpl || '');
    if (!zpl.includes('^XA')) throw new Error('A label needs ZPL');
    const entry = {
      id: jobs.length + 1,
      printer: job.printer || 'SIM',
      kind: job.kind || 'label',
      zpl,
      html: job.html || null,
      mode: settings.printer,
      at: now(),
      ok: true,
      error: null,
    };
    if (settings.printer === 'network') {
      if (!printers || !printers.send) {
        entry.ok = false;
        entry.error = 'No network transport';
      } else {
        try { await printers.send(entry.printer, zpl); } catch (e) {
          entry.ok = false;
          entry.error = e.message;
          entry.mode = 'simulated';
        }
      }
    } else if (settings.printer === 'browser') {
      entry.fallback = 'html';
    }
    jobs.unshift(entry);
    if (jobs.length > 40) jobs.length = 40;
    return entry;
  }

  /** Record a job the warehouse queue already handed to Printers.flush. */
  function note(job) {
    const entry = {
      id: job.id,
      printer: job.printer || 'SIM',
      kind: job.kind || (job.label && job.label.kind) || 'label',
      zpl: job.zpl,
      mode: settings.printer,
      at: now(),
      ok: settings.printer !== 'network' || Boolean(printers && printers.map && printers.map[job.printer] && printers.map[job.printer].address),
      error: null,
    };
    if (settings.printer === 'network' && !entry.ok) {
      entry.error = 'No address configured';
      entry.mode = 'simulated';
    }
    if (settings.printer === 'browser') entry.fallback = 'html';
    jobs.unshift(entry);
    if (jobs.length > 40) jobs.length = 40;
    return entry;
  }

  return { recent, setMode, recordScan, print, note, normalizeScan };
}

module.exports = { createHardware, normalizeScan, PRINTER_MODES, SOURCES };
