/*
 * ABC cycle counting. Off hides the list, the handheld count card and the
 * approval queue. Counts already taken stay.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.SortedModules = root.SortedModules || []).push(api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  return {
    id: 'abc',
    name: 'ABC cycle counts',
    description: 'Class items or locations A, B or C by how fast they move or by value, count each class on its own rhythm, and hold a blind count for a recount and a supervisor when the variance is over the threshold. The count history stays when this is off.',
    version: 1,
    dependencies: [],
    conflicts: [],
    permissions: [{ id: 'counts.approve', label: 'Approve a cycle-count variance' }],
    routes: [
      { method: 'GET', pattern: '^/api/abc(?:/|$)' },
      { method: 'POST', pattern: '^/api/abc(?:/|$)' },
    ],
    menu: [
      { id: 'abc', label: 'Cycle counts', slot: 'app' },
    ],
    handheld: [],
    settings: {
      type: 'object',
      properties: {
        windowDays: { type: 'integer', title: 'Days of history for the class', default: 30 },
        thresholdQty: { type: 'integer', title: 'Recount when the quantity is off by more than', default: 2 },
        thresholdPercent: { type: 'number', title: 'Or when the percent is over', default: 5 },
      },
    },
    presets: { 'chilled-dc': true, 'high-value': true, 'home-garage': true, 'small-maker': true, '3pl': true },
    upgrades: [{
      version: 1,
      id: 'abc-kept',
      up(db) {
        db.prepare("INSERT INTO module_settings (module, key, value) VALUES ('abc', 'kept', '1') ON CONFLICT(module, key) DO NOTHING").run();
      },
    }, {
      version: 2,
      id: 'abc-recount-defaults',
      up(db) {
        // Warehouses saved at 0 and 0% used the old default: any difference waited
        // for a recount. Move those to 2 pieces or 5%. A later explicit 0 and 0 stays.
        const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
        const rewriteState = (text) => {
          let state;
          try { state = JSON.parse(text); } catch (e) { return null; }
          const cfg = state && state.abcConfig;
          if (!cfg || Number(cfg.thresholdQty) !== 0 || Number(cfg.thresholdPercent) !== 0) return null;
          if (!Object.prototype.hasOwnProperty.call(cfg, 'thresholdQty') || !Object.prototype.hasOwnProperty.call(cfg, 'thresholdPercent')) return null;
          cfg.thresholdQty = 2;
          cfg.thresholdPercent = 5;
          return JSON.stringify(state);
        };
        const rewriteArgs = (text) => {
          let args;
          try { args = JSON.parse(text); } catch (e) { return null; }
          const settings = args && (args.settings || args);
          if (!settings || typeof settings !== 'object') return null;
          if (!Object.prototype.hasOwnProperty.call(settings, 'thresholdQty') || !Object.prototype.hasOwnProperty.call(settings, 'thresholdPercent')) return null;
          if (Number(settings.thresholdQty) !== 0 || Number(settings.thresholdPercent) !== 0) return null;
          settings.thresholdQty = 2;
          settings.thresholdPercent = 5;
          return JSON.stringify(args);
        };
        if (tables.has('snapshots')) {
          const update = db.prepare('UPDATE snapshots SET state = ? WHERE id = ?');
          for (const row of db.prepare('SELECT id, state FROM snapshots').all()) {
            const next = rewriteState(row.state);
            if (next) update.run(next, row.id);
          }
        }
        if (tables.has('extra_sites')) {
          const update = db.prepare('UPDATE extra_sites SET state = ? WHERE id = ?');
          for (const row of db.prepare('SELECT id, state FROM extra_sites').all()) {
            const next = rewriteState(row.state);
            if (next) update.run(next, row.id);
          }
        }
        if (tables.has('journal')) {
          const update = db.prepare('UPDATE journal SET args = ? WHERE id = ?');
          for (const row of db.prepare("SELECT id, args FROM journal WHERE op = 'setAbc'").all()) {
            const next = rewriteArgs(row.args);
            if (next) update.run(next, row.id);
          }
        }
        if (tables.has('extra_journal')) {
          const update = db.prepare('UPDATE extra_journal SET args = ? WHERE id = ?');
          for (const row of db.prepare("SELECT id, args FROM extra_journal WHERE op = 'setAbc'").all()) {
            const next = rewriteArgs(row.args);
            if (next) update.run(next, row.id);
          }
        }
      },
    }],
  };
});