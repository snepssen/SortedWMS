'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('running it safely covers the proxy, the firewall, both services, and a restore', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'docs', 'RUNNING.md'), 'utf8');
  for (const bit of ['Caddy', 'nginx', '2323', 'systemd', 'launchd', 'SORTED_BACKUP_PASSPHRASE', 'reverse_proxy', 'proxy_pass']) {
    assert.ok(text.includes(bit), bit);
  }
  assert.match(text, /LAN only|warehouse LAN/i);
  assert.match(text, /new machine/i);
});
