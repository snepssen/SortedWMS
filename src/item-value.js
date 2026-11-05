/*
 * Item value, in the warehouse currency. ABC classification by value and the
 * stock-value report both read item.value. The amount is hidden from a role
 * without items.value while high-value plates are on.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SortedItemValue = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function money(value, label = 'Value') {
    if (value == null || value === '') return null;
    const n = typeof value === 'number' ? value : Number(String(value).trim().replace(/\s/g, '').replace(',', '.'));
    if (!Number.isFinite(n) || n < 0) throw new Error(`${label} is a number of 0 or more`);
    if (n > 1e12) throw new Error(`${label} is too large`);
    return Math.round(n * 10000) / 10000;
  }

  function currencyCode(code) {
    const c = String(code || '').trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(c)) throw new Error('Currency is a three-letter code, such as EUR');
    try {
      new Intl.NumberFormat('en', { style: 'currency', currency: c }).format(0);
    } catch (e) {
      throw new Error(`Unknown currency ${c}`);
    }
    return c;
  }

  function install(Warehouse) {
    const proto = Warehouse.prototype;

    proto.currency = function () {
      return (this.config && this.config.currency) || 'EUR';
    };

    proto.setCurrency = function (code) {
      if (typeof this.module === 'function' && !this.module('item-value')) throw new Error('Item value is switched off');
      const currency = currencyCode(code);
      this.setConfig({ currency });
      this.log(`Warehouse currency set to ${currency} by ${this._actor || 'unknown'}`);
      return { currency };
    };

    proto.stockValueReport = function ({ client = null } = {}) {
      if (typeof this.module === 'function' && !this.module('item-value')) throw new Error('Item value is switched off');
      const currency = this.currency();
      const wanted = client ? String(client).trim().toUpperCase() : '';
      const rows = [];
      const push = (location, itemNo, qty, clientId) => {
        const n = Number(qty) || 0;
        if (!n) return;
        const item = this.items[itemNo] || {};
        const owner = clientId || item.clientId || '';
        if (wanted && owner !== wanted) return;
        const unit = item.value == null ? null : Number(item.value);
        const line = unit == null ? 0 : Math.round(n * unit * 100) / 100;
        rows.push({
          client: owner,
          itemNo,
          name: item.name || '',
          location,
          qty: n,
          unitValue: unit,
          value: line,
          currency,
        });
      };
      for (const pallet of Object.values(this.pallets || {})) {
        if (!pallet.loc || pallet.status === 'shipped' || !pallet.qty) continue;
        push(pallet.loc, pallet.itemNo, pallet.qty, pallet.clientId);
      }
      for (const [code, lines] of Object.entries(this.binStock || {})) {
        for (const line of lines || []) push(code, line.itemNo, line.qty, line.clientId);
      }
      rows.sort((a, b) => (a.client < b.client ? -1 : a.client > b.client ? 1 : 0) || (a.itemNo < b.itemNo ? -1 : 1) || (a.location < b.location ? -1 : 1));
      const total = Math.round(rows.reduce((sum, row) => sum + row.value, 0) * 100) / 100;
      return { currency, total, rows };
    };
  }

  return { install, money, currencyCode };
});
