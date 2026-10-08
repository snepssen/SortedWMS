const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const Labels = require('../src/labels');
const { Printers, parseHostStatus } = require('../server/print');

const STX = '\x02';
const ETX = '\x03';
// A ~HS answer: string 1 (paper out, pause), string 2 (head up, ribbon out, …), string 3.
const hs = ({ paper = 0, pause = 0, head = 0, ribbon = 0 } = {}) =>
  `${STX}030,${paper},${pause},1218,000,0,0,0,000,0,0,0${ETX}\r\n${STX}000,0,${head},${ribbon},1,2,6,0,00000000,1,000${ETX}\r\n${STX}1234,0${ETX}\r\n`;

const label = () => Labels.shippingLabel({
  customer: 'Fresh Market', orderId: '4501', index: 1, total: 2, itemName: 'Skyr', itemNo: 'E0960', qty: 96,
  batch: '41/06', expiry: '2026-11-10', labelCode: 'SL4501-1', sscc: '054133890000100974', lane: 'OUT-01', printedAt: '08:00',
});

test('labels are laid out at 203 dpi and scaled for a 300 dpi printer', () => {
  const zpl = label();
  assert.equal(Labels.scaleZpl(zpl, 203), zpl);
  const big = Labels.scaleZpl(zpl, 300);
  assert.match(big, /\^PW1200\^LL1800/, '4×6 inch at 300 dpi');
  assert.match(big, /\^FO59,59\^A0N,50,50\^FDSHIP TO/);
  assert.match(big, /\^BY4\^BCN,325,N,N,N\^FD>;>800054133890000100974/, 'barcode module and height scale too');
  assert.equal((big.match(/\^FD/g) || []).length, (zpl.match(/\^FD/g) || []).length, 'nothing lost');
});

test('the printer status answer (~HS) says paper out, head open, ribbon out, paused', () => {
  assert.equal(parseHostStatus(hs().slice(0, 40)), null, 'not all there yet');
  assert.deepEqual(parseHostStatus(hs()).problems, []);
  assert.equal(parseHostStatus(hs()).ok, true);
  assert.deepEqual(parseHostStatus(hs({ paper: 1, head: 1 })).problems, ['paper out', 'head open']);
  assert.deepEqual(parseHostStatus(hs({ ribbon: 1, pause: 1 })).problems, ['ribbon out', 'paused']);
});

test('a printer is asked over TCP and jobs are sent at its dpi', async () => {
  const got = [];
  const srv = net.createServer((s) => {
    let d = '';
    s.on('data', (c) => {
      d += c;
      if (d === '~HS') s.write(hs({ paper: 1 }));
    });
    s.on('end', () => got.push(d));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const addr = `127.0.0.1:${srv.address().port}`;
  const printers = new Printers({ 'LP-OUT-01': { address: addr, dpi: 300 }, 'LP-OUT-02': '' });
  assert.deepEqual(printers.list().map((p) => [p.name, p.dpi]), [['LP-OUT-01', 300], ['LP-OUT-02', 203]]);
  const st = await printers.status('LP-OUT-01');
  assert.deepEqual(st.problems, ['paper out']);
  await assert.rejects(printers.status('LP-OUT-02'), /No address/);
  printers.flush([{ id: 1, printer: 'LP-OUT-01', zpl: label() }]);
  await new Promise((r) => setTimeout(r, 200));
  srv.close();
  assert.ok(got.some((d) => d.includes('^PW1200')), 'sent scaled to 300 dpi');
});
