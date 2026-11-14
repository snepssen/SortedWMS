/*
 * Encrypted backup files. AES-256-GCM, key from the passphrase with scrypt.
 * Each file has its own salt and IVs. A versioned header is the extra
 * authenticated data, so a changed header fails the integrity check.
 *
 * A short sealed "OK" comes first. If that does not open, the passphrase is
 * wrong. If it opens and the database does not, the file was altered.
 * The passphrase is not written into the file.
 */
'use strict';

const { createCipheriv, createDecipheriv, createHmac, randomBytes, scryptSync, timingSafeEqual } = require('node:crypto');

const MAGIC = Buffer.from('SWBK');
const VERSION = 1;
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
const CHECK = Buffer.from('OK');
// magic, version, N, r, p, salt
const AAD_LEN = 4 + 1 + 4 + 2 + 2 + SALT_LEN;
// AAD + ivCheck + tagCheck + check ciphertext + ivBody
const HEADER_LEN = AAD_LEN + IV_LEN + TAG_LEN + CHECK.length + IV_LEN;
const DEFAULTS = { N: 16384, r: 8, p: 1 };

function assertPassphrase(passphrase) {
  if (typeof passphrase !== 'string' || passphrase.length < 8 || passphrase.length > 1024) {
    throw new Error('A backup passphrase is required');
  }
}

function derive(passphrase, salt, N, r, p) {
  if (N < 1024 || N > 131072 || (N & (N - 1)) !== 0 || r < 1 || r > 16 || p < 1 || p > 4) {
    throw new Error('Encrypted backup header is not valid');
  }
  return scryptSync(passphrase, salt, 32, { N, r, p, maxmem: 256 * 1024 * 1024 });
}

function seal(key, iv, aad, plain) {
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  return { ciphertext, tag: cipher.getAuthTag() };
}

function open(key, iv, aad, ciphertext, tag) {
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/** Encrypt a database. `opts.N` is the scrypt cost (power of two). */
function encrypt(plain, passphrase, opts = {}) {
  assertPassphrase(passphrase);
  const data = Buffer.isBuffer(plain) ? plain : Buffer.from(plain);
  const N = opts.N == null ? DEFAULTS.N : opts.N;
  const r = opts.r == null ? DEFAULTS.r : opts.r;
  const p = opts.p == null ? DEFAULTS.p : opts.p;
  const salt = randomBytes(SALT_LEN);
  const ivCheck = randomBytes(IV_LEN);
  const ivBody = randomBytes(IV_LEN);
  const key = derive(passphrase, salt, N, r, p);
  try {
    const header = Buffer.alloc(HEADER_LEN);
    MAGIC.copy(header, 0);
    header.writeUInt8(VERSION, 4);
    header.writeUInt32BE(N, 5);
    header.writeUInt16BE(r, 9);
    header.writeUInt16BE(p, 11);
    salt.copy(header, 13);
    const aad = header.subarray(0, AAD_LEN);
    const check = seal(key, ivCheck, aad, CHECK);
    ivCheck.copy(header, AAD_LEN);
    check.tag.copy(header, AAD_LEN + IV_LEN);
    check.ciphertext.copy(header, AAD_LEN + IV_LEN + TAG_LEN);
    ivBody.copy(header, AAD_LEN + IV_LEN + TAG_LEN + CHECK.length);
    const body = seal(key, ivBody, aad, data);
    return Buffer.concat([header, body.ciphertext, body.tag]);
  } finally {
    key.fill(0);
  }
}

function parse(blob) {
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  if (buf.length < HEADER_LEN + TAG_LEN || !buf.subarray(0, 4).equals(MAGIC)) {
    throw new Error('This is not an encrypted SortedWMS backup');
  }
  const version = buf.readUInt8(4);
  if (version !== VERSION) throw new Error(`Encrypted backup version ${version} is not supported`);
  const N = buf.readUInt32BE(5);
  const r = buf.readUInt16BE(9);
  const p = buf.readUInt16BE(11);
  const salt = buf.subarray(13, 13 + SALT_LEN);
  const aad = buf.subarray(0, AAD_LEN);
  let o = AAD_LEN;
  const ivCheck = buf.subarray(o, o + IV_LEN); o += IV_LEN;
  const tagCheck = buf.subarray(o, o + TAG_LEN); o += TAG_LEN;
  const checkCt = buf.subarray(o, o + CHECK.length); o += CHECK.length;
  const ivBody = buf.subarray(o, o + IV_LEN); o += IV_LEN;
  const tagBody = buf.subarray(buf.length - TAG_LEN);
  const ciphertext = buf.subarray(o, buf.length - TAG_LEN);
  return { N, r, p, salt, aad, ivCheck, tagCheck, checkCt, ivBody, tagBody, ciphertext };
}

/** Decrypt a backup. Wrong passphrase and a tampered file are different errors. */
function decrypt(blob, passphrase) {
  if (typeof passphrase !== 'string' || !passphrase) throw new Error('Wrong passphrase');
  const file = parse(blob);
  const key = derive(passphrase, file.salt, file.N, file.r, file.p);
  try {
    let opened;
    try {
      opened = open(key, file.ivCheck, file.aad, file.checkCt, file.tagCheck);
    } catch (e) {
      throw new Error('Wrong passphrase');
    }
    if (opened.length !== CHECK.length || !timingSafeEqual(opened, CHECK)) throw new Error('Wrong passphrase');
    try {
      return open(key, file.ivBody, file.aad, file.ciphertext, file.tagBody);
    } catch (e) {
      throw new Error('The backup was altered');
    }
  } finally {
    key.fill(0);
  }
}

function isEncrypted(blob) {
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  return buf.length >= 4 && buf.subarray(0, 4).equals(MAGIC);
}

module.exports = { encrypt, decrypt, isEncrypted, HEADER_LEN, DEFAULTS, MAGIC, VERSION };
