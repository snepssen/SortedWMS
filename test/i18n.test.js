const test = require('node:test');
const assert = require('node:assert/strict');
const i18n = require('../src/i18n');
const { Warehouse } = require('../src/engine');
const { createAuth } = require('../server/auth');
const { DatabaseSync } = require('node:sqlite');

test('Dutch has every English key, and a missing one fails this test', () => {
  const absent = i18n.missing('nl');
  assert.deepEqual(absent, [], absent.join(', '));
  assert.equal(i18n.t('nl', 'Sign in'), 'Aanmelden');
  assert.equal(i18n.t('en', 'Sign in'), 'Sign in');
  assert.equal(i18n.t('nl', 'not-a-key'), 'not-a-key');
});

test('the user language wins over the warehouse, and dates follow the locale and timezone', () => {
  assert.equal(i18n.choose('nl', 'en'), 'nl');
  assert.equal(i18n.choose('', 'nl'), 'nl');
  assert.equal(i18n.choose('fr', 'nl'), 'nl');
  assert.equal(i18n.choose('', ''), 'en');
  // 23:30 UTC is 00:30 the next day in Brussels.
  const when = Date.UTC(2026, 10, 5, 23, 30);
  assert.equal(i18n.formatDate('nl', when, 'Europe/Brussels'), '06-11-2026');
  assert.equal(i18n.formatDate('en', when, 'Europe/Brussels'), '06/11/2026');
  assert.match(i18n.formatMoney('nl', 12.5, 'EUR'), /12,50/);
  assert.match(i18n.formatMoney('en', 12.5, 'EUR'), /12\.50/);
  assert.equal(i18n.fold('één café'), 'een cafe');
});

test('a user can choose Dutch, and the warehouse default applies when they have not', () => {
  const db = new DatabaseSync(':memory:');
  const auth = createAuth(db);
  const user = auth.insertUser({ username: 'mina', password: 'sorted-ok', role: 'office', displayName: 'Mina' });
  assert.equal(user.language, null);
  const dutch = auth.updateUser(user.id, { language: 'nl' });
  assert.equal(dutch.language, 'nl');
  assert.equal(i18n.choose(dutch.language, 'en'), 'nl');
  const w = new Warehouse({ aisles: [1], bays: 1, levels: 1, positions: [10], outLanes: 1 });
  w.setConfig({ language: 'nl' });
  assert.equal(w.config.language, 'nl');
  assert.equal(i18n.choose(null, w.config.language), 'nl');
});
