/*
 * Client item list, mover ranking and stock-removal requests.
 *
 * The client writes the description. A manager or administrator can override
 * it; the journal line carries the reason. Stock leaves only when warehouse
 * staff confirm a request. The client never posts a quantity onto a location.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SortedClientItems = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DAY = 86400000;
  const KINDS = { disposal: 'disposal', 'write-off': 'write-off', collected: 'collected' };
  const KIND_ALIAS = { writeoff: 'write-off', 'write off': 'write-off', collection: 'collected', collect: 'collected' };

  function fail(message, status) {
    const err = new Error(message);
    if (status) err.status = status;
    throw err;
  }

  function whole(value, label) {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1) fail(`${label} must be a whole number above 0`);
    return n;
  }

  function kindOf(raw) {
    const key = String(raw || '').trim().toLowerCase();
    const kind = KINDS[key] || KIND_ALIAS[key];
    if (!kind) fail('Kind is disposal, write-off or collected');
    return kind;
  }

  function noteOf(raw, label) {
    const text = String(raw || '').trim();
    if (!text) fail(`${label} is required`);
    if (text.length > 500) fail(`${label} is too long`);
    return text;
  }

  function dayOk(value) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
  }

  function daysBetween(fromDay, toDay) {
    const a = Date.parse(`${fromDay}T00:00:00Z`);
    const b = Date.parse(`${toDay}T00:00:00Z`);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    return Math.round((b - a) / DAY);
  }

  function inRange(wh, t, from, to) {
    if (t == null) return false;
    const day = wh.localDay(t);
    if (from && day < from) return false;
    if (to && day > to) return false;
    return true;
  }

  function activeClients(wh) {
    return Object.values(wh.clients || {}).filter((c) => c.status !== 'archived');
  }

  function singleOwner(wh) {
    const list = activeClients(wh);
    return list.length === 1 ? list[0].id : null;
  }

  function ownerWarehouse(wh) {
    return activeClients(wh).length <= 1;
  }

  function actorOf(actor) {
    if (!actor || typeof actor !== 'object') return null;
    return {
      role: actor.role || null,
      clientId: actor.clientId ? String(actor.clientId).toUpperCase() : null,
      service: Boolean(actor.service),
    };
  }

  function isClient(actor) {
    return Boolean(actor && actor.role === 'client');
  }

  function isManager(actor) {
    return Boolean(actor && (actor.role === 'administrator' || actor.role === 'manager' || actor.service));
  }

  function owns(wh, item, actor) {
    if (!isClient(actor)) return true;
    const id = actor.clientId;
    if (!id) return false;
    if (item.clientId === id) return true;
    return singleOwner(wh) === id && !item.clientId;
  }

  function movementItem(wh, move) {
    if (move.sscc && wh.pallets[move.sscc]) return wh.pallets[move.sscc].itemNo;
    const note = String(move.note || '');
    const first = note.split(/\s+/)[0];
    if (first && wh.items[first]) return first;
    return null;
  }

  function csvCell(value) {
    const text = String(value == null ? '' : value);
    const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
    return `"${safe.replace(/"/g, '""')}"`;
  }

  function header(wh, word) {
    const lang = (wh.config && wh.config.language) || 'en';
    if (lang === 'en') return word;
    try {
      const api = typeof require === 'function' ? require('./i18n') : (typeof globalThis !== 'undefined' ? globalThis.SortedI18n : null);
      if (!api) return word;
      const hit = api.t(lang, word);
      return hit && hit !== word ? hit : word;
    } catch (e) {
      return word;
    }
  }

  function install(Warehouse) {
    const proto = Warehouse.prototype;

    proto._requireClientItems = function () {
      if (typeof this.module === 'function' && !this.module('client-items')) fail('Client items are switched off for this warehouse.', 404);
    };

    proto.noteItemOverride = function (itemNo, reason, by) {
      const why = noteOf(reason, 'A reason');
      const who = by || this._actor || 'unknown';
      this.log(`Item ${itemNo} descriptive fields overridden by ${who}: ${why}`, { by: who, reason: why });
      return { itemNo, reason: why, by: who };
    };

    proto.clientItemHasHistory = function (itemNo) {
      for (const row of Object.values(this.clientRemovals || {})) if (row.itemNo === itemNo) return true;
      for (const shipment of this.shipments || []) {
        if ((shipment.pallets || []).some((p) => p.itemNo === itemNo)) return true;
      }
      for (const move of this.movements || []) if (movementItem(this, move) === itemNo) return true;
      return false;
    };

    proto._clientItem = function (itemNo, actor) {
      const key = String(itemNo || '').trim();
      const item = key ? this.items[key] : null;
      if (!item || (actor && !owns(this, item, actor))) fail(`Unknown item ${key || 'number'}`, 404);
      return item;
    };

    function photosOf(wh, itemNo) {
      if (typeof wh.module === 'function' && !wh.module('photos')) return null;
      return ((wh.itemPhotos || {})[itemNo] || []).map((row) => ({ id: row.id, type: row.type, name: row.name || '', bytes: row.bytes || 0 }));
    }

    function stockOf(wh, itemNo) {
      if (typeof wh.availability !== 'function') return { onHand: 0, available: 0 };
      const row = wh.availability().find((r) => r.itemNo === itemNo);
      return row ? { onHand: row.onHand, available: row.available } : { onHand: 0, available: 0 };
    }

    proto.clientItemView = function (item) {
      const flag = item.staffFlag && !item.staffFlag.resolvedAt ? { note: item.staffFlag.note, by: item.staffFlag.by, at: item.staffFlag.at } : null;
      const stock = stockOf(this, item.itemNo);
      return {
        itemNo: item.itemNo,
        name: item.name,
        description: item.description || '',
        clientId: item.clientId || null,
        category: item.category,
        uom: item.uom || null,
        status: item.status,
        lengthMm: item.lengthMm == null ? null : item.lengthMm,
        widthMm: item.widthMm == null ? null : item.widthMm,
        heightMm: item.heightMm == null ? null : item.heightMm,
        weightKg: item.weightKg == null ? null : item.weightKg,
        gtin: item.gtin || null,
        unitGtin: item.unitGtin || null,
        unitsPerCase: item.unitsPerCase == null ? null : item.unitsPerCase,
        codes: item.codes || [],
        barcodes: item.barcodes || [],
        palletQty: item.palletQty,
        storage: item.storage || null,
        reorderPoint: item.reorderPoint == null ? null : item.reorderPoint,
        value: item.value == null ? null : item.value,
        flags: item.flags || {},
        bestBefore: item.bestBefore !== false,
        flag,
        onHand: stock.onHand,
        available: stock.available,
        photos: photosOf(this, item.itemNo),
      };
    };

    function visible(wh, actor, clientId) {
      const who = actorOf(actor);
      const asked = clientId ? String(clientId).trim().toUpperCase() : null;
      if (isClient(who)) {
        if (!who.clientId) fail('A client login needs a client id', 403);
        if (asked && asked !== who.clientId) fail('That belongs to another client', 403);
      }
      const owner = singleOwner(wh);
      const limit = isClient(who) ? who.clientId : asked;
      return Object.values(wh.items).filter((item) => {
        if (!limit) return true;
        if (item.clientId === limit) return true;
        return owner === limit && !item.clientId;
      }).sort((a, b) => (a.itemNo < b.itemNo ? -1 : 1));
    }

    proto.clientItemList = function ({ q = '', status = '', flagged = null, clientId = null, actor = null } = {}) {
      this._requireClientItems();
      let items = visible(this, actor, clientId);
      const wanted = String(status || '').trim().toLowerCase();
      if (wanted && wanted !== 'all') items = items.filter((item) => item.status === wanted);
      else if (!wanted) items = items.filter((item) => item.status !== 'archived');
      if (flagged === true || flagged === '1' || flagged === 1) items = items.filter((item) => item.staffFlag && !item.staffFlag.resolvedAt);
      const needle = String(q || '').trim().toLowerCase();
      if (needle) {
        items = items.filter((item) => {
          const blob = [item.itemNo, item.name, item.description, item.gtin, item.uom, item.clientId, ...(item.codes || []), ...((item.barcodes || []).map((b) => b.value))].join(' ').toLowerCase();
          return blob.includes(needle);
        });
      }
      const active = activeClients(this);
      const owner = active.length === 1 ? active[0].id : null;
      return {
        single: active.length <= 1,
        ownerClient: owner,
        photos: typeof this.module !== 'function' || this.module('photos'),
        items: items.map((item) => this.clientItemView(item)),
      };
    };

    proto.flagClientItem = function ({ itemNo, note, by, actor } = {}) {
      this._requireClientItems();
      const who = actorOf(actor);
      if (isClient(who)) fail('The warehouse flags an item. The client resolves it.', 403);
      const item = this.items[String(itemNo || '').trim()];
      if (!item) fail(`Unknown item ${itemNo || 'number'}`);
      const text = noteOf(note, 'A note');
      item.staffFlag = { note: text, by: by || this._actor || 'staff', at: this.now() };
      this.log(`Item ${item.itemNo} flagged by ${item.staffFlag.by}: ${text}`, { by: item.staffFlag.by });
      return this.clientItemView(item);
    };

    proto.resolveClientFlag = function ({ itemNo, by, actor } = {}) {
      this._requireClientItems();
      const who = actorOf(actor);
      const item = this._clientItem(itemNo, who);
      if (!item.staffFlag || item.staffFlag.resolvedAt) fail(`${item.itemNo} has no open flag`);
      if (who && !isClient(who)) {
        const owner = singleOwner(this);
        if (!(isManager(who) && ownerWarehouse(this) && (!item.clientId || !owner || item.clientId === owner))) fail('The client resolves the flag.', 403);
      }
      const person = by || this._actor || 'client';
      item.staffFlagHistory = item.staffFlagHistory || [];
      item.staffFlagHistory.push({ ...item.staffFlag, resolvedBy: person, resolvedAt: this.now() });
      item.staffFlag = null;
      this.log(`Item ${item.itemNo} flag resolved by ${person}`, { by: person });
      return this.clientItemView(item);
    };

    function period(wh, from, to) {
      const today = wh.localDay();
      let end = to ? String(to) : today;
      let start = from ? String(from) : wh.localDay(wh.zonedMidnight(today) - 29 * DAY);
      if (!dayOk(start) || !dayOk(end)) fail('The period uses dates as YYYY-MM-DD');
      if (start > end) fail('The period starts after it ends');
      return { from: start, to: end, today };
    }

    proto.clientItemMovers = function ({ from = null, to = null, clientId = null, pace = null, actor = null } = {}) {
      this._requireClientItems();
      const span = period(this, from, to);
      const items = visible(this, actor, clientId);
      const picked = new Set();
      for (const move of this.movements || []) {
        if (move.event === 'picked' && move.sscc) picked.add(move.sscc);
      }
      const units = {};
      const last = {};
      const touch = (itemNo, t) => {
        if (!itemNo || t == null) return;
        if (last[itemNo] == null || t > last[itemNo]) last[itemNo] = t;
      };
      for (const move of this.movements || []) {
        const itemNo = movementItem(this, move);
        if (!itemNo) continue;
        touch(itemNo, move.t);
        if (!inRange(this, move.t, span.from, span.to)) continue;
        if (move.event === 'picked' || move.event === 'removed') units[itemNo] = (units[itemNo] || 0) + (Number(move.qty) || 0);
        else if (move.event === 'shipped' && !(move.sscc && picked.has(move.sscc))) units[itemNo] = (units[itemNo] || 0) + (Number(move.qty) || 0);
      }
      const lines = {};
      for (const order of Object.values(this.orders || {})) {
        if (!inRange(this, order.createdAt, span.from, span.to)) continue;
        for (const line of order.lines || []) if (line && line.itemNo) lines[line.itemNo] = (lines[line.itemNo] || 0) + 1;
      }
      const rows = items.map((item) => {
        const gone = units[item.itemNo] || 0;
        const when = last[item.itemNo] == null ? null : this.localDay(last[item.itemNo]);
        const since = when == null ? null : daysBetween(when, span.today);
        return {
          itemNo: item.itemNo,
          name: item.name,
          clientId: item.clientId || null,
          unitsOut: gone,
          orderLines: lines[item.itemNo] || 0,
          daysSince: since,
          lastMovement: when,
          pace: gone > 0 ? 'fast' : 'slow',
        };
      });
      rows.sort((a, b) => b.unitsOut - a.unitsOut || b.orderLines - a.orderLines || (a.itemNo < b.itemNo ? -1 : 1));
      rows.forEach((row, i) => { row.rank = i + 1; });
      const band = String(pace || '').trim().toLowerCase();
      const shown = band === 'fast' || band === 'slow' ? rows.filter((row) => row.pace === band) : rows;
      return { from: span.from, to: span.to, timeZone: this.timeZone(), asOf: this.localDay(), rows: shown };
    };

    proto.clientItemMoversCsv = function (opts) {
      const report = this.clientItemMovers(opts || {});
      const cols = ['Rank', 'Item', 'Name', 'Client', 'Units out', 'Order lines', 'Days since last movement', 'Last movement', 'Pace'];
      const keys = ['rank', 'itemNo', 'name', 'clientId', 'unitsOut', 'orderLines', 'daysSince', 'lastMovement', 'pace'];
      const lines = [cols.map((col) => csvCell(header(this, col))).join(',')];
      for (const row of report.rows) lines.push(keys.map((key) => csvCell(row[key] == null ? '' : row[key])).join(','));
      return lines.join('\n');
    };

    function freeStock(wh, itemNo) {
      const plan = [];
      let have = 0;
      const bins = Object.keys(wh.binStock || {}).sort();
      for (const code of bins) {
        const place = wh.locations[code];
        if (place && (place.blocked || place.checkHold || place.quarantine)) continue;
        for (const line of wh.binStock[code]) {
          if (line.itemNo !== itemNo || !(line.qty > 0)) continue;
          plan.push({ kind: 'bin', code, line, qty: line.qty });
          have += line.qty;
        }
      }
      const holders = Object.values(wh.holders || {}).sort((a, b) => (a.id < b.id ? -1 : 1));
      for (const holder of holders) {
        if (holder.status === 'retired' || holder.cartonStatus) continue;
        if (holder.sscc && wh.pallets[holder.sscc]) continue;
        const place = holder.loc && wh.locations[holder.loc];
        if (place && (place.blocked || place.checkHold || place.quarantine || place.role === 'quarantine')) continue;
        for (const line of holder.contents || []) {
          if (line.itemNo !== itemNo || !(Number(line.qty) > 0)) continue;
          const qty = Number(line.qty);
          plan.push({ kind: 'holder', holder, line, qty });
          have += qty;
        }
      }
      const pallets = wh._livePallets().filter((p) => p.itemNo === itemNo && p.loc && p.status !== 'shipped').sort((a, b) => (a.sscc < b.sscc ? -1 : 1));
      for (const pallet of pallets) {
        if (pallet.orderId || pallet.status === 'blocked' || pallet.qualityHold || pallet.quarantine) continue;
        if (typeof wh._liveTaskFor === 'function' && wh._liveTaskFor(pallet.sscc)) continue;
        const place = wh.locations[pallet.loc];
        if (place && (place.blocked || place.checkHold || place.quarantine)) continue;
        if (!(pallet.qty > 0)) continue;
        plan.push({ kind: 'pallet', pallet, qty: pallet.qty });
        have += pallet.qty;
      }
      return { plan, have };
    }

    function takeStock(wh, itemNo, qty, by, kind, reason) {
      const { plan, have } = freeStock(wh, itemNo);
      if (have < qty) fail('Not enough free stock to take out.');
      let left = qty;
      const taken = [];
      for (const part of plan) {
        if (!left) break;
        const n = Math.min(left, part.qty);
        if (part.kind === 'bin') {
          const before = part.line.qty;
          part.line.qty -= n;
          wh.binStock[part.code] = wh.binStock[part.code].filter((line) => line.qty > 0);
          if (!wh.binStock[part.code].length) delete wh.binStock[part.code];
          wh.recordMovement({ from: part.code, to: null, qty: n, event: 'removed', by, note: `${itemNo} ${kind}: ${reason}` });
          if (wh._adjust) wh._adjust({ loc: part.code, itemNo, before, after: before - n, reason: kind, by });
          taken.push({ loc: part.code, qty: n });
        } else if (part.kind === 'holder') {
          const before = Number(part.line.qty);
          part.line.qty = before - n;
          part.holder.contents = (part.holder.contents || []).filter((line) => Number(line.qty) > 0);
          wh.recordMovement({ holder: part.holder.id, from: part.holder.loc, to: null, qty: n, event: 'removed', by, note: `${itemNo} ${kind}: ${reason}` });
          if (wh._adjust) wh._adjust({ loc: part.holder.loc, plate: part.holder.id, itemNo, before, after: before - n, reason: kind, by });
          taken.push({ holder: part.holder.id, qty: n });
        } else {
          const pallet = part.pallet;
          const before = pallet.qty;
          pallet.qty -= n;
          wh.recordMovement({ holder: pallet.holderId || null, sscc: pallet.sscc, from: pallet.loc, to: null, qty: n, event: 'removed', by, note: `${itemNo} ${kind}: ${reason}` });
          if (wh._adjust) wh._adjust({ loc: pallet.loc, sscc: pallet.sscc, itemNo, before, after: before - n, reason: kind, by });
          if (pallet.qty === 0) {
            wh._remove(pallet);
            pallet.status = 'shipped';
            pallet.removed = kind;
            pallet.goneAt = wh.now();
          }
          taken.push({ sscc: pallet.sscc, qty: n });
        }
        left -= n;
      }
      return taken;
    }

    function removalView(row) {
      return {
        id: row.id, itemNo: row.itemNo, clientId: row.clientId || null, qty: row.qty, kind: row.kind, reason: row.reason,
        status: row.status, by: row.by, at: row.at, startedBy: row.startedBy || null, startedAt: row.startedAt || null,
        doneBy: row.doneBy || null, doneAt: row.doneAt || null, cancelledBy: row.cancelledBy || null, cancelledAt: row.cancelledAt || null,
      };
    }

    proto.clientRemovalsFor = function ({ clientId = null, actor = null, status = null } = {}) {
      this._requireClientItems();
      const who = actorOf(actor);
      const asked = clientId ? String(clientId).trim().toUpperCase() : null;
      if (isClient(who) && asked && asked !== who.clientId) fail('That belongs to another client', 403);
      const limit = isClient(who) ? who.clientId : asked;
      const wanted = status ? String(status) : null;
      return Object.values(this.clientRemovals || {}).filter((row) => {
        if (limit && row.clientId !== limit) return false;
        if (wanted && row.status !== wanted) return false;
        return true;
      }).sort((a, b) => (a.id < b.id ? -1 : 1)).map(removalView);
    };

    proto._removal = function (id, actor) {
      const key = String(id || '').trim().toUpperCase();
      const row = (this.clientRemovals || {})[key];
      if (!row) fail(`Unknown request ${key || 'number'}`, 404);
      const who = actorOf(actor);
      if (isClient(who) && row.clientId !== who.clientId) fail(`Unknown request ${key}`, 404);
      return row;
    };

    function canAsk(wh, actor, item) {
      const who = actorOf(actor);
      if (isClient(who)) return;
      const owner = singleOwner(wh);
      if (isManager(who) && ownerWarehouse(wh) && (!item.clientId || !owner || item.clientId === owner)) return;
      fail('The client asks for stock to be taken out.', 403);
    }

    proto.requestClientRemoval = function ({ itemNo, qty, kind, reason, by, actor } = {}) {
      this._requireClientItems();
      const who = actorOf(actor);
      const item = this._clientItem(itemNo, who);
      canAsk(this, who, item);
      if (item.serialized) fail(`${item.itemNo} is traced by serial number. Clear the serials before asking for it to be taken out.`);
      const amount = whole(qty, 'Quantity');
      const how = kindOf(kind);
      const why = noteOf(reason, 'A reason');
      this.clientRemovals = this.clientRemovals || {};
      this._seq.removal = (this._seq.removal || 0) + 1;
      const id = `R${String(this._seq.removal).padStart(4, '0')}`;
      const ownerId = item.clientId || (isClient(who) ? who.clientId : singleOwner(this));
      const row = {
        id, itemNo: item.itemNo, clientId: ownerId, qty: amount, kind: how, reason: why,
        status: 'requested', by: by || this._actor || 'client', at: this.now(),
      };
      this.clientRemovals[id] = row;
      this.log(`Removal ${id} requested by ${row.by}: ${amount} ${item.itemNo} ${how} (${why})`, { by: row.by });
      return removalView(row);
    };

    proto.cancelClientRemoval = function ({ id, by, actor } = {}) {
      this._requireClientItems();
      const row = this._removal(id, actor);
      if (row.status !== 'requested') fail('Staff have started this request.');
      const who = actorOf(actor);
      if (who && !isClient(who)) {
        const owner = singleOwner(this);
        if (!(isManager(who) && ownerWarehouse(this) && (!row.clientId || !owner || row.clientId === owner))) fail('The client cancels the request until staff start it.', 403);
      }
      row.status = 'cancelled';
      row.cancelledBy = by || this._actor || 'client';
      row.cancelledAt = this.now();
      this.log(`Removal ${row.id} cancelled by ${row.cancelledBy}`, { by: row.cancelledBy });
      return removalView(row);
    };

    proto.startClientRemoval = function ({ id, by, actor } = {}) {
      this._requireClientItems();
      const who = actorOf(actor);
      if (isClient(who)) fail('Warehouse staff carry out the request.', 403);
      const row = this._removal(id, null);
      if (row.status !== 'requested') fail(row.status === 'started' ? 'This request is already started.' : 'This request is no longer open.');
      row.status = 'started';
      row.startedBy = by || this._actor || 'staff';
      row.startedAt = this.now();
      this.log(`Removal ${row.id} started by ${row.startedBy}`, { by: row.startedBy });
      return removalView(row);
    };

    proto.confirmClientRemoval = function ({ id, by, actor } = {}) {
      this._requireClientItems();
      const who = actorOf(actor);
      if (isClient(who)) fail('The client does not adjust stock. Warehouse staff confirm the request.', 403);
      const row = this._removal(id, null);
      if (row.status !== 'started') fail(row.status === 'requested' ? 'Start the request before confirming it.' : 'This request is no longer open.');
      const person = by || this._actor || 'staff';
      const taken = takeStock(this, row.itemNo, row.qty, person, row.kind, row.reason);
      row.status = 'done';
      row.doneBy = person;
      row.doneAt = this.now();
      row.taken = taken;
      this.log(`Removal ${row.id} confirmed by ${person}: ${row.qty} ${row.itemNo} ${row.kind}`, { by: person });
      return removalView(row);
    };

    proto.clientRemovalLines = function () {
      return Object.values(this.clientRemovals || {})
        .filter((row) => row.status === 'requested' || row.status === 'started')
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .map((row) => `${row.id} ${row.itemNo} ${row.qty} ${row.kind} ${row.status} ${row.reason}`);
    };
  }

  return { install, KINDS };
});
