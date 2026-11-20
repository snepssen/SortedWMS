'use strict';

/*
 * Whether this request arrived over HTTPS.
 * The socket being TLS counts. `X-Forwarded-Proto: https` counts only when
 * the immediate peer is listed in SORTED_TRUST_PROXY (an IP or an IPv4 CIDR,
 * comma-separated). A client that sets the header itself is ignored.
 */

function clientAddress(req) {
  return String(req && req.socket && req.socket.remoteAddress || '').replace(/^::ffff:/, '');
}

function ipv4(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(ip || ''));
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((n) => n > 255)) return null;
  return (((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0);
}

function addressMatches(ip, rule) {
  const host = String(ip || '').replace(/^::ffff:/, '');
  const text = String(rule || '').trim();
  if (!text) return false;
  if (!text.includes('/')) return host === text;
  const [base, bitsRaw] = text.split('/');
  const bits = Number(bitsRaw);
  const a = ipv4(host);
  const b = ipv4(base);
  if (a == null || b == null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  if (bits === 0) return true;
  const mask = bits === 32 ? 0xffffffff : ((0xffffffff << (32 - bits)) >>> 0);
  return (a & mask) === (b & mask);
}

function proxyTrusted(ip, list) {
  return String(list || '').split(',').map((s) => s.trim()).filter(Boolean).some((rule) => addressMatches(ip, rule));
}

function requestIsSecure(req, env = process.env) {
  if (req && req.socket && req.socket.encrypted) return true;
  const proto = String(req && req.headers && req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  if (proto !== 'https') return false;
  const list = env && env.SORTED_TRUST_PROXY;
  if (!list || !String(list).trim()) return false;
  return proxyTrusted(clientAddress(req), list);
}

module.exports = { clientAddress, addressMatches, proxyTrusted, requestIsSecure };
