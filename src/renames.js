/*
 * Renaming locations without stopping the floor. A location created on this
 * site (by the setup wizard, a profile, or by hand) can get a new code: one at
 * a time, or every location whose code starts the same way. Everything stored
 * there follows the new code; history keeps the code it had then.
 *
 * The old code stays as an alias, so a label still on the shelf, or a scan
 * from habit, finds the location under its new name. Drop the aliases once
 * the new labels are up. Racks from the site file are not renamed here: the
 * truck engine routes by their codes, and they have their own relabelling.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SortedRenames = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const KINDS = ['bin', 'mezzanine', 'rack', 'virtual'];
  const FIXED = ['DOCK-IN', 'IN-TRANSIT'];
  const CODE = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;

  function install(Warehouse) {
    const proto = Warehouse.prototype;

    /** The location an old code now goes by, or null. */
    proto.aliasOf = function (code) {
      const key = String(code || '').trim().toUpperCase();
      return (this.aliases && this.aliases[key]) || null;
    };

    proto._renamable = function (loc) {
      if (!loc) return 'not a location';
      if (!loc.custom) return 'part of the site layout';
      if (!KINDS.includes(loc.kind)) return `a ${loc.kind}`;
      if (FIXED.includes(loc.code) || loc.role === 'transit') return 'a system location';
      return null;
    };

    /**
     * The pairs a rename would make: `pairs` [{ from, to }], or every location
     * whose code starts with `prefix`, with that start replaced by `to`.
     */
    proto.renamePlan = function ({ pairs = null, prefix = null, to = null } = {}) {
      let list;
      if (prefix != null && prefix !== '') {
        const start = String(prefix).trim();
        const next = String(to == null ? '' : to).trim();
        const hits = Object.values(this.locations).filter((l) => l.code.toUpperCase().startsWith(start.toUpperCase()) && !this._renamable(l));
        if (!hits.length) throw new Error(`No location you can rename starts with ${start}`);
        list = hits.map((l) => ({ from: l.code, to: next + l.code.slice(start.length) }));
      } else {
        list = (Array.isArray(pairs) ? pairs : []).map((p) => ({ from: String(p.from || '').trim(), to: String(p.to || '').trim() }));
        if (!list.length) throw new Error('Name a location and its new code, or a start of codes to replace');
      }
      const out = [];
      const taken = new Set();
      const leaving = new Set();
      for (const p of list) {
        const code = this.locations[p.from] ? p.from : this.resolve(p.from);
        const loc = this.locations[code];
        const why = this._renamable(loc);
        if (why) throw new Error(`${p.from} is ${why}; it cannot be renamed here`);
        leaving.add(loc.code.toUpperCase());
        out.push({ from: loc.code, to: p.to });
      }
      for (const p of out) {
        if (!CODE.test(p.to)) throw new Error(`${p.to || 'An empty code'} is not a code: letters, digits and hyphens`);
        const key = p.to.toUpperCase();
        if (key === p.from.toUpperCase()) throw new Error(`${p.from} already has that code`);
        if (taken.has(key)) throw new Error(`Two locations would both be ${p.to}`);
        taken.add(key);
        const clash = Object.keys(this.locations).find((c) => c.toUpperCase() === key);
        if (clash && !leaving.has(clash.toUpperCase())) throw new Error(`${p.to} is already a location`);
        const alias = this.aliasOf(key);
        if (alias && alias !== p.from) throw new Error(`${p.to} is the old code of ${alias}. Drop that alias first`);
      }
      return out.sort((a, b) => a.from.localeCompare(b.from, undefined, { numeric: true }));
    };

    proto.renameLocations = function (input = {}) {
      const plan = this.renamePlan(input);
      if (plan.length > 5000) throw new Error('That is more than 5000 locations at once');
      const map = new Map(plan.map((p) => [p.from, p.to]));
      const swap = (code) => (code != null && map.has(code) ? map.get(code) : code);
      // Re-key the locations first, all together, so a chain (A→B, B→C) works.
      const moved = plan.map((p) => [p, this.locations[p.from]]);
      for (const [p] of moved) delete this.locations[p.from];
      this.aliases = this.aliases || {};
      for (const [p, loc] of moved) {
        loc.code = p.to;
        if (!loc.name || loc.name === p.from) loc.name = p.to;
        this.locations[p.to] = loc;
        delete this.aliases[p.to.toUpperCase()];
        this.aliases[p.from.toUpperCase()] = p.to;
      }
      // Older aliases that pointed at a renamed code follow it.
      for (const [old, target] of Object.entries(this.aliases)) if (map.has(target)) this.aliases[old] = map.get(target);
      for (const loc of Object.values(this.locations)) if (loc.parent && map.has(loc.parent)) loc.parent = map.get(loc.parent).toUpperCase();
      for (const p of Object.values(this.pallets)) { p.loc = swap(p.loc); if (p.missingFrom) p.missingFrom = swap(p.missingFrom); }
      for (const h of Object.values(this.holders || {})) h.loc = swap(h.loc);
      for (const t of Object.values(this.tasks)) { t.from = swap(t.from); t.to = swap(t.to); }
      for (const t of Object.values(this.trucks || {})) t.position = swap(t.position);
      for (const d of Object.values(this.desks || {})) d.position = swap(d.position);
      if (this.binStock) for (const p of plan) if (this.binStock[p.from]) { this.binStock[p.to] = this.binStock[p.from]; delete this.binStock[p.from]; }
      for (const w of Object.values(this.waves || {})) for (const t of w.tasks) { t.loc = swap(t.loc); t.dropTo = swap(t.dropTo); }
      for (const c of Object.values(this.checks || {})) c.loc = swap(c.loc);
      for (const o of Object.values(this.orders)) for (const s of o.staged || []) { s.holder = swap(s.holder); if (s.at) s.at = swap(s.at); }
      if (this.waveConfig && this.waveConfig.postPick) this.waveConfig.postPick = swap(this.waveConfig.postPick);
      if (typeof this._forgetPlaces === 'function') this._forgetPlaces();
      const actor = this._actor || 'admin';
      this.renames = this.renames || [];
      this.renames.unshift({ t: this.now(), by: actor, pairs: plan });
      if (this.renames.length > 200) this.renames.length = 200;
      this.log(`Renamed ${plan.length} location${plan.length === 1 ? '' : 's'}: ${plan.slice(0, 3).map((p) => `${p.from} → ${p.to}`).join(', ')}${plan.length > 3 ? ', …' : ''}. The old codes still scan`, { by: actor });
      return { renamed: plan.length, pairs: plan };
    };

    /** Old codes that still scan, with the location each one finds now. */
    proto.aliasList = function () {
      return Object.entries(this.aliases || {}).map(([old, code]) => ({ old, code })).sort((a, b) => a.old.localeCompare(b.old, undefined, { numeric: true }));
    };

    /** Stop old codes scanning: one, those starting with `prefix`, or all. */
    proto.dropAliases = function ({ code = null, prefix = null, all = false } = {}) {
      const start = String(prefix || '').trim().toUpperCase();
      const one = String(code || '').trim().toUpperCase();
      if (!all && !one && !start) throw new Error('Say which old codes to drop: one, a start of codes, or all');
      const before = Object.keys(this.aliases || {}).length;
      if (!before) return { dropped: 0, left: 0 };
      for (const old of Object.keys(this.aliases)) {
        if (all || old === one || (start && old.startsWith(start))) delete this.aliases[old];
      }
      const left = Object.keys(this.aliases).length;
      this.log(`Dropped ${before - left} old location code${before - left === 1 ? '' : 's'}`);
      return { dropped: before - left, left };
    };
  }

  return { install };
});
