/*
 * The reports area. Every table takes the same filters and can be saved as
 * CSV. Dates are the warehouse's local dates. A report that belongs to
 * another module is left out while that module is off. A client login only
 * ever sees that client's rows.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SortedReports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DAY = 86400000;

  function on(wh, id) {
    return typeof wh.module !== 'function' || wh.module(id);
  }

  function daysBetween(fromDay, toDay) {
    const a = Date.parse(`${fromDay}T00:00:00Z`);
    const b = Date.parse(`${toDay}T00:00:00Z`);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    return Math.round((b - a) / DAY);
  }

  function inRange(wh, t, from, to) {
    if (t == null) return !from && !to;
    const day = wh.localDay(t);
    if (from && day < from) return false;
    if (to && day > to) return false;
    return true;
  }

  function itemOfMove(wh, move) {
    if (move.sscc && wh.pallets[move.sscc]) return wh.pallets[move.sscc].itemNo;
    const note = String(move.note || '').split(/\s+/)[0];
    if (note && wh.items[note]) return note;
    const holder = move.holder && wh.holders && wh.holders[move.holder];
    const line = holder && (holder.contents || []).find((c) => c.itemNo);
    return line ? line.itemNo : null;
  }

  function clientOfItem(wh, itemNo, fallback) {
    const item = wh.items[itemNo];
    return (item && item.clientId) || fallback || '';
  }

  function install(Warehouse) {
    const proto = Warehouse.prototype;

    function requireOn(wh) {
      if (!on(wh, 'reports')) throw new Error('Reports are switched off');
    }

    proto.reportCatalog = function () {
      requireOn(this);
      const list = [
        { id: 'stock', title: 'Stock on hand', module: 'reports' },
        { id: 'ageing', title: 'Ageing', module: 'reports' },
        { id: 'movements', title: 'Movements', module: 'reports' },
        { id: 'volumes', title: 'Inbound and outbound', module: 'reports' },
        { id: 'cycle', title: 'Order cycle time', module: 'reports' },
        { id: 'picks', title: 'Pick accuracy', module: 'reports' },
        { id: 'counts', title: 'Count accuracy', module: 'abc' },
        { id: 'utilisation', title: 'Location utilisation', module: 'reports' },
        { id: 'expiry', title: 'Best-before outlook', module: 'lots' },
      ];
      return list.filter((row) => on(this, row.module));
    };

    proto._reportFilters = function (query, ownClient) {
      const q = query || {};
      return {
        client: ownClient || q.client || q.clientId || '',
        item: q.item || q.itemNo || '',
        loc: q.loc || q.location || '',
        user: q.user || q.by || '',
        from: q.from || '',
        to: q.to || '',
        within: q.within || q.days || '',
      };
    };

    function keep(wh, filters, row) {
      if (filters.client && row.client && row.client !== filters.client) return false;
      if (filters.item && row.itemNo && row.itemNo !== filters.item) return false;
      if (filters.loc && row.location && row.location !== filters.loc) return false;
      if (filters.user && row.user && row.user !== filters.user) return false;
      return true;
    }

    proto._stockRows = function () {
      const rows = [];
      const push = (location, itemNo, qty, holder, since, clientId) => {
        if (!qty) return;
        const item = this.items[itemNo] || {};
        rows.push({
          client: clientId || item.clientId || '',
          itemNo,
          name: item.name || '',
          location,
          qty,
          holder: holder || '',
          since: since || null,
          day: since ? this.localDay(since) : '',
        });
      };
      for (const pallet of Object.values(this.pallets)) {
        if (!pallet.loc || pallet.status === 'shipped' || !pallet.qty) continue;
        push(pallet.loc, pallet.itemNo, pallet.qty, pallet.holderId || pallet.sscc, pallet.receivedAt, pallet.clientId);
      }
      for (const [code, lines] of Object.entries(this.binStock || {})) {
        for (const line of lines) push(code, line.itemNo, line.qty, '', line.since, line.clientId);
      }
      return rows.sort((a, b) => (a.client < b.client ? -1 : a.client > b.client ? 1 : 0) || (a.itemNo < b.itemNo ? -1 : 1) || (a.location < b.location ? -1 : 1));
    };

    const builders = {
      stock(wh, filters) {
        const rows = wh._stockRows().filter((row) => keep(wh, filters, row)).map((row) => ({
          client: row.client, item: row.itemNo, name: row.name, location: row.location, qty: row.qty, holder: row.holder, received: row.day,
        }));
        return { columns: ['client', 'item', 'name', 'location', 'qty', 'holder', 'received'], rows };
      },
      ageing(wh, filters) {
        const today = wh.localDay();
        const rows = wh._stockRows().filter((row) => keep(wh, filters, row)).map((row) => {
          const age = row.day ? daysBetween(row.day, today) : null;
          const bucket = age == null ? '' : age <= 30 ? '0-30' : age <= 60 ? '31-60' : age <= 90 ? '61-90' : '90+';
          return { client: row.client, item: row.itemNo, location: row.location, qty: row.qty, received: row.day, ageDays: age == null ? '' : age, bucket };
        });
        return { columns: ['client', 'item', 'location', 'qty', 'received', 'ageDays', 'bucket'], rows };
      },
      movements(wh, filters) {
        const rows = [];
        for (const move of wh.movements || []) {
          if (!inRange(wh, move.t, filters.from, filters.to)) continue;
          const itemNo = itemOfMove(wh, move) || '';
          const client = itemNo ? clientOfItem(wh, itemNo, '') : '';
          const row = {
            day: wh.localDay(move.t),
            time: wh.formatLocal(move.t),
            user: move.by || '',
            holder: move.holder || '',
            sscc: move.sscc || '',
            item: itemNo,
            client,
            from: move.from || '',
            to: move.to || '',
            qty: move.qty == null ? '' : move.qty,
            event: move.event || '',
            note: move.note || '',
          };
          if (filters.user && row.user !== filters.user) continue;
          if (filters.client && row.client !== filters.client) continue;
          if (filters.item && row.item !== filters.item) continue;
          if (filters.loc && row.from !== filters.loc && row.to !== filters.loc) continue;
          rows.push(row);
        }
        return { columns: ['day', 'time', 'user', 'holder', 'sscc', 'item', 'client', 'from', 'to', 'qty', 'event', 'note'], rows };
      },
      volumes(wh, filters) {
        const days = {};
        const bump = (day, key, qty) => {
          days[day] = days[day] || { day, inboundQty: 0, inboundMoves: 0, outboundQty: 0, outboundMoves: 0 };
          days[day][key] += qty;
        };
        for (const move of wh.movements || []) {
          if (!inRange(wh, move.t, filters.from, filters.to)) continue;
          const itemNo = itemOfMove(wh, move);
          if (filters.client && clientOfItem(wh, itemNo, '') !== filters.client) continue;
          const qty = Math.abs(Number(move.qty) || 0);
          const day = wh.localDay(move.t);
          if (move.event === 'received') bump(day, 'inboundQty', qty), bump(day, 'inboundMoves', 1);
          if (move.event === 'shipped' || move.event === 'picked') bump(day, 'outboundQty', qty), bump(day, 'outboundMoves', 1);
        }
        const rows = Object.values(days).sort((a, b) => (a.day < b.day ? -1 : 1));
        return { columns: ['day', 'inboundQty', 'inboundMoves', 'outboundQty', 'outboundMoves'], rows };
      },
      cycle(wh, filters) {
        const rows = [];
        for (const order of Object.values(wh.orders)) {
          if (!order.shippedAt || !order.createdAt) continue;
          if (filters.client && order.clientId !== filters.client) continue;
          if (!inRange(wh, order.shippedAt, filters.from, filters.to)) continue;
          const minutes = Math.round((order.shippedAt - order.createdAt) / 60000);
          rows.push({
            order: order.id, client: order.clientId || '', customer: order.customer || '',
            opened: wh.localDay(order.createdAt), shipped: wh.localDay(order.shippedAt), minutes,
          });
        }
        rows.sort((a, b) => (a.shipped < b.shipped ? -1 : 1));
        return { columns: ['order', 'client', 'customer', 'opened', 'shipped', 'minutes'], rows };
      },
      picks(wh, filters) {
        let picks = 0;
        let misses = 0;
        for (const move of wh.movements || []) {
          if (move.event !== 'picked' || !inRange(wh, move.t, filters.from, filters.to)) continue;
          const itemNo = itemOfMove(wh, move);
          if (filters.client && clientOfItem(wh, itemNo, '') !== filters.client) continue;
          picks += 1;
        }
        for (const adj of wh.adjustments || []) {
          if (!inRange(wh, adj.t, filters.from, filters.to)) continue;
          if (!['correction', 'recount', 'damage', 'missing'].includes(adj.reason)) continue;
          if (filters.user && adj.by !== filters.user) continue;
          misses += 1;
        }
        const accuracy = picks + misses ? Math.round((100 * picks) / (picks + misses)) : '';
        return { columns: ['picks', 'misses', 'accuracy'], rows: [{ picks, misses, accuracy }] };
      },
      counts(wh, filters) {
        if (!on(wh, 'abc')) return { hidden: true, reason: 'ABC cycle counts are switched off', columns: [], rows: [] };
        let ok = 0;
        let off = 0;
        const rows = [];
        for (const count of wh.counts || []) {
          if (!inRange(wh, count.t, filters.from, filters.to)) continue;
          const good = count.result === 'ok';
          if (good) ok += 1; else off += 1;
          rows.push({ day: wh.localDay(count.t), location: count.code, kind: 'location', result: count.result, by: count.by || '' });
        }
        for (const book of Object.values(wh.abcDays || {})) {
          for (const line of book.lines || []) {
            if (!line.closedAt || !inRange(wh, line.closedAt, filters.from, filters.to)) continue;
            if (filters.client && clientOfItem(wh, line.itemNo, '') !== filters.client) continue;
            const good = line.status === 'matched';
            if (good) ok += 1; else off += 1;
            const variance = line.expected == null || !line.counts.length ? '' : line.counts[line.counts.length - 1].qty - line.expected;
            rows.push({ day: wh.localDay(line.closedAt), location: line.loc, kind: line.class, result: line.status, variance, by: line.approvedBy || (line.counts[0] && line.counts[0].by) || '' });
          }
        }
        const accuracy = ok + off ? Math.round((100 * ok) / (ok + off)) : '';
        rows.unshift({ day: '', location: '', kind: 'summary', result: `${ok} matched, ${off} variance`, variance: '', by: accuracy === '' ? '' : `${accuracy}%` });
        return { columns: ['day', 'location', 'kind', 'result', 'variance', 'by'], rows };
      },
      utilisation(wh, filters) {
        const rows = [];
        for (const loc of Object.values(wh.locations)) {
          if (!['rack', 'bin', 'mezzanine', 'block'].includes(loc.kind) || loc.structural) continue;
          if (filters.loc && loc.code !== filters.loc) continue;
          let used = 0;
          let capacity = 1;
          if (loc.kind === 'rack' || loc.kind === 'block') used = loc.sscc || (loc.pallets || []).length ? 1 : 0;
          else {
            const lines = (wh.binStock && wh.binStock[loc.code]) || [];
            const qty = lines.reduce((s, l) => s + l.qty, 0);
            const cap = loc.capacity && loc.capacity.maxWeightKg;
            if (cap && typeof wh._binWeight === 'function') {
              used = Math.round(wh._binWeight(loc.code) * 1000) / 1000;
              capacity = cap;
            } else {
              used = qty;
              capacity = qty > 0 ? qty : 1;
            }
          }
          const percent = capacity ? Math.round((100 * used) / capacity) : 0;
          rows.push({ location: loc.code, kind: loc.kind, used, capacity, percent });
        }
        rows.sort((a, b) => b.percent - a.percent || (a.location < b.location ? -1 : 1));
        return { columns: ['location', 'kind', 'used', 'capacity', 'percent'], rows };
      },
      expiry(wh, filters) {
        if (!on(wh, 'lots')) return { hidden: true, reason: 'Lots and best-before is switched off', columns: [], rows: [] };
        const within = filters.within === '' ? null : Number(filters.within);
        const rows = [];
        const add = (location, itemNo, qty, expiry, clientId) => {
          if (!expiry) return;
          const item = wh.items[itemNo] || {};
          const client = clientId || item.clientId || '';
          if (filters.client && client !== filters.client) return;
          if (filters.item && itemNo !== filters.item) return;
          if (filters.loc && location !== filters.loc) return;
          const left = daysBetween(wh.localDay(), expiry);
          if (within != null && Number.isFinite(within) && left != null && left > within) return;
          rows.push({ client, item: itemNo, location, qty, bestBefore: expiry, daysLeft: left == null ? '' : left });
        };
        for (const pallet of Object.values(wh.pallets)) {
          if (!pallet.loc || pallet.status === 'shipped') continue;
          add(pallet.loc, pallet.itemNo, pallet.qty, pallet.expiry, pallet.clientId);
        }
        for (const [code, lines] of Object.entries(wh.binStock || {})) {
          for (const line of lines) add(code, line.itemNo, line.qty, line.expiry, line.clientId);
        }
        rows.sort((a, b) => String(a.bestBefore).localeCompare(String(b.bestBefore)));
        return { columns: ['client', 'item', 'location', 'qty', 'bestBefore', 'daysLeft'], rows };
      },
    };

    proto.reportById = function (id, query, ownClient) {
      requireOn(this);
      const filters = this._reportFilters(query, ownClient || null);
      if (!builders[id]) throw new Error(`No report ${id}`);
      if (!this.reportCatalog().some((row) => row.id === id)) {
        const built = builders[id](this, filters);
        return { id, title: id, hidden: true, reason: built.reason || 'That report is switched off', columns: [], rows: [], filters, timeZone: this.timeZone(), asOf: this.formatLocal(this.now()) };
      }
      const built = builders[id](this, filters);
      if (built.hidden) return { id, title: id, ...built, filters, timeZone: this.timeZone(), asOf: this.formatLocal(this.now()) };
      const title = (this.reportCatalog().find((row) => row.id === id) || {}).title || id;
      return { id, title, columns: built.columns, rows: built.rows, filters, timeZone: this.timeZone(), asOf: this.formatLocal(this.now()) };
    };

    proto.reportArea = function (query, ownClient) {
      requireOn(this);
      const filters = this._reportFilters(query, ownClient || null);
      const reports = this.reportCatalog().map((row) => this.reportById(row.id, query, ownClient));
      return { timeZone: this.timeZone(), asOf: this.formatLocal(this.now()), filters, catalog: this.reportCatalog(), reports };
    };

    proto.reportCsv = function (id, query, ownClient) {
      const report = this.reportById(id, query, ownClient);
      if (report.hidden) {
        const err = new Error(report.reason);
        err.status = 404;
        throw err;
      }
      const lines = [report.columns.map(csvCell).join(',')];
      for (const row of report.rows) lines.push(report.columns.map((col) => csvCell(row[col])).join(','));
      return lines.join('\n');
    };

    function csvCell(value) {
      return `"${String(value == null ? '' : value).replace(/"/g, '""')}"`;
    }
  }

  return { install };
});
