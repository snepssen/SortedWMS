const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { createAuth } = require('../server/auth');
const { encode, readData } = require('../src/qr');
const { lanAddresses, pairUrl, privateAddress } = require('../server/pairing');

test('a QR round-trips a local pairing URL and the link stays on a private address', () => {
  const url = pairUrl('192.168.1.20', 8080, 'abcdefghij');
  assert.equal(url, 'http://192.168.1.20:8080/pair/abcdefghij');
  assert.equal(privateAddress('8.8.8.8'), false);
  assert.equal(privateAddress('192.168.0.4'), true);
  const addresses = lanAddresses();
  assert.ok(addresses.every((ip) => privateAddress(ip)));
  const qr = encode(url);
  const bytes = readData(qr.matrix, qr.version, qr.mask);
  const bits = [];
  for (const b of bytes) for (let i = 7; i >= 0; i--) bits.push((b >> i) & 1);
  const take = (n) => { let v = 0; for (let i = 0; i < n; i++) v = (v << 1) | bits.shift(); return v; };
  assert.equal(take(4), 0b0100);
  const len = take(8);
  let text = '';
  for (let i = 0; i < len; i++) text += String.fromCharCode(take(8));
  assert.equal(text, url);
});

test('a pairing code is single use, expires, binds the device, times out after 4 hours, and can be revoked', () => {
  let t = Date.UTC(2026, 10, 5, 8);
  const auth = createAuth(new DatabaseSync(':memory:'), { now: () => t, deviceIdleMs: 4 * 60 * 60 * 1000 });
  const user = auth.insertUser({ username: 'mina', password: 'sorted-ok', role: 'picker', displayName: 'Mina' });
  const issued = auth.createPairToken({ userId: user.id, createdBy: user.id });
  const claimed = auth.claimPair({ token: issued.token, userAgent: 'Phone', ip: '192.168.1.9' });
  assert.throws(() => auth.claimPair({ token: issued.token }), /already used/);
  const asPhone = (deviceId) => ({ headers: { cookie: `sorted_session=${encodeURIComponent(claimed.token)}; sorted_device=${encodeURIComponent(deviceId)}` } });
  assert.equal(auth.userFromRequest(asPhone(claimed.deviceId)).username, 'mina');
  assert.equal(auth.userFromRequest(asPhone('someone-else')), null);
  const again = auth.createPairToken({ userId: user.id, createdBy: user.id });
  const second = auth.claimPair({ code: again.code, userAgent: 'Tablet', ip: '10.0.0.4' });
  t += 4 * 60 * 60 * 1000 + 1;
  assert.equal(auth.userFromRequest({ headers: { cookie: `sorted_session=${encodeURIComponent(second.token)}; sorted_device=${encodeURIComponent(second.deviceId)}` } }), null);
  assert.ok(auth.audit(20).some((row) => row.action === 'device-expired'));
  t -= 1000;
  const third = auth.createPairToken({ userId: user.id, createdBy: user.id });
  t += 5 * 60 * 1000 + 1;
  assert.throws(() => auth.claimPair({ token: third.token }), /expired/);
  t -= 5 * 60 * 1000;
  const live = auth.claimPair({ token: auth.createPairToken({ userId: user.id, createdBy: user.id }).token, userAgent: 'Phone', ip: '192.168.1.9' });
  auth.revokeDevice(live.deviceId, 'mina');
  assert.equal(auth.userFromRequest({ headers: { cookie: `sorted_session=${encodeURIComponent(live.token)}; sorted_device=${encodeURIComponent(live.deviceId)}` } }), null);
  const listed = auth.listDevices().find((d) => d.id === live.deviceId);
  assert.ok(listed.revokedAt);
});

test('a paired device in use stays signed in past 4 hours and past a day; the cookie outlives the idle limit', () => {
  let t = Date.UTC(2026, 10, 5, 8);
  const auth = createAuth(new DatabaseSync(':memory:'), { now: () => t, deviceIdleMs: 4 * 60 * 60 * 1000 });
  const user = auth.insertUser({ username: 'sam', password: 'sorted-ok', role: 'administrator', displayName: 'Sam' });
  const claimed = auth.claimPair({ token: auth.createPairToken({ userId: user.id, createdBy: user.id }).token, userAgent: 'Phone', ip: '192.168.1.9' });
  assert.ok(claimed.maxAge > 4 * 60 * 60, 'the browser must not drop the cookie at 4 hours');
  const phone = { headers: { cookie: `sorted_session=${encodeURIComponent(claimed.token)}; sorted_device=${encodeURIComponent(claimed.deviceId)}` } };
  for (let hour = 0; hour < 30; hour++) {
    t += 60 * 60 * 1000;
    assert.equal((auth.userFromRequest(phone) || {}).username, 'sam', `still signed in after ${hour + 1} hours of use`);
  }
  t += 4 * 60 * 60 * 1000 + 1;
  assert.equal(auth.userFromRequest(phone), null);
});
