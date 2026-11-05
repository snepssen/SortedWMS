/*
 * ABC cycle counting. Items or locations are A, B or C from how fast they
 * move, or from their value, over a window. Each class has a count frequency.
 * A warehouse gets one list per local day. The counter does not see the
 * booked quantity. A variance over the threshold is recounted by someone
 * else, then a supervisor approves it, and only then does stock change.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SortedAbc = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DAY = 86400000;
  const REASONS = ['recount', 'damage', 'found', 'missing', 'wrong-item', 'expiry', 'other'];
  const CLASSES = ['A', 'B', 'C'];

  function whole(value, label) {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0) throw new Error(`${label} is a whole number, 0 or more`);
    return n;
  }

  function qtyAt(wh, loc, itemNo) {
    const place = wh.locations[loc];
    if (!place) return 0;
    let n = 0;
    const take = (id) => {
      const p = wh.pallets[id];
      if (p && p.itemNo === itemNo && p.status !== 'shipped' && p.loc === loc) n += p.qty;
    };
    if (place.sscc) take(place.sscc);
    for (const id of place.pallets || []) take(id);
    for (const line of (wh.binStock && wh.binStock[loc]) || []) if (line.itemNo === itemNo) n += line.qty;
    return n;
  }

  function itemOfMove(wh, move) {
    if (move.sscc && wh.pallets[move.sscc]) return wh.pallets[move.sscc].itemNo;
    const note = String(move.note || '').split(/\s+/)[0];
    if (note && wh.items[note]) return note;
    return null;
  }

  function install(Warehouse) {
    const proto = Warehouse.prototype;

    function requireOn(wh) {
      if (typeof wh.module === 'function' && !wh.module('abc')) throw new Error('ABC cycle counting is switched off');
    }

    proto.abcSettings = function () {
      const saved = this.abcConfig || {};
      const frequency = { A: 7, B: 30, C: 90, ...(saved.frequency || {}) };
      return {
        windowDays: saved.windowDays == null ? 30 : saved.windowDays,
        basis: saved.basis === 'value' ? 'value' : 'velocity',
        classify: saved.classify === 'location' ? 'location' : 'item',
        frequency,
        thresholdQty: saved.thresholdQty == null ? 0 : saved.thresholdQty,
        thresholdPercent: saved.thresholdPercent == null ? 0 : saved.thresholdPercent,
        maxPerDay: saved.maxPerDay == null ? 40 : saved.maxPerDay,
        blind: saved.blind !== false,
      };
    };

    proto.setAbc = function (patch = {}) {
      requireOn(this);
      const next = { ...this.abcSettings(), ...(patch || {}) };
      if (patch.frequency) next.frequency = { ...this.abcSettings().frequency, ...patch.frequency };
      next.windowDays = whole(next.windowDays, 'Window');
      if (next.windowDays < 1 || next.windowDays > 366) throw new Error('The window is 1 to 366 days');
      if (next.basis !== 'value' && next.basis !== 'velocity') throw new Error('Classify by velocity or value');
      if (next.classify !== 'item' && next.classify !== 'location') throw new Error('Classify items or locations');
      for (const cls of CLASSES) next.frequency[cls] = whole(next.frequency[cls], `Class ${cls}`);
      next.thresholdQty = whole(next.thresholdQty, 'Quantity threshold');
      const pct = Number(next.thresholdPercent);
      if (!Number.isFinite(pct) || pct < 0 || pct > 100) throw new Error('The percent threshold is 0 to 100');
      next.thresholdPercent = pct;
      next.maxPerDay = whole(next.maxPerDay, 'Daily list');
      if (next.maxPerDay < 1 || next.maxPerDay > 500) throw new Error('The daily list is 1 to 500 counts');
      next.blind = Boolean(next.blind);
      this.abcConfig = next;
      this.log(`ABC counts: ${next.basis}, ${next.classify}, window ${next.windowDays} days, A/${next.frequency.A} B/${next.frequency.B} C/${next.frequency.C}, recount over ${next.thresholdQty} or ${next.thresholdPercent}%`);
      return this.abcSettings();
    };

    proto.setAbcClass = function (itemNo, cls) {
      requireOn(this);
      const item = this.items[itemNo];
      if (!item) throw new Error(`Unknown item ${itemNo}`);
      const name = cls == null || cls === '' ? null : String(cls).toUpperCase();
      if (name && !CLASSES.includes(name)) throw new Error('Class is A, B or C');
      item.abcClass = name;
      this.log(`${itemNo} cycle-count class ${name || 'cleared'}`);
      return { itemNo, class: name };
    };

    /** Scores from picks and shipments in the window. A location's score is what left it. */
    proto._abcScores = function () {
      const settings = this.abcSettings();
      const since = this.now() - settings.windowDays * DAY;
      const items = {};
      const locations = {};
      for (const move of this.movements || []) {
        if (!move.t || move.t < since) continue;
        if (move.event !== 'picked' && move.event !== 'shipped') continue;
        const itemNo = itemOfMove(this, move);
        if (!itemNo) continue;
        const qty = Math.abs(Number(move.qty) || 0);
        const value = Number(this.items[itemNo] && this.items[itemNo].value) || 0;
        const score = settings.basis === 'value' ? qty * (value || 0) : qty;
        items[itemNo] = (items[itemNo] || 0) + score;
        if (move.from) locations[move.from] = (locations[move.from] || 0) + score;
      }
      return { items, locations };
    };

    function rank(scores) {
      const rows = Object.entries(scores).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
      const total = rows.reduce((s, [, n]) => s + n, 0) || 1;
      const out = {};
      let run = 0;
      rows.forEach(([id, score], i) => {
        const before = run / total;
        run += score;
        if (i === 0 || before < 0.8) out[id] = 'A';
        else if (before < 0.95) out[id] = 'B';
        else out[id] = 'C';
      });
      return out;
    }

    proto.abcClasses = function () {
      requireOn(this);
      const scores = this._abcScores();
      const settings = this.abcSettings();
      const ranked = rank(settings.classify === 'location' ? scores.locations : scores.items);
      const items = {};
      for (const item of Object.values(this.items)) {
        if (item.status === 'archived') continue;
        items[item.itemNo] = {
          itemNo: item.itemNo,
          name: item.name,
          score: scores.items[item.itemNo] || 0,
          class: item.abcClass || ranked[item.itemNo] || 'C',
          fixed: Boolean(item.abcClass),
        };
      }
      const locations = {};
      for (const [code, score] of Object.entries(scores.locations)) locations[code] = { code, score, class: ranked[code] || 'C' };
      return { basis: settings.basis, classify: settings.classify, windowDays: settings.windowDays, items, locations };
    };

    proto._abcClassOf = function (loc, itemNo) {
      const item = this.items[itemNo];
      if (item && item.abcClass) return item.abcClass;
      const classes = this.abcClasses();
      if (this.abcSettings().classify === 'location') return (classes.locations[loc] && classes.locations[loc].class) || 'C';
      return (classes.items[itemNo] && classes.items[itemNo].class) || 'C';
    };

    proto._abcLast = function (loc, itemNo) {
      let last = null;
      for (const day of Object.values(this.abcDays || {})) {
        for (const line of day.lines || []) {
          if (line.loc === loc && line.itemNo === itemNo && (line.status === 'adjusted' || line.status === 'matched') && line.closedAt) {
            if (!last || line.closedAt > last) last = line.closedAt;
          }
        }
      }
      return last;
    };

    proto.planAbcDay = function ({ force = false } = {}) {
      requireOn(this);
      const day = this.localDay();
      this.abcDays = this.abcDays || {};
      const existing = this.abcDays[day];
      if (existing && !force) return this._abcDayView(existing, false);
      if (existing && force && (existing.lines || []).some((line) => line.status !== 'open')) throw new Error("Today's list already has counts. It stays as it is");
      const settings = this.abcSettings();
      const seen = new Set();
      const candidates = [];
      const consider = (loc, itemNo) => {
        if (!loc || !this.items[itemNo] || this.items[itemNo].status === 'archived') return;
        const key = `${loc}|${itemNo}`;
        if (seen.has(key)) return;
        const expected = qtyAt(this, loc, itemNo);
        if (expected < 1) return;
        seen.add(key);
        const cls = this._abcClassOf(loc, itemNo);
        const freq = settings.frequency[cls] || 90;
        const last = this._abcLast(loc, itemNo);
        const age = last == null ? Infinity : (this.now() - last) / DAY;
        if (age < freq) return;
        candidates.push({ loc, itemNo, class: cls, age });
      };
      for (const [code, lines] of Object.entries(this.binStock || {})) for (const line of lines) consider(code, line.itemNo);
      for (const pallet of Object.values(this.pallets)) {
        if (!pallet.loc || pallet.status === 'shipped') continue;
        consider(pallet.loc, pallet.itemNo);
      }
      const order = { A: 0, B: 1, C: 2 };
      candidates.sort((a, b) => order[a.class] - order[b.class] || b.age - a.age || (a.loc < b.loc ? -1 : 1));
      const lines = candidates.slice(0, settings.maxPerDay).map((row, i) => ({
        id: `ABC-${day.replace(/-/g, '')}-${i + 1}`,
        loc: row.loc,
        itemNo: row.itemNo,
        class: row.class,
        status: 'open',
        counts: [],
      }));
      const book = { day, createdAt: this.now(), lines };
      this.abcDays[day] = book;
      this.log(`ABC count list ${day}: ${lines.length} location${lines.length === 1 ? '' : 's'}`);
      return this._abcDayView(book, false);
    };

    function findLine(wh, id) {
      for (const book of Object.values(wh.abcDays || {})) {
        const line = (book.lines || []).find((row) => row.id === id);
        if (line) return { book, line };
      }
      return null;
    }

    proto._abcFind = function (id) {
      const found = findLine(this, id);
      if (!found) throw new Error(`No cycle count ${id}`);
      return found;
    };

    function overThreshold(expected, counted, settings) {
      const diff = Math.abs(counted - expected);
      if (diff === 0) return false;
      const qtyOn = settings.thresholdQty > 0;
      const pctOn = settings.thresholdPercent > 0;
      // Both zero means any difference is over the line.
      if (!qtyOn && !pctOn) return true;
      if (qtyOn && diff > settings.thresholdQty) return true;
      if (pctOn && expected > 0 && (diff / expected) * 100 > settings.thresholdPercent) return true;
      if (pctOn && expected === 0 && counted !== 0) return true;
      return false;
    }

    function applyQty(wh, loc, itemNo, target, reason, by) {
      const place = wh.locations[loc];
      if (!place) throw new Error(`Unknown location ${loc}`);
      const before = qtyAt(wh, loc, itemNo);
      if (before === target) return { before, after: target };
      if ((place.kind === 'bin' || place.kind === 'mezzanine') && typeof wh.binCount === 'function') {
        const mapped = { damage: 'damage', expiry: 'expiry', found: 'found', other: 'other', correction: 'correction' }[reason] || 'recount';
        const out = wh.binCount({ loc, itemNo, counted: target, reason: mapped, by });
        return { before: out.before, after: out.after };
      }
      const pallet = (place.sscc && wh.pallets[place.sscc] && wh.pallets[place.sscc].itemNo === itemNo && wh.pallets[place.sscc])
        || Object.values(wh.pallets).find((p) => p.loc === loc && p.itemNo === itemNo && p.status !== 'shipped');
      if (!pallet) throw new Error(`No ${itemNo} at ${loc} to adjust`);
      pallet.qty = target;
      if (target === 0) {
        wh._remove(pallet);
        pallet.status = 'shipped';
        pallet.removed = 'counted';
      }
      wh.adjustments = wh.adjustments || [];
      wh.adjustments.unshift({ t: wh.now(), loc, sscc: pallet.sscc, itemNo, before, after: target, reason: reason || 'recount', by });
      wh.recordMovement({ sscc: pallet.sscc, holder: pallet.holderId || null, from: loc, to: loc, qty: target - before, event: 'counted', by, note: `${itemNo} ${before} → ${target} (${reason || 'match'})` });
      return { before, after: target };
    }

    function recordCount(wh, line, by, qty, reason, kind) {
      const settings = wh.abcSettings();
      const expected = line.expected == null ? qtyAt(wh, line.loc, line.itemNo) : line.expected;
      if (line.expected == null) line.expected = expected;
      if (qty !== expected && !REASONS.includes(reason)) throw new Error(`Reason is one of ${REASONS.join(', ')}`);
      line.counts.push({ t: wh.now(), by, qty, reason: reason || null, kind });
      const over = overThreshold(expected, qty, settings);
      return { expected, over };
    }

    proto.submitAbc = function ({ id, qty, reason = null, by } = {}) {
      requireOn(this);
      const { line } = this._abcFind(id);
      if (line.status !== 'open') throw new Error(`Count ${id} is ${line.status}`);
      const actor = by || this._actor || 'stock';
      const counted = whole(qty, 'Counted quantity');
      const { expected, over } = recordCount(this, line, actor, counted, reason, 'count');
      if (!over) {
        const applied = applyQty(this, line.loc, line.itemNo, counted, reason, actor);
        line.status = counted === expected ? 'matched' : 'adjusted';
        line.closedAt = this.now();
        line.adjustment = { ...applied, reason: reason || null, by: actor };
        this.log(`ABC ${id} ${line.loc} ${line.itemNo}: ${actor} counted ${counted}, booked ${expected}, ${line.status}${reason ? ` (${reason})` : ''}`);
        return this._abcPublic(line, false);
      }
      line.status = 'recount';
      this.log(`ABC ${id} ${line.loc} ${line.itemNo}: ${actor} counted ${counted} against ${expected}. Variance over the threshold, recount by someone else (${reason})`);
      return this._abcPublic(line, false);
    };

    proto.recountAbc = function ({ id, qty, reason = null, by } = {}) {
      requireOn(this);
      const { line } = this._abcFind(id);
      if (line.status !== 'recount') throw new Error(`Count ${id} is not waiting for a recount`);
      const actor = by || this._actor || 'stock';
      const first = line.counts[0];
      if (first && first.by === actor) throw new Error('A different person recounts this');
      const counted = whole(qty, 'Recount');
      recordCount(this, line, actor, counted, reason, 'recount');
      line.status = 'approval';
      this.log(`ABC ${id} recounted by ${actor}: ${counted}${reason ? ` (${reason})` : ''}. Waiting for approval before stock changes`);
      return this._abcPublic(line, false);
    };

    proto.approveAbc = function ({ id, by } = {}) {
      requireOn(this);
      const { line } = this._abcFind(id);
      if (line.status !== 'approval') throw new Error(`Count ${id} is not waiting for approval`);
      const actor = by || this._actor || 'manager';
      if (line.counts.some((c) => c.by === actor)) throw new Error('The approver is not the person who counted or recounted');
      const recount = [...line.counts].reverse().find((c) => c.kind === 'recount');
      const qty = recount ? recount.qty : line.counts[line.counts.length - 1].qty;
      const reason = (recount && recount.reason) || line.counts[0].reason || 'recount';
      const applied = applyQty(this, line.loc, line.itemNo, qty, reason, actor);
      line.status = 'adjusted';
      line.closedAt = this.now();
      line.approvedBy = actor;
      line.adjustment = { ...applied, reason, by: actor };
      this.log(`ABC ${id} approved by ${actor}: ${line.loc} ${line.itemNo} set to ${qty} (${reason})`);
      return this._abcPublic(line, true);
    };

    proto.rejectAbc = function ({ id, reason, by } = {}) {
      requireOn(this);
      const { line } = this._abcFind(id);
      if (line.status !== 'approval' && line.status !== 'recount') throw new Error(`Count ${id} cannot be rejected`);
      const why = String(reason || '').trim();
      if (!why) throw new Error('A rejection needs a reason');
      const actor = by || this._actor || 'manager';
      line.status = 'rejected';
      line.closedAt = this.now();
      line.rejectedBy = actor;
      line.rejectReason = why;
      this.log(`ABC ${id} rejected by ${actor}: ${why}. Stock stays at the booked quantity`);
      return this._abcPublic(line, true);
    };

    proto._abcPublic = function (line, reveal) {
      const item = this.items[line.itemNo] || {};
      const show = Boolean(reveal) || !this.abcSettings().blind || line.status === 'adjusted' || line.status === 'matched' || line.status === 'rejected';
      return {
        id: line.id,
        loc: line.loc,
        itemNo: line.itemNo,
        name: item.name || '',
        class: line.class,
        status: line.status,
        expected: show ? line.expected : null,
        blind: !show,
        counts: (line.counts || []).map((c) => ({ t: c.t, by: c.by, qty: c.qty, reason: c.reason, kind: c.kind, day: this.localDay(c.t) })),
        adjustment: line.adjustment || null,
        approvedBy: line.approvedBy || null,
        rejectedBy: line.rejectedBy || null,
        rejectReason: line.rejectReason || null,
      };
    };

    proto._abcDayView = function (book, reveal) {
      return {
        day: book.day,
        createdAt: book.createdAt,
        settings: this.abcSettings(),
        lines: (book.lines || []).map((line) => this._abcPublic(line, reveal)),
      };
    };

    proto.abcBoard = function ({ reveal = false, status = null, cls = null } = {}) {
      requireOn(this);
      const day = this.localDay();
      const book = (this.abcDays || {})[day] || { day, createdAt: null, lines: [] };
      let lines = book.lines || [];
      if (status) lines = lines.filter((line) => line.status === status);
      if (cls) lines = lines.filter((line) => line.class === String(cls).toUpperCase());
      const view = this._abcDayView({ ...book, lines }, reveal);
      view.approval = (book.lines || []).filter((line) => line.status === 'approval').length;
      view.timeZone = this.timeZone();
      return view;
    };

    /** The next line for this person: an open count, or a recount they did not start. */
    proto.abcMine = function (by) {
      requireOn(this);
      const day = this.localDay();
      const book = (this.abcDays || {})[day];
      if (!book) return null;
      const actor = by || this._actor || '';
      const line = (book.lines || []).find((row) => row.status === 'open')
        || (book.lines || []).find((row) => row.status === 'recount' && row.counts[0] && row.counts[0].by !== actor);
      return line ? this._abcPublic(line, false) : null;
    };

    proto.abcCsv = function ({ reveal = false } = {}) {
      const board = this.abcBoard({ reveal });
      const head = ['day', 'id', 'location', 'item', 'class', 'status', 'expected', 'counted', 'reason', 'by'];
      const rows = [head];
      for (const line of board.lines) {
        const last = line.counts[line.counts.length - 1];
        rows.push([board.day, line.id, line.loc, line.itemNo, line.class, line.status, line.expected == null ? '' : line.expected, last ? last.qty : '', last ? (last.reason || '') : '', last ? last.by : '']);
      }
      return rows.map((r) => r.map((c) => `"${String(c == null ? '' : c).replace(/"/g, '""')}"`).join(',')).join('\n');
    };
  }

  return { install, REASONS, CLASSES };
});
