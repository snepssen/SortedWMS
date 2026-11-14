/*
 * AWS Signature Version 4 for S3-compatible stores (AWS, Backblaze B2,
 * MinIO, Wasabi). Header signing only: the secret never goes in the URL.
 */
'use strict';

const { createHash, createHmac } = require('node:crypto');

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

function hmac(key, data) {
  return createHmac('sha256', key).update(data).digest();
}

function encodeRfc3986(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
}

function canonicalUri(pathname) {
  const path = pathname || '/';
  const encoded = path.split('/').map((seg) => encodeRfc3986(decodeURIComponent(seg))).join('/');
  return encoded.startsWith('/') ? encoded : `/${encoded}`;
}

function canonicalQuery(params) {
  const pairs = [];
  for (const [key, value] of params.entries()) pairs.push([encodeRfc3986(key), encodeRfc3986(value)]);
  pairs.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : (a[0] < b[0] ? -1 : 1)));
  return pairs.map(([key, value]) => `${key}=${value}`).join('&');
}

function amzDate(date) {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, '');
}

/**
 * Sign one request. `headers` are the headers to sign, besides host,
 * x-amz-date and x-amz-content-sha256 which are added when missing.
 * Returns the headers to send, including Authorization.
 */
function signRequest({ method, url, headers = {}, body = Buffer.alloc(0), accessKeyId, secretAccessKey, region, service = 's3', now = new Date(), amzDate: fixedDate = null }) {
  const u = new URL(url);
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(body || '');
  const payloadHash = sha256(payload);
  const stamp = fixedDate || amzDate(now);
  const dateStamp = stamp.slice(0, 8);
  const signed = {};
  for (const [name, value] of Object.entries(headers)) {
    signed[String(name).toLowerCase()] = String(value).trim().replace(/\s+/g, ' ');
  }
  if (!signed.host) signed.host = u.host;
  if (!signed['x-amz-date']) signed['x-amz-date'] = stamp;
  if (!signed['x-amz-content-sha256']) signed['x-amz-content-sha256'] = payloadHash;
  delete signed.authorization;
  const names = Object.keys(signed).sort();
  const canonicalHeaders = names.map((name) => `${name}:${signed[name]}\n`).join('');
  const signedHeaders = names.join(';');
  // Canonical headers already end in a newline. The request then adds another,
  // which is the blank line in the AWS examples.
  const canonical = [
    String(method || 'GET').toUpperCase(),
    canonicalUri(u.pathname),
    canonicalQuery(u.searchParams),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', stamp, scope, sha256(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, dateStamp), region), service), 'aws4_request');
  const signature = createHmac('sha256', key).update(stringToSign).digest('hex');
  const authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const out = {};
  for (const name of names) out[name] = signed[name];
  out.authorization = authorization;
  return { authorization, signature, canonical, stringToSign, payloadHash, amzDate: stamp, headers: out };
}

module.exports = { signRequest, sha256, encodeRfc3986, amzDate };
