const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Warehouse } = require('../src/engine');
const { Store } = require('../server/store');
const abc = require('../modules/abc');

function wh() {
  const w = new Warehouse({ aisles: [1], bays: 2, levels: 1, positions: [10], outLanes: 1, clock: () => Date.UTC(2026, 10, 5, 10) });
  w.addItem({ itemNo: 'N1', name: 'Nail', category: 'GEN', palletQty: 10 });
  w.createLocation({ code: 'BIN-A', kind: 'bin', name: 'Bin A' });
  w.binPut({ loc: 'BIN-A', itemNo: 'N1', qty: 100 });
  return w;
}

test('a new warehouse posts a small difference and a class can be stricter', () => {
  const w = wh();
  const settings = w.abcSettings();
  assert.equal(settings.thresholdQty, 2);
  assert.equal(settings.thresholdPercent, 5);
  assert.equal(settings.classThresholds.A.qty, null);
  w.setAbc({ frequency: { A: 1, B: 1, C: 1 } });
  w.recordMovement({ from: 'BIN-A', to: 'ORDER-1', qty: 10, event: 'picked', by: 'picker', note: 'N1' });
  const line = w.planAbcDay().lines.find((row) => row.itemNo === 'N1');
  const posted = w.submitAbc({ id: line.id, qty: 101, reason: 'recount', by: 'ina' });
  assert.equal(posted.status, 'adjusted', 'one piece on 100 is inside 2 and 5%');

  const strict = wh();
  strict.setAbc({ frequency: { A: 1, B: 1, C: 1 }, classThresholds: { A: { qty: 0, percent: 0 }, B: { qty: null, percent: null }, C: { qty: null, percent: null } } });
  strict.setAbcClass('N1', 'A');
  strict.recordMovement({ from: 'BIN-A', to: 'ORDER-1', qty: 10, event: 'picked', by: 'picker', note: 'N1' });
  const again = strict.planAbcDay().lines.find((row) => row.itemNo === 'N1');
  const held = strict.submitAbc({ id: again.id, qty: 99, reason: 'recount', by: 'ina' });
  assert.equal(held.status, 'recount', 'class A at 0 and 0 holds every difference');
});

test('warehouses saved at 0 and 0 move to 2 and 5, and a later 0 and 0 stays', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sorted-abc-')), 'wms.db');
  const site = { name: 'Count', categories: { GEN: 'General' }, layout: { aisles: [1], bays: 1, levels: 1, positions: [10], outLanes: 1 } };
  const v1 = [{ id: 'abc', upgrades: abc.upgrades.filter((step) => step.version < 2) }];
  const both = [{ id: 'abc', upgrades: abc.upgrades }];
  const first = new Store({ file, site, moduleUpgrades: v1, backupDir: null });
  first.exec('setAbc', { settings: { thresholdQty: 0, thresholdPercent: 0, frequency: { A: 1, B: 1, C: 1 } } }, 'maya');
  assert.equal(first.wh.abcSettings().thresholdQty, 0);
  first.close();

  const upgraded = new Store({ file, site: null, moduleUpgrades: both, backupDir: null });
  assert.equal(upgraded.wh.abcSettings().thresholdQty, 2);
  assert.equal(upgraded.wh.abcSettings().thresholdPercent, 5);
  assert.ok(upgraded.upgradeReport.applied.some((step) => step.id === 'abc-recount-defaults'));
  upgraded.exec('setAbc', { settings: { thresholdQty: 0, thresholdPercent: 0 } }, 'maya');
  upgraded.close();

  const kept = new Store({ file, site: null, moduleUpgrades: both, backupDir: null });
  assert.equal(kept.wh.abcSettings().thresholdQty, 0);
  assert.equal(kept.wh.abcSettings().thresholdPercent, 0);
  assert.equal(kept.upgradeReport.applied.some((step) => step.id === 'abc-recount-defaults'), false);
  kept.close();
});
