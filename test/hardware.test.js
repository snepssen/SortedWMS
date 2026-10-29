const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { Printers } = require('../server/print');
const { createHardware, normalizeScan } = require('../server/hardware');

test('a scan is a wedge, a manual entry, or a simulation of the same code', () => {
  assert.deepEqual(normalizeScan('  00ABC\r', 'wedge'), { code: '00ABC', source: 'wedge' });
  assert.equal(normalizeScan('BIN-01', 'manual').source, 'manual');
  assert.equal(normalizeScan('SIM-1', 'simulated').source, 'simulated');
  assert.throws(() => normalizeScan('', 'manual'), /empty/);
  assert.throws(() => normalizeScan('X', 'usb'), /wedge, manual or simulated/);
});

test('simulated and browser printers keep ZPL without a socket; network uses the transport', async () => {
  const sim = createHardware({ printers: new Printers({}) });
  const job = await sim.print({ printer: 'SIM', zpl: '^XA^FDPallet^FS^XZ', html: '<p>Pallet</p>', kind: 'pallet' });
  assert.equal(job.mode, 'simulated');
  assert.equal(job.ok, true);
  assert.equal(sim.recent().jobs[0].zpl.includes('^XA'), true);
  sim.setMode({ printer: 'browser', scanner: 'manual' });
  const browser = await sim.print({ zpl: '^XA^FDMaster^FS^XZ', html: '<p>(00) 1</p>', kind: 'master' });
  assert.equal(browser.mode, 'browser');
  assert.equal(browser.fallback, 'html');
  assert.throws(() => sim.setMode({ printer: 'serial' }), /simulated, network or browser/);

  const got = [];
  const srv = net.createServer((s) => { let d = ''; s.on('data', (c) => (d += c)); s.on('end', () => got.push(d)); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const printers = new Printers({ 'LP-1': `127.0.0.1:${srv.address().port}` });
  const netHw = createHardware({ printers });
  netHw.setMode({ printer: 'network' });
  const sent = await netHw.print({ printer: 'LP-1', zpl: '^XA^FDlive^FS^XZ', kind: 'pallet' });
  assert.equal(sent.ok, true);
  assert.equal(sent.mode, 'network');
  const missing = await netHw.print({ printer: 'LP-MISSING', zpl: '^XA^XZ', kind: 'pallet' });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /No address/);
  await new Promise((r) => setTimeout(r, 150));
  srv.close();
  assert.ok(got.some((d) => d.includes('live')));
});
