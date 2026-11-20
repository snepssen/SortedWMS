'use strict';

/*
 * SortedWMS webhook signatures.
 *
 * The current signature is HMAC-SHA256 of the raw body (`x-sorted-signature`).
 * A delivery also sends `x-sorted-timestamp` (Unix seconds) and
 * `x-sorted-signature-v2`, which is HMAC-SHA256 of `${timestamp}.${body}`.
 * Receivers should check v2 and refuse a timestamp more than five minutes
 * off. The body-only header is still sent so a receiver that has not moved
 * keeps working; it is dropped after 1 March 2027.
 */
const { createHmac, timingSafeEqual } = require('node:crypto');

const TOLERANCE_MS = 5 * 60 * 1000;

function hmacHex(secret, payload) {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

function signBody(secret, body) {
  return `sha256=${hmacHex(secret, body)}`;
}

function signTimestamped(secret, timestamp, body) {
  return `sha256=${hmacHex(secret, `${timestamp}.${body}`)}`;
}

function timestampSeconds(now = Date.now()) {
  return String(Math.floor(Number(now) / 1000));
}

function timestampFresh(timestamp, now = Date.now()) {
  const t = Number(String(timestamp == null ? '' : timestamp).trim());
  if (!Number.isFinite(t)) return false;
  const ms = t < 1e12 ? t * 1000 : t;
  return Math.abs(Number(now) - ms) <= TOLERANCE_MS;
}

function sameHex(expected, header) {
  const a = Buffer.from(String(expected || ''));
  const b = Buffer.from(String(header || '').trim());
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

/** True when the v2 header matches timestamp + '.' + body and the time is within five minutes. */
function verifyTimestamped(secret, timestamp, body, header, now = Date.now()) {
  if (!secret || header == null || String(header).trim() === '') return false;
  if (!timestampFresh(timestamp, now)) return false;
  const ts = String(timestamp).trim();
  return sameHex(signTimestamped(secret, ts, body), header);
}

module.exports = {
  TOLERANCE_MS, signBody, signTimestamped, timestampSeconds, timestampFresh, verifyTimestamped, hmacHex,
};
