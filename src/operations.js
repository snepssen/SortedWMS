/*
 * Order-driven floor work that sits on the reach-truck engine: piece picks,
 * kit work orders, cartons, pick-face replenishment, returns, availability
 * and 3PL charges. Installed onto Warehouse.prototype from foundation.js.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SortedOperations = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function positive(value, label) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`${label} must be a number above 0`);
    return n;
  }

  function whole(value, label) {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1) throw new Error(`${label} must be a whole number above 0`);
    return n;
  }

  /*
   * 3PL rate cards. A client keeps every version. A version starts on an
   * effective date, or from the beginning when it is the only card, and it
   * is read-only once a later card exists or its start date is in the past.
   * Dates are UTC days. Storage that crosses a season or a version is split
   * at midnight, and the parts add up to the unsplit quantity. Tiers apply
   * to the quantity on that one version inside the invoice: "all" prices
   * every unit at the band the total falls in (the top of a band is included);
   * "graduated" fills the bands from the start of the period. A season
   * replaces the rate or adds a percent, and two seasons cannot cover the
   * same charge on the same day. The monthly minimum is the full amount on
   * the card in effect on the last day of the period.
   */
  const DAY = 86400000;
  const CHARGE_IDS = ['storage', 'inbound', 'outbound', 'val'];

  function tariffNumber(value, label) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) throw new Error(`${label} must be a number of 0 or more`);
    return n;
  }

  function rateOrZero(value, label) {
    if (value == null || value === '') return 0;
    return tariffNumber(value, label);
  }

  function parseDay(value, label) {
    const s = String(value == null ? '' : value).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error(`${label} is a date YYYY-MM-DD`);
    const t = Date.parse(`${s}T00:00:00Z`);
    if (Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== s) throw new Error(`${label} is not a real date`);
    return s;
  }

  const zoneFormats = new Map();

  function zoneFormat(timeZone) {
    let fmt = zoneFormats.get(timeZone);
    if (!fmt) {
      try {
        fmt = new Intl.DateTimeFormat('en-US', {
          timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
          hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
        });
      } catch (e) {
        throw new Error(`Unknown time zone ${timeZone}`);
      }
      zoneFormats.set(timeZone, fmt);
    }
    return fmt;
  }

  function localParts(ms, timeZone) {
    const bag = {};
    for (const part of zoneFormat(timeZone).formatToParts(new Date(ms))) bag[part.type] = part.value;
    if (bag.hour === '24') bag.hour = '00';
    return bag;
  }

  function localDay(ms, timeZone) {
    const p = localParts(ms, timeZone);
    return `${p.year}-${p.month}-${p.day}`;
  }

  function addCalendarDays(day, n) {
    const t = Date.parse(`${day}T00:00:00Z`) + n * DAY;
    return new Date(t).toISOString().slice(0, 10);
  }

  function daysInMonth(day) {
    const y = Number(day.slice(0, 4));
    const m = Number(day.slice(5, 7));
    return new Date(Date.UTC(y, m, 0)).getUTCDate();
  }

  /** UTC instant of local midnight. A short or long civil day (DST) is the gap to the next midnight. */
  function zonedMidnight(day, timeZone) {
    let ms = Date.parse(`${day}T00:00:00Z`);
    for (let i = 0; i < 6; i++) {
      const p = localParts(ms, timeZone);
      const seen = Date.parse(`${p.year}-${p.month}-${p.day}T${String(p.hour).padStart(2, '0')}:${p.minute}:${p.second}Z`);
      const want = Date.parse(`${day}T00:00:00Z`);
      if (seen === want) return ms;
      ms += want - seen;
    }
    return ms;
  }

  function bound(value, end, timeZone) {
    if (value == null || value === '') return null;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new Error('Use dates as YYYY-MM-DD');
      return end ? value + 1 : value;
    }
    const day = parseDay(value, end ? 'Period end' : 'Period start');
    return zonedMidnight(end ? addCalendarDays(day, 1) : day, timeZone);
  }

  function calendarDays(start, end, timeZone) {
    const first = localDay(start, timeZone);
    const last = localDay(end - 1, timeZone);
    const a = Date.parse(`${first}T00:00:00Z`);
    const b = Date.parse(`${last}T00:00:00Z`);
    return Math.round((b - a) / DAY) + 1;
  }

  function inWindow(t, start, end) {
    if (t == null || Number.isNaN(t)) return false;
    if (start != null && t < start) return false;
    if (end != null && t >= end) return false;
    return true;
  }

  function normalizeTiers(list, mode, label) {
    const name = label.toLowerCase();
    if (mode == null || mode === '' || mode === 'flat') {
      if (Array.isArray(list) && list.length) throw new Error(`${label} tiers need a mode of all or graduated`);
      return { mode: null, tiers: [] };
    }
    if (mode !== 'all' && mode !== 'graduated') throw new Error(`${label} tier mode is all or graduated`);
    if (!Array.isArray(list) || !list.length) throw new Error(`${label} tiers need at least one band`);
    const tiers = [];
    let prev = 0;
    for (let i = 0; i < list.length; i++) {
      const raw = list[i] || {};
      const last = i === list.length - 1;
      let upTo = raw.upTo;
      if (upTo == null || upTo === '') upTo = null;
      else {
        upTo = Number(upTo);
        if (!Number.isFinite(upTo) || upTo <= prev) throw new Error(`${label} tier limits have to increase`);
      }
      if (!last && upTo == null) throw new Error(`Only the last ${name} tier has no upper limit`);
      if (last && upTo != null) throw new Error(`The last ${name} tier has no upper limit`);
      tiers.push({ upTo, rate: tariffNumber(raw.rate, `${label} tier rate`) });
      if (upTo != null) prev = upTo;
    }
    return { mode, tiers };
  }

  function normalizeEffect(spec, label) {
    let effect = spec && (spec.effect || spec.seasonEffect);
    if (effect === 'replace') effect = 'override';
    if (effect === 'multiply') effect = 'surcharge';
    if (effect !== 'override' && effect !== 'surcharge' && effect !== 'each') throw new Error(`Season "${label}" overrides the rate or adds a surcharge`);
    if (effect === 'override') return { effect, rate: tariffNumber(spec.rate, `Season "${label}" rate`), percent: null, amount: null };
    if (effect === 'each' || spec.amountMode === 'each' || (spec.amount != null && spec.amount !== '' && (spec.percent == null || spec.percent === ''))) {
      return { effect: 'surcharge', rate: null, percent: null, amount: tariffNumber(spec.amount != null && spec.amount !== '' ? spec.amount : spec.rate, `Season "${label}" amount`) };
    }
    return { effect: 'surcharge', rate: null, percent: tariffNumber(spec.percent, `Season "${label}" percent`), amount: null };
  }

  function monthsTouched(from, to) {
    let y = Number(from.slice(0, 4));
    let m = Number(from.slice(5, 7));
    const endY = Number(to.slice(0, 4));
    const endM = Number(to.slice(5, 7));
    const span = (endY - y) * 12 + (endM - m);
    if (span >= 11) return new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    const out = new Set();
    for (let i = 0; i <= span; i++) {
      out.add(m);
      m += 1;
      if (m > 12) { m = 1; y += 1; }
    }
    return out;
  }

  function seasonDaysOverlap(a, b) {
    if (a.months && b.months) return a.months.some((m) => b.months.includes(m));
    if (!a.months && !b.months) return a.from <= b.to && b.from <= a.to;
    const dated = a.months ? b : a;
    const months = a.months || b.months;
    const touched = monthsTouched(dated.from, dated.to);
    return months.some((m) => touched.has(m));
  }

  function normalizeSeasons(list) {
    if (list == null || list === '') return [];
    if (!Array.isArray(list)) throw new Error('Seasons are a list');
    const out = [];
    const ids = new Set();
    for (const raw of list) {
      if (!raw || typeof raw !== 'object') throw new Error('A season needs a label and dates or months');
      const label = String(raw.label || '').trim();
      if (!label) throw new Error('A season needs a label');
      const hasMonths = raw.months != null && raw.months !== '' && !(Array.isArray(raw.months) && !raw.months.length);
      const hasRange = (raw.from != null && raw.from !== '') || (raw.to != null && raw.to !== '');
      if (hasMonths && hasRange) throw new Error(`Season "${label}" is either a date range or months of the year`);
      if (!hasMonths && !hasRange) throw new Error(`Season "${label}" needs a date range or months of the year`);
      let from = null;
      let to = null;
      let months = null;
      if (hasMonths) {
        const src = Array.isArray(raw.months) ? raw.months : String(raw.months).split(/[^0-9]+/);
        months = [...new Set(src.map((n) => Number(n)).filter((n) => n))];
        if (!months.length || months.some((n) => !Number.isInteger(n) || n < 1 || n > 12)) throw new Error(`Season "${label}" months are 1 to 12`);
        months.sort((a, b) => a - b);
      } else {
        from = parseDay(raw.from, `Season "${label}" start`);
        to = parseDay(raw.to, `Season "${label}" end`);
        if (from > to) throw new Error(`Season "${label}" ends before it starts`);
      }
      const charges = {};
      if (raw.charges && typeof raw.charges === 'object' && !Array.isArray(raw.charges)) {
        for (const [key, spec] of Object.entries(raw.charges)) {
          if (!CHARGE_IDS.includes(key)) throw new Error(`Unknown charge ${key}`);
          charges[key] = normalizeEffect(spec, label);
        }
      } else {
        const charge = raw.charge || 'storage';
        if (charge !== 'all' && !CHARGE_IDS.includes(charge)) throw new Error(`Unknown charge ${charge}`);
        const effect = normalizeEffect(raw, label);
        for (const key of (charge === 'all' ? CHARGE_IDS : [charge])) charges[key] = effect;
      }
      if (!Object.keys(charges).length) throw new Error(`Season "${label}" does not name a charge`);
      let id = String(raw.id || '').trim().toLowerCase();
      if (!id) id = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24);
      if (!/^[a-z0-9][a-z0-9-]{0,24}$/.test(id)) throw new Error(`Season "${label}" needs an id of letters, digits and hyphens`);
      if (ids.has(id)) throw new Error(`Season id ${id} is used twice`);
      ids.add(id);
      out.push({ id, label, from, to, months, charges });
    }
    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        if (!seasonDaysOverlap(out[i], out[j])) continue;
        const shared = Object.keys(out[i].charges).filter((c) => out[j].charges[c]);
        if (shared.length) throw new Error(`Seasons "${out[i].label}" and "${out[j].label}" both cover ${shared[0]} on the same days`);
      }
    }
    return out;
  }

  function chargeInput(input, name) {
    const nested = input.charges && input.charges[name];
    if (nested && typeof nested === 'object') {
      return {
        basis: nested.basis,
        rate: nested.rate,
        tierMode: nested.tierMode,
        tiers: nested.tiers,
      };
    }
    return {
      basis: input[`${name}Basis`],
      rate: name === 'val' ? input.valRate : input[`${name}Rate`],
      tierMode: input[`${name}TierMode`],
      tiers: input[`${name}Tiers`],
    };
  }

  function tariffFields(input) {
    const storage = chargeInput(input, 'storage');
    const inbound = chargeInput(input, 'inbound');
    const outbound = chargeInput(input, 'outbound');
    const val = chargeInput(input, 'val');
    const storageBasis = storage.basis || 'pallet-day';
    const inboundBasis = inbound.basis || 'pallet';
    const outboundBasis = outbound.basis || 'order';
    if (!['pallet-day', 'location-day', 'm3-day'].includes(storageBasis)) throw new Error('Storage is charged per pallet-day, location-day or m3-day');
    if (!['pallet', 'line'].includes(inboundBasis)) throw new Error('Inbound is charged per pallet or line');
    if (!['order', 'line', 'carton'].includes(outboundBasis)) throw new Error('Outbound is charged per order, line or carton');
    const storageTiers = normalizeTiers(storage.tiers, storage.tierMode, 'Storage');
    const inboundTiers = normalizeTiers(inbound.tiers, inbound.tierMode, 'Inbound');
    const outboundTiers = normalizeTiers(outbound.tiers, outbound.tierMode, 'Outbound');
    const valTiers = normalizeTiers(val.tiers, val.tierMode, 'VAL');
    return {
      storageBasis,
      storageRate: rateOrZero(storage.rate, 'Storage rate'),
      storageTierMode: storageTiers.mode,
      storageTiers: storageTiers.tiers,
      inboundBasis,
      inboundRate: rateOrZero(inbound.rate, 'Inbound rate'),
      inboundTierMode: inboundTiers.mode,
      inboundTiers: inboundTiers.tiers,
      outboundBasis,
      outboundRate: rateOrZero(outbound.rate, 'Outbound rate'),
      outboundTierMode: outboundTiers.mode,
      outboundTiers: outboundTiers.tiers,
      valRate: rateOrZero(val.rate, 'VAL rate'),
      valTierMode: valTiers.mode,
      valTiers: valTiers.tiers,
      minimum: rateOrZero(input.minimum, 'Minimum charge'),
      minimumMode: input.minimumMode === 'prorate' ? 'prorate' : 'full',
      tierScope: input.tierScope === 'version' ? 'version' : 'month',
      seasons: normalizeSeasons(input.seasons),
    };
  }

  function sortVersions(list) {
    return list.slice().sort((a, b) => {
      if (a.effectiveFrom == null && b.effectiveFrom == null) return 0;
      if (a.effectiveFrom == null) return -1;
      if (b.effectiveFrom == null) return 1;
      return a.effectiveFrom < b.effectiveFrom ? -1 : a.effectiveFrom > b.effectiveFrom ? 1 : 0;
    });
  }

  function assertOrder(list) {
    const ordered = sortVersions(list);
    if (ordered.filter((v) => v.effectiveFrom == null).length > 1) throw new Error('Only one rate card can start from the beginning');
    let prev = null;
    for (const v of ordered) {
      if (v.effectiveFrom != null && prev && prev.effectiveFrom != null && v.effectiveFrom <= prev.effectiveFrom) {
        throw new Error(`A new rate card has to start after ${prev.id} (${prev.effectiveFrom})`);
      }
      prev = v;
    }
    return ordered;
  }

  function isReadOnly(list, version, today) {
    const latest = list[list.length - 1];
    if (!latest || version.id !== latest.id) return true;
    if (version.effectiveFrom == null) return list.length !== 1;
    return version.effectiveFrom < today;
  }

  function nextVersionId(list) {
    const n = list.reduce((m, v) => Math.max(m, Number(String(v.id).replace(/^v/, '')) || 0), 0) + 1;
    return `v${n}`;
  }

  function versionAt(versions, t, timeZone) {
    let chosen = null;
    for (const v of versions) {
      if (v.effectiveFrom == null) { chosen = v; continue; }
      const start = zonedMidnight(v.effectiveFrom, timeZone);
      if (t >= start) chosen = v;
      else break;
    }
    return chosen;
  }

  function blankCard(client) {
    return {
      id: 'v1', effectiveFrom: null, createdBy: null, updatedBy: null,
      storageBasis: 'pallet-day', storageRate: Number(client && client.storageRate) || 0, storageTierMode: null, storageTiers: [],
      inboundBasis: 'pallet', inboundRate: 0, inboundTierMode: null, inboundTiers: [],
      outboundBasis: 'order', outboundRate: Number(client && client.handlingRate) || 0, outboundTierMode: null, outboundTiers: [],
      valRate: 0, valTierMode: null, valTiers: [],
      minimum: 0, minimumMode: 'full', tierScope: 'month', seasons: [],
    };
  }

  function savedVersions(client) {
    if (Array.isArray(client.tariffVersions) && client.tariffVersions.length) return client.tariffVersions;
    if (client.tariff && typeof client.tariff === 'object') {
      const card = blankCard(client);
      return [{ ...card, ...client.tariff, id: client.tariff.versionId || client.tariff.id || 'v1', seasons: client.tariff.seasons || card.seasons, storageTiers: client.tariff.storageTiers || [], inboundTiers: client.tariff.inboundTiers || [], outboundTiers: client.tariff.outboundTiers || [], valTiers: client.tariff.valTiers || [] }];
    }
    return [];
  }

  function versionList(client) {
    const saved = savedVersions(client);
    return saved.length ? saved : [blankCard(client)];
  }

  function chargeSpec(version, code) {
    if (code === 'storage') return { basis: version.storageBasis, rate: version.storageRate, mode: version.storageTierMode, tiers: version.storageTiers || [], label: `Storage (${version.storageBasis})` };
    if (code === 'inbound') return { basis: version.inboundBasis, rate: version.inboundRate, mode: version.inboundTierMode, tiers: version.inboundTiers || [], label: `Inbound (${version.inboundBasis})` };
    if (code === 'outbound') return { basis: version.outboundBasis, rate: version.outboundRate, mode: version.outboundTierMode, tiers: version.outboundTiers || [], label: `Outbound (${version.outboundBasis})` };
    return { basis: 'unit', rate: version.valRate, mode: version.valTierMode, tiers: version.valTiers || [], label: 'VAL / kitting (unit)' };
  }

  function withFrom(tiers) {
    let from = 0;
    return (tiers || []).map((tier) => {
      const band = { from, upTo: tier.upTo == null ? null : tier.upTo, rate: tier.rate };
      from = band.upTo == null ? Infinity : band.upTo;
      return band;
    });
  }

  function bandFor(bands, qty) {
    for (const band of bands) if (band.upTo == null || qty <= band.upTo) return band;
    return bands[bands.length - 1];
  }

  function tierText(mode, band) {
    if (!mode || !band) return '';
    const where = band.upTo == null
      ? (band.from ? `above ${band.from}` : 'all quantities')
      : (band.from ? `${band.from} to ${band.upTo}` : `up to ${band.upTo}`);
    return `${mode === 'all' ? 'all units' : 'band'} ${where} at ${band.rate}`;
  }

  function graduate(bands, used, qty) {
    const out = [];
    let left = qty;
    let cursor = used;
    for (const band of bands) {
      const end = band.upTo == null ? Infinity : band.upTo;
      if (cursor >= end) continue;
      const take = Math.min(left, end - cursor);
      if (take > 0) {
        out.push({ qty: take, rate: band.rate, band });
        cursor += take;
        left -= take;
      }
      if (left <= 1e-12) break;
    }
    if (left > 1e-9 && bands.length) out.push({ qty: left, rate: bands[bands.length - 1].rate, band: bands[bands.length - 1] });
    return out;
  }

  function seasonAt(version, charge, t, timeZone) {
    const day = localDay(t, timeZone);
    const month = Number(day.slice(5, 7));
    let found = null;
    for (const season of version.seasons || []) {
      const spec = season.charges && season.charges[charge];
      if (!spec) continue;
      const on = season.months ? season.months.includes(month) : day >= season.from && day <= season.to;
      if (on) found = { id: season.id, label: season.label, spec };
    }
    return found;
  }

  function seasonText(season) {
    if (!season) return '';
    if (season.spec.effect === 'override') return `${season.label} override ${season.spec.rate}`;
    if (season.spec.amount != null) return `${season.label} +${season.spec.amount} each`;
    return `${season.label} +${season.spec.percent}%`;
  }

  function seasonRate(base, season) {
    if (!season) return base;
    if (season.spec.effect === 'override') return season.spec.rate;
    if (season.spec.amount != null) return base + season.spec.amount;
    return base * (1 + (season.spec.percent || 0) / 100);
  }

  function versionLabel(version) {
    if (!version) return '';
    return version.effectiveFrom ? `${version.id} ${version.effectiveFrom}` : version.id;
  }

  function money(n) {
    return Math.round(n * 100) / 100;
  }

  function priceSequence(rows, code, timeZone) {
    const groups = [];
    let used = 0;
    for (const row of rows) {
      const version = row.version;
      const spec = chargeSpec(version, code);
      const bands = withFrom(spec.tiers);
      const season = seasonAt(version, code, row.t, timeZone);
      const pool = row.poolQty;
      const portions = spec.mode === 'graduated'
        ? graduate(bands, used, row.qty)
        : [{ qty: row.qty, rate: spec.mode === 'all' ? bandFor(bands, pool).rate : spec.rate, band: spec.mode === 'all' ? bandFor(bands, pool) : null }];
      if (spec.mode === 'graduated') used += row.qty;
      for (const portion of portions) {
        const rate = seasonRate(portion.rate, season);
        const shown = Math.round(rate * 10000) / 10000;
        const key = [version.id, season ? season.id : '', portion.band ? `${portion.band.from}:${portion.band.upTo}` : '', shown].join('|');
        const last = groups[groups.length - 1];
        if (last && last.key === key) last.qty += portion.qty;
        else groups.push({
          key, qty: portion.qty, rate: shown, code, label: spec.label,
          tier: tierText(spec.mode, portion.band), tierMode: spec.mode,
          season: seasonText(season), seasonId: season ? season.id : null,
          seasonEffect: season ? season.spec.effect : null,
          version: versionLabel(version), versionId: version.id,
        });
      }
    }
    return groups.map((g) => {
      const qty = money(g.qty);
      const line = { ...g, qty, amount: money(qty * g.rate) };
      delete line.key;
      return line;
    }).filter((g) => g.qty !== 0);
  }

  function priceRows(versions, rows, code, timeZone) {
    const sorted = rows.filter((row) => row.qty > 0).map((row) => ({ ...row, version: versionAt(versions, row.t, timeZone) })).filter((row) => row.version).sort((a, b) => a.t - b.t);
    const byVersion = new Map();
    const byMonth = new Map();
    for (const row of sorted) {
      if (row.version.tierScope === 'version') {
        if (!byVersion.has(row.version.id)) byVersion.set(row.version.id, []);
        byVersion.get(row.version.id).push(row);
      } else {
        const key = localDay(row.t, timeZone).slice(0, 7);
        if (!byMonth.has(key)) byMonth.set(key, []);
        byMonth.get(key).push(row);
      }
    }
    const lines = [];
    for (const group of [...byVersion.values(), ...byMonth.values()]) {
      const pool = group.reduce((s, row) => s + row.qty, 0);
      lines.push(...priceSequence(group.map((row) => ({ ...row, poolQty: pool })), code, timeZone));
    }
    return lines;
  }

  function zeroLine(version, code) {
    const spec = chargeSpec(version, code);
    return {
      code, label: spec.label, qty: 0, rate: spec.rate, amount: 0,
      tier: '', tierMode: spec.mode, season: '', seasonId: null, seasonEffect: null,
      version: versionLabel(version), versionId: version ? version.id : null,
    };
  }

  function boundaryPoints(min, max, versions, timeZone) {
    const points = [min, max];
    let recurring = false;
    for (const v of versions) {
      if (v.effectiveFrom) {
        const t = zonedMidnight(v.effectiveFrom, timeZone);
        if (t > min && t < max) points.push(t);
      }
      for (const season of v.seasons || []) {
        if (season.from) {
          const a = zonedMidnight(season.from, timeZone);
          const b = zonedMidnight(addCalendarDays(season.to, 1), timeZone);
          if (a > min && a < max) points.push(a);
          if (b > min && b < max) points.push(b);
        }
        if (season.months) recurring = true;
      }
    }
    if (recurring || versions.some((v) => v.tierScope !== 'version')) {
      let day = localDay(min, timeZone).slice(0, 8) + '01';
      for (let i = 0; i < 480; i++) {
        const t = zonedMidnight(day, timeZone);
        if (t >= max) break;
        if (t > min) points.push(t);
        day = addCalendarDays(day, daysInMonth(day));
      }
    }
    return [...new Set(points)].sort((a, b) => a - b);
  }

  function padAisle(value) {
    const s = String(value || '').trim();
    if (/^\d+$/.test(s)) return s.padStart(2, '0');
    return s.toUpperCase();
  }

  function normalizeSpace(wh, raw, index) {
    if (!raw || typeof raw !== 'object') throw new Error('Dedicated space needs a scope and a fee');
    const scope = String(raw.scope || '').trim().toLowerCase();
    if (!['warehouse', 'cell', 'aisle', 'bay', 'position', 'height'].includes(scope)) throw new Error('Dedicated space is the warehouse, a cell, an aisle, a bay, a position or a height');
    const fee = tariffNumber(raw.fee, 'Space fee');
    const space = { id: String(raw.id || `S${index + 1}`).slice(0, 12), scope, fee };
    const aisles = (wh.layout && wh.layout.aisles) || [];
    if (scope === 'cell') {
      space.cell = String(raw.cell || raw.ref || '').trim().toUpperCase();
      if (!space.cell) throw new Error('Name the cell');
      const known = new Set(Object.values((wh.naming && wh.naming.cellOf) || {}));
      if (known.size && !known.has(space.cell)) throw new Error(`No cell ${space.cell}`);
      space.label = `Dedicated space (cell ${space.cell})`;
    } else if (scope === 'warehouse') {
      space.label = 'Dedicated space (warehouse)';
    } else {
      space.aisle = padAisle(raw.aisle);
      if (aisles.length && !aisles.includes(space.aisle) && !(wh.layout.blocks || []).includes(space.aisle)) throw new Error(`No aisle ${space.aisle}`);
      space.label = `Dedicated space (aisle ${space.aisle})`;
      if (scope !== 'aisle') {
        const bay = Number(raw.bay);
        if (!Number.isInteger(bay) || bay < 1) throw new Error('Bay is a whole number above 0');
        space.bay = bay;
        space.label = `Dedicated space (aisle ${space.aisle} bay ${bay})`;
      }
      if (scope === 'position' || scope === 'height') {
        const pos = Number(raw.pos != null ? raw.pos : raw.position);
        if (!Number.isFinite(pos)) throw new Error('Name the position');
        space.pos = pos;
        space.label = `Dedicated space (aisle ${space.aisle} bay ${space.bay} position ${pos})`;
      }
      if (scope === 'height') {
        const level = raw.level != null && raw.level !== '' ? raw.level : raw.height;
        if (level == null || level === '') throw new Error('Name the height');
        space.level = /^\d+$/.test(String(level)) ? Number(level) : String(level).toUpperCase();
        space.label = `Dedicated space (aisle ${space.aisle} bay ${space.bay} position ${space.pos} height ${space.level})`;
      }
    }
    return space;
  }

  function csvCell(value) {
    return `"${String(value == null ? '' : value).replace(/"/g, '""')}"`;
  }

  function install(Warehouse, deps) {
    const Labels = (deps && deps.Labels) || (typeof globalThis !== 'undefined' && globalThis.Labels) || null;
    const proto = Warehouse.prototype;

    proto.addWorkOrder = function ({ id, kitId, qty, orderId = null, by } = {}) {
      const key = String(id || '').trim();
      if (!key) throw new Error('A work order needs an id');
      this.workOrders = this.workOrders || {};
      if (this.workOrders[key]) throw new Error(`Work order ${key} already exists`);
      const kit = this.kits[kitId];
      if (!kit) throw new Error(`Unknown kit ${kitId}`);
      const amount = whole(qty, 'Work order quantity');
      if (orderId && !this.orders[String(orderId)]) throw new Error(`No order ${orderId}`);
      const wo = {
        id: key, kitId: kit.id, output: kit.output || kit.base.itemNo, qty: amount, built: 0,
        orderId: orderId ? String(orderId) : null, status: 'open', consumed: [],
        createdAt: this.now(), by: by || this._actor || 'operator',
      };
      this.workOrders[key] = wo;
      this.log(`Work order ${key}: ${amount} × ${kit.name}`);
      return wo;
    };

    proto._advanceWorkOrder = function (job, by) {
      const wo = (this.workOrders || {})[job.workOrderId];
      if (!wo) return job;
      wo.built += 1;
      wo.consumed.push({ t: this.now(), by, got: job.got.map((g) => ({ ...g })) });
      if (wo.orderId) {
        const order = this.orders[wo.orderId];
        const line = order && order.lines.find((l) => l.kind === 'each' && (l.kitId === wo.kitId || l.itemNo === wo.output) && (l.picked || 0) < l.units);
        if (line) {
          line.picked = (line.picked || 0) + 1;
          line.picks = line.picks || [];
          line.picks.push({ workOrderId: wo.id, qty: 1, t: this.now(), by });
          order.staged = order.staged || [];
          order.staged.push({ itemNo: line.itemNo, qty: 1, holder: wo.id, batch: null, expiry: null });
          const piece = order.lines.filter((l) => l.kind === 'each');
          if (!order.lines.some((l) => l.pallets)) order.status = piece.every((l) => (l.picked || 0) >= l.units) ? 'ready' : 'picking';
        }
      }
      if (wo.built >= wo.qty) {
        wo.status = 'done';
        job.status = 'done';
      } else {
        job.got = [];
        job.status = 'open';
      }
      return job;
    };

    proto.openCarton = function ({ orderId, by } = {}) {
      const order = this.orders[String(orderId)];
      if (!order) throw new Error(`No order ${orderId}`);
      if (order.status === 'shipped') throw new Error(`Order ${order.id} is shipped`);
      const minted = this.allocatePlate('OUT');
      const carton = this._makePlate(minted, { type: 'carton', loc: null, clientId: order.clientId || null, contents: [] });
      carton.orderId = order.id;
      carton.cartonStatus = 'open';
      carton.packed = [];
      carton.customer = order.customer;
      this.recordMovement({ holder: carton.id, from: null, to: null, qty: null, event: 'labelled', by: by || this._actor || 'office', note: order.id });
      this.log(`Carton ${carton.id} opened for order ${order.id}`);
      return carton;
    };

    proto.packIntoCarton = function ({ carton, code, qty = 1, by } = {}) {
      const box = this._holder(carton);
      if (box.series !== 'OUT' || box.cartonStatus !== 'open') throw new Error(`${box.id} is not an open carton`);
      const take = whole(qty, 'Pack quantity');
      const order = this.orders[box.orderId];
      const key = String(code || '').trim().toUpperCase();
      const holder = this.holders[key] || null;
      const staged = (order.staged || []).find((s) => ((holder && s.holder === holder.id) || (!holder && String(s.holder).toUpperCase() === key)) && Number(s.qty) >= take);
      const content = staged || (holder && (holder.contents || []).find((c) => Number(c.qty) >= take));
      if (!content) throw new Error(`${code} does not have ${take} to pack`);
      if (!order.lines.some((l) => l.itemNo === content.itemNo)) throw new Error(`${content.itemNo} is not on order ${order.id}`);
      content.qty -= take;
      if (!staged && holder) {
        const line = order.lines.find((l) => l.kind === 'each' && l.itemNo === content.itemNo && (l.picked || 0) < l.units);
        if (line) line.picked = Math.min(line.units, (line.picked || 0) + take);
      }
      const fromId = holder ? holder.id : content.holder || null;
      const row = { itemNo: content.itemNo, qty: take, from: fromId, batch: content.batch || null, expiry: content.expiry || null };
      box.packed.push(row);
      box.contents = box.packed.map((p) => ({ ...p }));
      this.recordMovement({ holder: fromId, from: holder ? holder.loc : null, to: box.id, qty: take, event: 'packed', by: by || this._actor || 'office', note: order.id });
      this.log(`Packed ${content.itemNo} × ${take} into ${box.id}`);
      return box;
    };

    proto.closeCarton = function ({ carton, lengthMm, widthMm, heightMm, weightKg, by } = {}) {
      const box = this._holder(carton);
      if (box.cartonStatus !== 'open') throw new Error(`${box.id} is not an open carton`);
      if (!box.packed.length) throw new Error('An empty carton cannot be closed');
      box.lengthMm = positive(lengthMm, 'Length');
      box.widthMm = positive(widthMm, 'Width');
      box.heightMm = positive(heightMm, 'Height');
      box.weightKg = positive(weightKg, 'Weight');
      box.cartonStatus = 'closed';
      box.closedAt = this.now();
      const order = this.orders[box.orderId];
      const lines = box.packed.map((p) => ({ ...p, name: this.items[p.itemNo] ? this.items[p.itemNo].name : '' }));
      const slipData = { plate: box.id, orderId: order.id, customer: order.customer, lengthMm: box.lengthMm, widthMm: box.widthMm, heightMm: box.heightMm, weightKg: box.weightKg, lines };
      const zpl = Labels && Labels.packingSlip ? Labels.packingSlip(slipData) : '';
      const qty = box.packed.reduce((s, p) => s + p.qty, 0);
      const label = this._printPlate(box, { itemNo: box.packed[0].itemNo, itemName: lines[0].name, qty, location: order.lane, orderId: order.id });
      const slip = { id: ++this._seq.label, kind: 'slip', plate: box.id, sscc: null, at: this.now(), printer: 'SIM', data: { ...slipData, kind: 'slip', title: `Packing slip ${box.id}` }, zpl };
      this.labelLog.unshift(slip);
      this.printQueue.unshift({ id: slip.id, printer: 'SIM', at: slip.at, label: slip.data, zpl });
      const piece = order.lines.filter((l) => l.kind === 'each');
      const wholeOf = (itemNo) => order.lines.filter((l) => l.kind === 'each' && l.itemNo === itemNo).reduce((s, l) => s + (this._wholePalletUnits ? this._wholePalletUnits(l) : 0), 0);
      const packedOf = (itemNo) => wholeOf(itemNo) + Object.values(this.holders).filter((h) => h.orderId === order.id && h.series === 'OUT' && h.cartonStatus && h.cartonStatus !== 'open').reduce((s, h) => s + h.packed.filter((p) => p.itemNo === itemNo).reduce((n, p) => n + p.qty, 0), 0);
      if (piece.length && piece.every((l) => (l.picked || 0) >= l.units && packedOf(l.itemNo) >= l.units) && !order.lines.some((l) => l.pallets)) order.status = 'packed';
      this.recordMovement({ holder: box.id, from: null, to: order.lane, qty, event: 'packed', by: by || this._actor || 'office', note: `${box.lengthMm}×${box.widthMm}×${box.heightMm} mm, ${box.weightKg} kg` });
      this.log(`Closed carton ${box.id} for order ${order.id}`);
      return { carton: box, label, slip };
    };

    proto.dispatchCartons = function ({ orderId, by } = {}) {
      const order = this.orders[String(orderId)];
      if (!order) throw new Error(`No order ${orderId}`);
      const boxes = Object.values(this.holders || {}).filter((h) => h.orderId === order.id && h.series === 'OUT' && h.cartonStatus === 'closed');
      if (!boxes.length) throw new Error('No closed cartons to dispatch');
      const piece = order.lines.filter((l) => l.kind === 'each');
      for (const line of piece) {
        const packed = boxes.reduce((s, h) => s + h.packed.filter((p) => p.itemNo === line.itemNo).reduce((n, p) => n + p.qty, 0), 0) + (this._wholePalletUnits ? this._wholePalletUnits(line) : 0);
        if ((line.picked || 0) < line.units || packed < line.units) throw new Error(`Order ${order.id} still needs ${line.itemNo} packed`);
      }
      if (piece.some((l) => (l.wholePallets || []).length)) throw new Error(`Order ${order.id} has whole pallets too. Stage it as one shipment`);
      const actor = by || this._actor || 'office';
      for (const box of boxes) {
        const from = box.loc;
        box.loc = order.lane;
        box.cartonStatus = 'shipped';
        const qty = box.packed.reduce((s, p) => s + p.qty, 0);
        this.recordMovement({ holder: box.id, from, to: order.lane, qty, event: 'shipped', by: actor, note: order.id });
      }
      if (!order.lines.some((l) => l.pallets)) {
        order.status = 'shipped';
        order.shippedAt = this.now();
        (this.shipments = this.shipments || []).push({ orderId: order.id, customer: order.customer, t: this.now(), cartons: boxes.map((b) => b.id), pallets: [] });
      }
      this.log(`Dispatched ${boxes.length} carton(s) for order ${order.id}`);
      return { order, cartons: boxes };
    };

    proto.setPickFace = function ({ code, itemNo, min, max, trigger = null } = {}) {
      const loc = this._loc(this.resolve(code));
      if (!['bin', 'mezzanine', 'rack'].includes(loc.kind) || loc.structural) throw new Error('A pick face is a bin, mezzanine or rack');
      const item = this.items[itemNo];
      if (!item) throw new Error(`Unknown item ${itemNo}`);
      const minN = Number(min);
      const maxN = Number(max);
      if (!Number.isInteger(minN) || minN < 0) throw new Error('Minimum must be a whole number of 0 or more');
      if (!Number.isInteger(maxN) || maxN < minN) throw new Error('Maximum must be a whole number at or above the minimum');
      const trig = trigger == null || trigger === '' ? minN : Number(trigger);
      if (!Number.isInteger(trig) || trig < minN || trig > maxN) throw new Error('The trigger sits between the minimum and the maximum');
      const mode = arguments[0].mode === 'pallet' ? 'pallet' : 'units';
      loc.replenishment = { itemNo: item.itemNo, min: minN, max: maxN, trigger: trig, mode };
      this.log(`Pick face ${loc.code}: ${item.itemNo} min ${minN} trigger ${trig} max ${maxN} (${mode})`);
      return loc.replenishment;
    };

    proto._faceQty = function (loc) {
      const spec = loc.replenishment;
      if (!spec) return 0;
      let n = 0;
      if (loc.sscc && this.pallets[loc.sscc] && this.pallets[loc.sscc].itemNo === spec.itemNo && this.pallets[loc.sscc].status !== 'shipped') n += this.pallets[loc.sscc].qty;
      for (const id of loc.pallets || []) {
        const p = this.pallets[id];
        if (p && p.itemNo === spec.itemNo && p.status !== 'shipped') n += p.qty;
      }
      for (const h of Object.values(this.holders || {})) {
        if (h.loc !== loc.code || h.sscc) continue;
        for (const c of h.contents || []) if (c.itemNo === spec.itemNo) n += Number(c.qty) || 0;
      }
      for (const l of (this.binStock && this.binStock[loc.code]) || []) if (l.itemNo === spec.itemNo) n += l.qty;
      return n;
    };

    proto.planReplenishment = function () {
      const created = [];
      for (const loc of Object.values(this.locations)) {
        const spec = loc.replenishment;
        if (!spec) continue;
        const onHand = this._faceQty(loc);
        if (onHand > spec.trigger) continue;
        const open = Object.values(this.tasks).some((t) => t.reason === 'replenish' && t.to === loc.code && t.status !== 'done' && t.status !== 'cancelled');
        if (open) continue;
        const need = spec.max - onHand;
        if (need < 1) continue;
        try {
          if (spec.mode === 'pallet') {
            created.push(this.replenish(spec.itemNo, loc.code, { topUp: true }));
            continue;
          }
          const source = this._fefo(spec.itemNo).find((p) => p.loc !== loc.code);
          if (!source) continue;
          if (source.qty <= need) {
            created.push(this.replenish(spec.itemNo, loc.code, { topUp: true }));
            continue;
          }
          const task = this._newTask({
            type: 'SHIFT', reason: 'replenish', sscc: source.sscc, from: source.loc, to: loc.code,
            category: this.items[spec.itemNo].category, splitQty: need,
          });
          loc.reservedBy = task.id;
          this.log(`Replenish ${need} of ${spec.itemNo} → ${loc.code} split from …${source.sscc.slice(-6)}`, { taskId: task.id });
          this.dispatch();
          created.push(task);
        } catch (e) { /* no free pallet, or the face cannot take one */ }
      }
      if (created.length) this.log(`${created.length} replenishment move(s) queued`);
      return created;
    };

    proto.applySplitDrop = function (truck, task) {
      const pallet = this.pallets[truck.load];
      const qty = Number(task.splitQty);
      if (!pallet || !Number.isInteger(qty) || qty < 1 || pallet.qty <= qty) throw new Error('Split replenishment needs a source plate with more than the top-up');
      const to = this.locations[task.to];
      if (to && to.reservedBy === task.id) to.reservedBy = null;
      const fromLoc = task.from;
      pallet.qty -= qty;
      this._place(pallet, fromLoc);
      const minted = this.allocatePlate('ST');
      const holder = this._makePlate(minted, {
        type: 'st', loc: task.to, clientId: pallet.clientId || null,
        contents: [{ itemNo: pallet.itemNo, qty, batch: pallet.batch, expiry: pallet.expiry, clientId: pallet.clientId || null }],
      });
      const actor = this._actor || truck.id;
      this.recordMovement({ sscc: pallet.sscc, holder: pallet.holderId || null, from: fromLoc, to: fromLoc, qty: pallet.qty, event: 'moved', by: actor, note: `Split ${qty} onto ${holder.id}` });
      this.recordMovement({ holder: holder.id, from: fromLoc, to: task.to, qty, event: 'moved', by: actor, note: 'replenishment' });
      truck.load = null;
      truck.position = task.to;
      task.alert = null;
      this._finish(truck, task);
      this.log(`Top-up ${qty} of ${pallet.itemNo} at ${task.to} on ${holder.id}`);
      this.dispatch();
      return { task, holder, source: pallet };
    };

    proto.receiveReturn = function ({ id, orderId, itemNo, qty, loc = null, by } = {}) {
      const order = this.orders[String(orderId)];
      if (!order) throw new Error(`No order ${orderId}`);
      if (!order.lines.some((l) => l.itemNo === itemNo)) throw new Error(`${itemNo} was not on order ${order.id}`);
      const amount = whole(qty, 'Return quantity');
      const code = loc ? this.resolve(loc) : null;
      if (code) {
        const place = this._loc(code);
        if (place.kind !== 'virtual' || !['return', 'quarantine', 'staging'].includes(place.role)) throw new Error('Receive a return at a virtual return, quarantine or staging location');
      }
      this.returns = this.returns || {};
      const rid = String(id || '').trim();
      if (!rid) throw new Error('A return needs an id');
      if (this.returns[rid]) throw new Error(`Return ${rid} already exists`);
      const actor = by || this._actor || 'office';
      const rma = { id: rid, orderId: order.id, itemNo, qty: amount, loc: code, status: 'received', grade: null, holderId: null, receivedAt: this.now(), by: actor, history: [{ t: this.now(), event: 'received', by: actor, to: code, qty: amount }] };
      this.returns[rid] = rma;
      this.recordMovement({ from: null, to: code, qty: amount, event: 'received', by: actor, note: `RMA ${rid} order ${order.id}` });
      this.log(`Return ${rid} received for order ${order.id}: ${itemNo} × ${amount}`);
      return rma;
    };

    proto.gradeReturn = function ({ id, grade, to = null, by } = {}) {
      const rma = (this.returns || {})[String(id)];
      if (!rma) throw new Error(`Unknown return ${id}`);
      if (rma.status !== 'received') throw new Error(`Return ${rma.id} is already ${rma.status}`);
      if (!['restock', 'quarantine', 'scrap'].includes(grade)) throw new Error('Grade a return as restock, quarantine or scrap');
      const actor = by || this._actor || 'office';
      if (grade === 'scrap') {
        rma.status = 'scrapped';
        rma.grade = 'scrap';
        rma.history.push({ t: this.now(), event: 'scrapped', by: actor, qty: rma.qty });
        this.recordMovement({ from: rma.loc, to: null, qty: rma.qty, event: 'scrapped', by: actor, note: `RMA ${rma.id}` });
        this.log(`Return ${rma.id} scrapped`);
        return rma;
      }
      const dest = this.resolve(to);
      const place = this._loc(dest);
      if (grade === 'quarantine') {
        if (place.kind !== 'virtual' || place.role !== 'quarantine') throw new Error('Quarantine a return at a virtual quarantine location');
        rma.status = 'quarantine';
      } else if (place.kind === 'virtual' && place.role !== 'staging') throw new Error('Restock into a bin, mezzanine, rack or staging location');
      const minted = this.allocatePlate('ST');
      const holder = this._makePlate(minted, { type: 'st', loc: dest, contents: [{ itemNo: rma.itemNo, qty: rma.qty, batch: `RMA-${rma.id}`, expiry: null }] });
      rma.holderId = holder.id;
      rma.loc = dest;
      rma.grade = grade;
      if (grade === 'restock') rma.status = 'restocked';
      rma.history.push({ t: this.now(), event: grade, by: actor, to: dest, qty: rma.qty, holder: holder.id });
      this.recordMovement({ holder: holder.id, from: null, to: dest, qty: rma.qty, event: grade === 'quarantine' ? 'moved' : 'received', by: actor, note: `RMA ${rma.id} ${grade}` });
      this.log(`Return ${rma.id} graded ${grade} at ${dest}`);
      return rma;
    };

    proto.exportStock = function ({ itemNo, qty, toSite, fromSite = null, by } = {}) {
      const amount = whole(qty, 'Transfer quantity');
      if (!toSite) throw new Error('A destination warehouse is required');
      const item = this.items[itemNo];
      if (!item) throw new Error(`Unknown item ${itemNo}`);
      const actor = by || this._actor || 'office';
      const pallet = Object.values(this.pallets).find((p) => p.itemNo === itemNo && p.status !== 'shipped' && p.loc && !p.orderId && p.qty === amount);
      let batch = null;
      let expiry = null;
      let clientId = item.clientId || null;
      if (pallet) {
        batch = pallet.batch;
        expiry = pallet.expiry;
        clientId = pallet.clientId || clientId;
        const from = pallet.loc;
        this._remove(pallet);
        pallet.status = 'shipped';
        pallet.transferredTo = String(toSite);
        this.recordMovement({ sscc: pallet.sscc, holder: pallet.holderId || null, from, to: `SITE-${toSite}`, qty: amount, event: 'transferred', by: actor, note: String(toSite) });
      } else {
        const holder = Object.values(this.holders || {}).find((h) => h.status !== 'retired' && !h.cartonStatus && (h.contents || []).some((c) => c.itemNo === itemNo && Number(c.qty) >= amount) && !(h.sscc && this.pallets[h.sscc] && this.pallets[h.sscc].orderId));
        if (!holder) throw new Error(`No ${itemNo} stock of ${amount} to transfer`);
        const line = holder.contents.find((c) => c.itemNo === itemNo && Number(c.qty) >= amount);
        line.qty -= amount;
        batch = line.batch || null;
        expiry = line.expiry || null;
        clientId = line.clientId || holder.clientId || clientId;
        this.recordMovement({ holder: holder.id, from: holder.loc, to: `SITE-${toSite}`, qty: amount, event: 'transferred', by: actor, note: String(toSite) });
      }
      this.log(`Transferred ${itemNo} × ${amount} to ${toSite}`);
      return { itemNo, qty: amount, batch, expiry, clientId, fromSite: fromSite || 'MAIN', toSite: String(toSite) };
    };

    proto.importStock = function ({ itemNo, qty, batch = null, expiry = null, clientId = null, fromSite = null, by } = {}) {
      const item = this.items[itemNo];
      if (!item) throw new Error(`This warehouse has no item ${itemNo}`);
      const amount = whole(qty, 'Transfer quantity');
      const loc = this.locations['DOCK-IN'] ? 'DOCK-IN' : Object.keys(this.locations)[0];
      if (!loc) throw new Error('This warehouse has nowhere to receive a transfer');
      const minted = this.allocatePlate('ST');
      const holder = this._makePlate(minted, {
        type: 'st', loc, clientId: clientId || item.clientId || null,
        contents: [{ itemNo, qty: amount, batch, expiry, clientId: clientId || item.clientId || null }],
      });
      this.recordMovement({ holder: holder.id, from: fromSite ? `SITE-${fromSite}` : null, to: loc, qty: amount, event: 'received', by: by || this._actor || 'office', note: fromSite || 'transfer' });
      this.log(`Received ${itemNo} × ${amount} from ${fromSite || 'a transfer'} as ${holder.id}`);
      return { holder, itemNo, qty: amount, batch, expiry, clientId, fromSite };
    };

    function htmlEscape(value) {
      return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    proto.stageShipment = function ({ orderId, truck = null, by } = {}) {
      const order = this.orders[String(orderId)];
      if (!order) throw new Error(`No order ${orderId}`);
      if (order.status === 'shipped') throw new Error(`Order ${order.id} is shipped`);
      const piece = order.lines.filter((l) => l.kind === 'each');
      for (const line of piece) if ((line.picked || 0) < line.units) throw new Error(`Order ${order.id} still needs ${line.itemNo} picked`);
      const holders = [];
      for (const sscc of order.lines.flatMap((l) => (l.allocated || []).concat(l.wholePallets || []))) {
        const pallet = this.pallets[sscc];
        if (!pallet) throw new Error(`Missing pallet ${sscc}`);
        holders.push({ kind: 'pallet', id: pallet.holderId || pallet.sscc, sscc: pallet.sscc, itemNo: pallet.itemNo, qty: pallet.qty, loc: pallet.loc, loaded: false });
      }
      const boxes = Object.values(this.holders || {}).filter((h) => h.orderId === order.id && h.series === 'OUT' && (h.cartonStatus === 'closed' || h.cartonStatus === 'staged'));
      for (const line of piece) {
        const packed = boxes.reduce((s, h) => s + (h.packed || []).filter((p) => p.itemNo === line.itemNo).reduce((n, p) => n + p.qty, 0), 0) + (this._wholePalletUnits ? this._wholePalletUnits(line) : 0);
        if (packed < line.units) throw new Error(`Order ${order.id} still needs ${line.itemNo} packed`);
      }
      for (const box of boxes) {
        const qty = (box.packed || []).reduce((s, p) => s + p.qty, 0);
        holders.push({ kind: 'carton', id: box.id, sscc: null, itemNo: box.packed[0] ? box.packed[0].itemNo : null, qty, loc: box.loc, loaded: false });
        box.cartonStatus = 'staged';
      }
      if (!holders.length) throw new Error('Nothing to dispatch');
      const actor = by || this._actor || 'office';
      order.shipment = {
        status: 'staged', lane: order.lane, truck: truck ? String(truck).slice(0, 40) : null,
        holders, scans: [], stagedAt: this.now(), by: actor,
      };
      this.log(`Shipment for ${order.id} staged: ${holders.length} holder(s) on ${order.lane}`);
      return order.shipment;
    };

    proto.scanShipment = function ({ orderId, code, by } = {}) {
      const order = this.orders[String(orderId)];
      if (!order || !order.shipment) throw new Error(`Order ${orderId} has no staged shipment`);
      const ship = order.shipment;
      if (ship.status === 'dispatched') throw new Error(`Order ${order.id} is already dispatched`);
      const key = String(code || '').trim().toUpperCase();
      if (!key) throw new Error('Scan a pallet or a carton');
      const line = ship.holders.find((h) => h.id === key || h.sscc === key);
      if (!line) throw new Error(`${key} is not on this load`);
      if (line.loaded) throw new Error(`${key} is already confirmed`);
      if (line.kind === 'pallet') {
        const pallet = this.pallets[line.sscc];
        if (!pallet || pallet.loc !== ship.lane) throw new Error(`${key} is not at ${ship.lane}`);
      }
      line.loaded = true;
      line.loadedAt = this.now();
      line.loadedBy = by || this._actor || 'office';
      ship.scans.push({ code: key, t: line.loadedAt, by: line.loadedBy });
      ship.status = ship.holders.every((h) => h.loaded) ? 'loaded' : 'staged';
      this.recordMovement({ holder: line.kind === 'carton' ? line.id : null, sscc: line.sscc, from: line.loc, to: ship.lane, qty: line.qty, event: 'moved', by: line.loadedBy, note: `Load ${order.id}` });
      this.log(`Loaded ${key} on ${order.id} (${ship.holders.filter((h) => h.loaded).length}/${ship.holders.length})`);
      return ship;
    };

    proto.dispatchShipment = function ({ orderId, by } = {}) {
      const order = this.orders[String(orderId)];
      if (!order || !order.shipment) throw new Error(`Order ${orderId} has no staged shipment`);
      const ship = order.shipment;
      if (ship.status !== 'loaded') throw new Error('Confirm every pallet and carton before dispatch');
      const actor = by || this._actor || 'office';
      const shippedPallets = [];
      for (const line of ship.holders.filter((h) => h.kind === 'pallet')) {
        const pallet = this.pallets[line.sscc];
        const fromLoc = pallet.loc;
        this._remove(pallet);
        pallet.status = 'shipped';
        this.recordMovement({ holder: pallet.holderId || null, sscc: pallet.sscc, from: fromLoc, to: null, qty: pallet.qty, event: 'shipped', by: actor, note: order.id });
        shippedPallets.push({ sscc: pallet.sscc, itemNo: pallet.itemNo, qty: pallet.qty });
      }
      const shippedCartons = [];
      for (const line of ship.holders.filter((h) => h.kind === 'carton')) {
        const box = this.holders[line.id];
        box.cartonStatus = 'shipped';
        box.loc = ship.lane;
        this.recordMovement({ holder: box.id, from: line.loc, to: ship.lane, qty: line.qty, event: 'shipped', by: actor, note: order.id });
        shippedCartons.push(box.id);
      }
      ship.status = 'dispatched';
      ship.dispatchedAt = this.now();
      ship.dispatchedBy = actor;
      order.status = 'shipped';
      order.shippedAt = this.now();
      const record = { orderId: order.id, customer: order.customer, t: this.now(), lane: ship.lane, truck: ship.truck, pallets: shippedPallets, cartons: shippedCartons, status: 'dispatched' };
      (this.shipments = this.shipments || []).push(record);
      this.log(`Order ${order.id} dispatched as one shipment`);
      return ship;
    };

    proto.deliveryNote = function (orderId) {
      const order = this.orders[String(orderId)];
      if (!order || !order.shipment) throw new Error(`Order ${orderId} has no shipment`);
      const ship = order.shipment;
      const rows = ship.holders.map((h) => `<tr><td>${htmlEscape(h.kind)}</td><td>${htmlEscape(h.sscc || h.id)}</td><td>${htmlEscape(h.itemNo || '')}</td><td>${htmlEscape(h.qty)}</td><td>${h.loaded ? 'loaded' : 'staged'}</td></tr>`).join('');
      return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Delivery note ${htmlEscape(order.id)}</title>
        <style>body{font:15px/1.4 system-ui,sans-serif;margin:24px;color:#17202a}h1{font-size:22px;margin:0 0 4px}table{border-collapse:collapse;width:100%;margin-top:12px}th,td{border-bottom:1px solid #dde3e8;text-align:left;padding:6px 8px}th{color:#5d6b76}@media print{body{margin:12px}}</style></head>
        <body><h1>Delivery note ${htmlEscape(order.id)}</h1><p>${htmlEscape(order.customer)} · lane ${htmlEscape(ship.lane)}${ship.truck ? ` · truck ${htmlEscape(ship.truck)}` : ''} · ${htmlEscape(ship.status)}</p>
        <h2>Load manifest</h2><table><tr><th>Kind</th><th>Holder</th><th>Item</th><th>Qty</th><th>Load</th></tr>${rows}</table></body></html>`;
    };

    proto.ensureTransit = function () {
      if (this.locations['IN-TRANSIT']) return this.locations['IN-TRANSIT'];
      return this.createLocation({ code: 'IN-TRANSIT', kind: 'virtual', role: 'transit', name: 'In transit' });
    };

    proto.shipTransfer = function ({ id, itemNo, qty, toSite, fromSite = null, by } = {}) {
      const amount = whole(qty, 'Transfer quantity');
      const dest = String(toSite || '').trim().toUpperCase();
      if (!dest) throw new Error('A destination warehouse is required');
      const item = this.items[itemNo];
      if (!item) throw new Error(`Unknown item ${itemNo}`);
      const tid = String(id || '').trim().toUpperCase();
      if (!/^[A-Z0-9][A-Z0-9_-]{0,23}$/.test(tid)) throw new Error('Transfer id uses letters, digits, hyphen or underscore');
      this.siteTransfers = this.siteTransfers || {};
      if (this.siteTransfers[tid]) throw new Error(`Transfer ${tid} already exists`);
      this.ensureTransit();
      const actor = by || this._actor || 'office';
      const pallet = Object.values(this.pallets).find((p) => p.itemNo === itemNo && p.status !== 'shipped' && p.loc && p.loc !== 'IN-TRANSIT' && !p.orderId && p.qty === amount);
      let record;
      if (pallet) {
        const from = pallet.loc;
        this._remove(pallet);
        this._place(pallet, 'IN-TRANSIT');
        pallet.transitFrom = from;
        record = { id: tid, itemNo, qty: amount, batch: pallet.batch, expiry: pallet.expiry, clientId: pallet.clientId || item.clientId || null, toSite: dest, fromSite: fromSite || 'MAIN', from, sscc: pallet.sscc, holderId: pallet.holderId || null, partial: false, status: 'in-transit', by: actor, t: this.now() };
        this.recordMovement({ sscc: pallet.sscc, holder: pallet.holderId || null, from, to: 'IN-TRANSIT', qty: amount, event: 'transferred', by: actor, note: tid });
      } else {
        const holder = Object.values(this.holders || {}).find((h) => h.status !== 'retired' && h.status !== 'transferred' && !h.cartonStatus && h.loc !== 'IN-TRANSIT' && (h.contents || []).some((c) => c.itemNo === itemNo && Number(c.qty) >= amount));
        if (!holder) throw new Error(`No ${itemNo} stock of ${amount} to transfer`);
        const line = holder.contents.find((c) => c.itemNo === itemNo && Number(c.qty) >= amount);
        const from = holder.loc;
        if (Number(line.qty) === amount) {
          holder.loc = 'IN-TRANSIT';
          holder.transitFrom = from;
          record = { id: tid, itemNo, qty: amount, batch: line.batch || null, expiry: line.expiry || null, clientId: holder.clientId || item.clientId || null, toSite: dest, fromSite: fromSite || 'MAIN', from, sscc: null, holderId: holder.id, partial: false, status: 'in-transit', by: actor, t: this.now() };
        } else {
          line.qty -= amount;
          record = { id: tid, itemNo, qty: amount, batch: line.batch || null, expiry: line.expiry || null, clientId: holder.clientId || item.clientId || null, toSite: dest, fromSite: fromSite || 'MAIN', from, sscc: null, holderId: holder.id, partial: true, status: 'in-transit', by: actor, t: this.now() };
        }
        this.recordMovement({ holder: holder.id, from, to: 'IN-TRANSIT', qty: amount, event: 'transferred', by: actor, note: tid });
      }
      this.siteTransfers[tid] = record;
      this.log(`Transfer ${tid} in transit to ${dest}: ${itemNo} × ${amount}`);
      return record;
    };

    proto.cancelSiteTransfer = function ({ id, by } = {}) {
      const tid = String(id || '').trim().toUpperCase();
      const record = (this.siteTransfers || {})[tid];
      if (!record) throw new Error(`Unknown transfer ${tid}`);
      if (record.status !== 'in-transit') throw new Error(`Transfer ${tid} is ${record.status}`);
      const actor = by || this._actor || 'office';
      if (record.sscc) {
        const pallet = this.pallets[record.sscc];
        this._remove(pallet);
        this._place(pallet, record.from);
        delete pallet.transitFrom;
      } else {
        const holder = this.holders[record.holderId];
        const line = (holder.contents || []).find((c) => c.itemNo === record.itemNo);
        if (record.partial) line.qty += record.qty;
        else holder.loc = record.from;
      }
      record.status = 'cancelled';
      record.cancelledAt = this.now();
      this.recordMovement({ sscc: record.sscc, holder: record.holderId, from: 'IN-TRANSIT', to: record.from, qty: record.qty, event: 'moved', by: actor, note: `${tid} refused` });
      this.log(`Transfer ${tid} returned to ${record.from}`);
      return record;
    };

    proto.completeSiteTransfer = function ({ id, by } = {}) {
      const tid = String(id || '').trim().toUpperCase();
      const record = (this.siteTransfers || {})[tid];
      if (!record) throw new Error(`Unknown transfer ${tid}`);
      if (record.status !== 'in-transit') throw new Error(`Transfer ${tid} is ${record.status}`);
      if (record.sscc) {
        const pallet = this.pallets[record.sscc];
        this._remove(pallet);
        pallet.status = 'shipped';
        pallet.transferredTo = record.toSite;
      } else if (!record.partial) {
        const holder = this.holders[record.holderId];
        holder.loc = null;
        holder.status = 'transferred';
      }
      record.status = 'received';
      record.receivedAt = this.now();
      this.recordMovement({ sscc: record.sscc, holder: record.holderId, from: 'IN-TRANSIT', to: `SITE-${record.toSite}`, qty: record.qty, event: 'shipped', by: by || this._actor || 'office', note: tid });
      this.log(`Transfer ${tid} received at ${record.toSite}`);
      return record;
    };

    proto.receiveSiteTransfer = function (payload) {
      return this.importStock(payload);
    };

    proto.timeZone = function () {
      return (this.config && this.config.timeZone) || 'Europe/Brussels';
    };

    proto.localDay = function (ms = this.now()) {
      return localDay(ms, this.timeZone());
    };

    proto.zonedMidnight = function (day) {
      return zonedMidnight(day, this.timeZone());
    };

    proto.formatLocal = function (ms) {
      const p = localParts(ms, this.timeZone());
      return `${p.year}-${p.month}-${p.day} ${String(p.hour).padStart(2, '0')}:${p.minute}:${p.second}`;
    };

    proto.decorateTariff = function (client) {
      const list = assertOrder(savedVersions(client).slice());
      const today = this.localDay();
      return list.map((v) => ({ ...v, readOnly: isReadOnly(list, v, today) }));
    };

    proto.setTariff = function (clientId, input = {}, by) {
      const client = this._client(clientId);
      const actor = by || this._actor || 'unknown';
      const fields = tariffFields(input);
      const hasDate = input.effectiveFrom != null && input.effectiveFrom !== '';
      const effectiveFrom = hasDate ? parseDay(input.effectiveFrom, 'Effective date') : undefined;
      const versionId = input.versionId ? String(input.versionId).trim() : '';
      const existing = Array.isArray(client.tariffVersions) ? client.tariffVersions.slice() : [];
      const today = this.localDay();
      let version;
      let next;
      if (versionId) {
        const idx = existing.findIndex((v) => v.id === versionId);
        if (idx < 0) throw new Error(`Unknown rate card ${versionId}`);
        if (isReadOnly(assertOrder(existing), existing[idx], today)) throw new Error(`Rate card ${versionId} is read-only`);
        version = { ...existing[idx], ...fields, effectiveFrom: effectiveFrom === undefined ? existing[idx].effectiveFrom : effectiveFrom, updatedAt: this.now(), updatedBy: actor };
        next = existing.slice();
        next[idx] = version;
      } else if (!existing.length && effectiveFrom === undefined) {
        version = { id: 'v1', effectiveFrom: null, createdAt: this.now(), createdBy: actor, updatedAt: this.now(), updatedBy: actor, ...fields };
        next = [version];
      } else if (effectiveFrom === undefined && existing.length === 1 && existing[0].effectiveFrom == null) {
        if (isReadOnly(existing, existing[0], today)) throw new Error(`Rate card ${existing[0].id} is read-only`);
        version = { ...existing[0], ...fields, updatedAt: this.now(), updatedBy: actor };
        next = [version];
      } else if (effectiveFrom === undefined) {
        throw new Error('Name the date this rate card starts');
      } else {
        const clash = existing.find((v) => v.effectiveFrom === effectiveFrom);
        if (clash) {
          if (isReadOnly(assertOrder(existing), clash, today)) throw new Error(`Rate card ${clash.id} is read-only`);
          const idx = existing.findIndex((v) => v.id === clash.id);
          version = { ...clash, ...fields, effectiveFrom, updatedAt: this.now(), updatedBy: actor };
          next = existing.slice();
          next[idx] = version;
        } else {
          const latest = assertOrder(existing)[existing.length - 1];
          if (latest && latest.effectiveFrom && effectiveFrom <= latest.effectiveFrom) throw new Error(`A new rate card has to start after ${latest.id} (${latest.effectiveFrom})`);
          version = { id: nextVersionId(existing), effectiveFrom, createdAt: this.now(), createdBy: actor, updatedAt: this.now(), updatedBy: actor, ...fields };
          next = existing.concat(version);
        }
      }
      client.tariffVersions = assertOrder(next);
      const current = versionAt(client.tariffVersions, this.now(), this.timeZone()) || client.tariffVersions[client.tariffVersions.length - 1];
      client.tariff = { ...current };
      this.log(`Tariff ${client.id} ${version.id} (${version.effectiveFrom || 'from the start'}) saved by ${actor}`, { by: actor });
      return this.decorateTariff(client);
    };

    proto.setSpaces = function (clientId, spaces = [], by) {
      const client = this._client(clientId);
      if (!Array.isArray(spaces)) throw new Error('Dedicated space is a list');
      const list = spaces.map((raw, i) => normalizeSpace(this, raw, i));
      client.spaces = list;
      const actor = by || this._actor || 'unknown';
      this.log(`Dedicated space for ${client.id} saved by ${actor}`, { by: actor });
      return client.spaces;
    };

    proto.invoice = function ({ clientId, from = null, to = null } = {}) {
      const client = this._client(clientId);
      const tz = this.timeZone();
      const versions = assertOrder(versionList(client).slice());
      const start = bound(from, false, tz);
      const end = bound(to, true, tz);
      if (start != null && end != null && end <= start) throw new Error('The billing period ends before it starts');
      const now = this.now();
      const ownerOfPallet = (p) => p.clientId || (this.items[p.itemNo] && this.items[p.itemNo].clientId);
      const ownedMove = (m) => {
        const pallet = m.sscc && this.pallets[m.sscc];
        const holder = m.holder && this.holders && this.holders[m.holder];
        const owner = (pallet && ownerOfPallet(pallet)) || (holder && holder.clientId);
        return owner === client.id && inWindow(m.t, start, end);
      };
      const stays = [];
      let palletDays = 0;
      for (const p of Object.values(this.pallets)) {
        if (ownerOfPallet(p) !== client.id || !p.receivedAt) continue;
        const shipped = p.status === 'shipped' ? ((this.movements || []).find((m) => m.sscc === p.sscc && (m.event === 'shipped' || m.event === 'transferred')) || {}).t || p.receivedAt : now;
        const a = Math.max(p.receivedAt, start == null ? p.receivedAt : start);
        const b = Math.min(shipped, end == null ? shipped : end);
        if (b <= a) continue;
        const item = this.items[p.itemNo];
        const cubic = item && item.lengthMm && item.widthMm && item.heightMm ? (item.lengthMm * item.widthMm * item.heightMm) / 1e9 : 0;
        stays.push({ a, b, cubic });
        palletDays += (b - a) / DAY;
      }
      const storageRows = [];
      if (stays.length) {
        const min = Math.min(...stays.map((s) => s.a));
        const max = Math.max(...stays.map((s) => s.b));
        const points = boundaryPoints(min, max, versions, tz);
        for (const stay of stays) { points.push(stay.a, stay.b); }
        const cuts = [...new Set(points)].filter((t) => t >= min && t <= max).sort((a, b) => a - b);
        for (let i = 0; i < cuts.length - 1; i++) {
          const a = cuts[i];
          const b = cuts[i + 1];
          let days = 0;
          let cubicDays = 0;
          for (const stay of stays) {
            const left = Math.max(a, stay.a);
            const right = Math.min(b, stay.b);
            if (right <= left) continue;
            const part = (right - left) / DAY;
            days += part;
            cubicDays += part * stay.cubic;
          }
          if (days > 0) storageRows.push({ t: a, days, cubicDays });
        }
      }
      const storageQtyRows = [];
      for (const row of storageRows) {
        const version = versionAt(versions, row.t, tz);
        if (!version) continue;
        const qty = version.storageBasis === 'm3-day' ? row.cubicDays : row.days;
        if (qty > 0) storageQtyRows.push({ t: row.t, qty });
      }
      const storageLines = priceRows(versions, storageQtyRows, 'storage', tz);
      const inboundEvents = [];
      for (const p of Object.values(this.pallets)) {
        if (ownerOfPallet(p) !== client.id || !p.receivedAt || !inWindow(p.receivedAt, start, end)) continue;
        inboundEvents.push({ t: p.receivedAt, byBasis: { pallet: 1 } });
      }
      for (const m of this.movements || []) {
        if (m.event === 'received' && ownedMove(m)) inboundEvents.push({ t: m.t, byBasis: { line: 1 } });
      }
      const orders = Object.values(this.orders).filter((o) => o.clientId === client.id && o.shippedAt && inWindow(o.shippedAt, start, end));
      const outboundEvents = orders.map((o) => ({
        t: o.shippedAt,
        byBasis: {
          order: 1,
          line: o.lines.length,
          carton: (this.shipments || []).filter((s) => s.orderId === o.id).reduce((n, s) => n + (s.cartons || []).length, 0),
        },
      }));
      const valEvents = (this.movements || []).filter((m) => m.event === 'kitted' && ownedMove(m)).map((m) => ({ t: m.t, byBasis: { unit: 1 } }));
      const eventRows = (events, code) => events.flatMap((event) => {
        const version = versionAt(versions, event.t, tz);
        if (!version) return [];
        const qty = event.byBasis[chargeSpec(version, code).basis] || 0;
        return qty > 0 ? [{ t: event.t, qty }] : [];
      });
      const minAt = end == null ? now : end - 1;
      const minVersion = versionAt(versions, minAt, tz);
      const lines = [];
      const priced = {
        storage: storageLines,
        inbound: priceRows(versions, eventRows(inboundEvents, 'inbound'), 'inbound', tz),
        outbound: priceRows(versions, eventRows(outboundEvents, 'outbound'), 'outbound', tz),
        val: priceRows(versions, eventRows(valEvents, 'val'), 'val', tz),
      };
      for (const code of CHARGE_IDS) {
        if (priced[code].length) lines.push(...priced[code]);
        else lines.push(zeroLine(minVersion || versions[versions.length - 1], code));
      }
      for (const space of client.spaces || []) {
        lines.push({
          code: 'space', label: space.label, qty: 1, rate: space.fee, amount: space.fee,
          tier: '', tierMode: null, season: '', seasonId: null, seasonEffect: null,
          version: versionLabel(minVersion), versionId: minVersion ? minVersion.id : null,
        });
      }
      const subtotal = money(lines.reduce((s, l) => s + l.amount, 0));
      let minimum = minVersion ? (minVersion.minimum || 0) : 0;
      if (minVersion && minVersion.minimumMode === 'prorate' && start != null && end != null && minimum > 0) {
        const days = calendarDays(start, end, tz);
        minimum = money(minimum * days / daysInMonth(localDay(minAt, tz)));
      }
      const topup = money(minimum - subtotal);
      if (topup > 0) {
        lines.push({
          code: 'minimum', label: 'Monthly minimum', qty: 1, rate: topup, amount: topup,
          tier: '', tierMode: null, season: '', seasonId: null, seasonEffect: null,
          version: versionLabel(minVersion), versionId: minVersion ? minVersion.id : null,
        });
      }
      const moves = (this.movements || []).filter((m) => ownedMove(m) && ['moved', 'picked', 'consolidated', 'shipped', 'received', 'packed', 'transferred'].includes(m.event));
      const tariff = minVersion || versions[versions.length - 1];
      return {
        clientId: client.id, name: client.name, from: start, to: end == null ? null : end - 1,
        periodFrom: typeof from === 'string' ? from : null, periodTo: typeof to === 'string' ? to : null,
        timeZone: tz, country: (this.config && this.config.country) || null,
        tariff, lines, subtotal, minimum, minimumVersion: versionLabel(minVersion),
        total: money(Math.max(minimum, subtotal)), palletDays: money(palletDays), moves: moves.length,
      };
    };

    proto.invoiceHtml = function (opts) {
      const inv = this.invoice(opts);
      const rows = inv.lines.map((l) => `<tr><td>${htmlEscape(l.label)}</td><td>${htmlEscape(l.qty)}</td><td>${htmlEscape(l.rate)}</td><td>${htmlEscape(l.tier || '')}</td><td>${htmlEscape(l.season || '')}</td><td>${htmlEscape(l.version || '')}</td><td>${htmlEscape(l.amount)}</td></tr>`).join('');
      const period = inv.periodFrom || inv.periodTo ? `${htmlEscape(inv.periodFrom || '…')} to ${htmlEscape(inv.periodTo || '…')} (${htmlEscape(inv.timeZone || '')})` : 'Open period, up to the current time';
      return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Invoice ${htmlEscape(inv.clientId)}</title>
        <style>body{font:15px/1.4 system-ui,sans-serif;margin:24px;color:#17202a}table{border-collapse:collapse;width:100%;margin-top:12px}th,td{border-bottom:1px solid #dde3e8;text-align:left;padding:6px 8px;vertical-align:top}th{color:#5d6b76}.total{font-size:18px;font-weight:700}.note{color:#5d6b76;font-size:13px;max-width:46rem}@media print{body{margin:12px}}</style></head>
        <body><h1>Invoice ${htmlEscape(inv.clientId)}</h1><p>${htmlEscape(inv.name)}</p><p>${period}</p>
        <table><tr><th>Charge</th><th>Qty</th><th>Rate</th><th>Tier</th><th>Season</th><th>Version</th><th>Amount</th></tr>${rows}</table>
        <p>Subtotal ${htmlEscape(inv.subtotal)}. Minimum ${htmlEscape(inv.minimum)}${inv.minimumVersion ? ` (${htmlEscape(inv.minimumVersion)})` : ''}.</p><p class="total">Total ${htmlEscape(inv.total)}</p>
        <p class="note">Dates are local midnights in ${htmlEscape(inv.timeZone || 'the warehouse timezone')}. Storage that crosses a season or a new rate card is split there. An inbound, outbound or kitting event uses the card in effect at its own time. The monthly minimum is taken from the card in effect on the last day.</p></body></html>`;
    };

    proto.invoiceCsv = function (opts) {
      const inv = this.invoice(opts);
      const rows = [['charge', 'label', 'qty', 'rate', 'amount', 'tier', 'season', 'version']];
      for (const l of inv.lines) rows.push([l.code, l.label, l.qty, l.rate, l.amount, l.tier || '', l.season || '', l.version || '']);
      return rows.map((r) => r.map(csvCell).join(',')).join('\n');
    };

    proto.availability = function () {
      const rows = [];
      for (const item of Object.values(this.items)) {
        if (item.status === 'archived') continue;
        let onHand = 0;
        let allocated = 0;
        let held = 0;
        for (const p of Object.values(this.pallets)) {
          if (p.itemNo !== item.itemNo || p.status === 'shipped' || !p.loc) continue;
          onHand += p.qty;
          if (p.orderId) allocated += p.qty;
          if (p.status === 'blocked' || p.qualityHold || p.quarantine) held += p.qty;
        }
        for (const h of Object.values(this.holders || {})) {
          if (h.status === 'retired' || h.cartonStatus || (h.sscc && this.pallets[h.sscc])) continue;
          const place = h.loc && this.locations[h.loc];
          const blocked = place && (place.role === 'quarantine' || place.role === 'return' || place.quarantine);
          for (const c of h.contents || []) {
            if (c.itemNo !== item.itemNo) continue;
            const q = Number(c.qty) || 0;
            onHand += q;
            if (blocked) held += q;
          }
        }
        if (typeof this._binTotals === 'function') {
          const loose = this._binTotals(item.itemNo);
          onHand += loose.onHand;
          held += loose.held;
        }
        let reserved = 0;
        for (const order of Object.values(this.orders)) {
          if (order.status === 'shipped') continue;
          for (const line of order.lines) if (line.kind === 'each' && line.itemNo === item.itemNo) reserved += Math.max(0, line.units - (line.picked || 0));
        }
        const available = Math.max(0, onHand - allocated - held - reserved);
        rows.push({
          itemNo: item.itemNo, name: item.name, sku: item.itemNo, onHand, allocated, held, reserved, available,
          reorderPoint: item.reorderPoint == null ? null : item.reorderPoint,
          low: item.reorderPoint != null && onHand <= item.reorderPoint,
        });
      }
      return rows.sort((a, b) => (a.itemNo < b.itemNo ? -1 : 1));
    };

    proto.lowStock = function () {
      return this.availability().filter((r) => r.low);
    };

    proto.billingReport = function ({ clientId = null } = {}) {
      const day = 86400000;
      const now = this.now();
      const wanted = clientId ? String(clientId).toUpperCase() : null;
      return Object.values(this.clients || {}).filter((c) => !wanted || c.id === wanted).map((client) => {
        let palletDays = 0;
        for (const p of Object.values(this.pallets)) {
          const owner = p.clientId || (this.items[p.itemNo] && this.items[p.itemNo].clientId);
          if (owner !== client.id || !p.receivedAt) continue;
          let end = now;
          if (p.status === 'shipped') {
            const move = (this.movements || []).find((m) => m.sscc === p.sscc && (m.event === 'shipped' || m.event === 'transferred'));
            end = move ? move.t : p.receivedAt;
          }
          palletDays += Math.max(0, (end - p.receivedAt) / day);
        }
        const moves = (this.movements || []).filter((m) => {
          if (!['moved', 'picked', 'consolidated', 'shipped', 'received', 'packed', 'transferred'].includes(m.event)) return false;
          const pallet = m.sscc && this.pallets[m.sscc];
          const holder = m.holder && this.holders[m.holder];
          const owner = (pallet && (pallet.clientId || (this.items[pallet.itemNo] && this.items[pallet.itemNo].clientId))) || (holder && holder.clientId);
          return owner === client.id;
        }).length;
        const storageRate = Number(client.storageRate) || 0;
        const handlingRate = Number(client.handlingRate) || 0;
        const storage = Math.round(palletDays * storageRate * 100) / 100;
        const handling = Math.round(moves * handlingRate * 100) / 100;
        return { clientId: client.id, name: client.name, palletDays: Math.round(palletDays * 100) / 100, moves, storageRate, handlingRate, storage, handling, total: Math.round((storage + handling) * 100) / 100 };
      });
    };
  }

  return { install };
});
