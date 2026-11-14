/*
 * Photo files next to the warehouse database. The bytes are checked here.
 * The journal only stores the name, the type and the size.
 */
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');

const MAX_BYTES = 512 * 1024;
const TYPES = { jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };
const EXT = { jpeg: 'jpg', png: 'png', gif: 'gif', webp: 'webp' };

function sniff(buf) {
  if (!buf || buf.length < 6) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG') return 'png';
  if (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a') return 'gif';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

function accept(input) {
  let text = String(input || '').trim();
  const comma = text.indexOf(',');
  if (text.startsWith('data:') && comma !== -1 && text.slice(0, comma).includes(';base64')) text = text.slice(comma + 1);
  text = text.replace(/\s/g, '');
  if (!text) throw new Error('Choose a photo');
  if (text.length > Math.ceil(MAX_BYTES / 3) * 4 + 16) throw new Error('A photo can be at most 512 KB');
  const buf = Buffer.from(text, 'base64');
  if (!buf.length) throw new Error('Choose a photo');
  if (buf.length > MAX_BYTES) throw new Error('A photo can be at most 512 KB');
  const type = sniff(buf);
  if (!type) throw new Error('A photo must be a JPEG, PNG, GIF or WebP');
  return { buf, type };
}

function newId() {
  return randomBytes(8).toString('hex');
}

function dir(store) {
  if (!store || !store.file || store.file === ':memory:') throw new Error('Photos are stored next to the warehouse database');
  return path.join(path.dirname(path.resolve(store.file)), 'item-photos');
}

function safeItem(itemNo) {
  const name = String(itemNo || '');
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(name)) throw new Error('This item number cannot be stored as a file name');
  return name;
}

function fileFor(root, itemNo, id, type) {
  if (!/^[a-f0-9]{16}$/.test(String(id || ''))) throw new Error('Bad photo');
  const ext = EXT[type];
  if (!ext) throw new Error('A photo must be a JPEG, PNG, GIF or WebP');
  const base = path.resolve(root);
  const folder = path.resolve(base, safeItem(itemNo));
  const file = path.resolve(folder, `${id}.${ext}`);
  if (folder !== base && !folder.startsWith(base + path.sep)) throw new Error('Bad photo path');
  if (!file.startsWith(folder + path.sep)) throw new Error('Bad photo path');
  return file;
}

function write(root, itemNo, id, type, buf) {
  const file = fileFor(root, itemNo, id, type);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, buf, { mode: 0o600 });
  return file;
}

function read(root, itemNo, id, type) {
  const file = fileFor(root, itemNo, id, type);
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file);
}

function remove(file) {
  try { fs.unlinkSync(file); } catch (e) { /* already gone */ }
}

function mime(type) {
  return TYPES[type] || 'application/octet-stream';
}

module.exports = { MAX_BYTES, sniff, accept, newId, dir, write, read, remove, mime };
