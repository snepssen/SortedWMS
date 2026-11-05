/*
 * Addresses a phone on the same network can open. Only private ranges,
 * plus loopback when nothing else is up (the tests, and a laptop with no LAN).
 */
const os = require('node:os');
const { svg } = require('../src/qr');

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

function lanAddresses({ allowPublic = false } = {}) {
  const found = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list || []) {
      if (!net || net.internal) continue;
      const address = net.address;
      if (!allowPublic && !privateAddress(address)) continue;
      if (address.includes(':')) continue;
      if (!found.includes(address)) found.push(address);
    }
  }
  if (!found.length) found.push('127.0.0.1');
  return found;
}

function pairUrl(address, port, token) {
  const host = address.includes(':') ? `[${address}]` : address;
  return `http://${host}:${port}/pair/${token}`;
}

function pairCard({ address, port, token, code }) {
  const url = pairUrl(address, port, token);
  return { url, code, svg: svg(url) };
}

module.exports = { privateAddress, lanAddresses, pairUrl, pairCard };
