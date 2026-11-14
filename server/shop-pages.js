'use strict';

/** Follow the pagination advertised by each shop API. */
async function* shopPages({ load, path, rows, mode }) {
  let next = path;
  let page = 1;
  let offset = 0;
  const visited = new Set();
  while (next) {
    if (visited.has(next)) throw new Error('The shop returned a repeated pagination link');
    visited.add(next);
    const { data, headers = {} } = await load(next);
    const items = rows(data);
    yield items;
    if (mode === 'link') {
      const link = String(headers.link || headers.Link || '');
      const match = link.match(/<([^>]+)>\s*;\s*rel="?next"?/);
      next = match ? match[1] : null;
    } else {
      const url = new URL(path, 'https://pagination.invalid');
      if (mode === 'page') {
        const total = Number(headers['x-wp-totalpages'] || headers['X-WP-TotalPages']);
        if (!items.length || (total ? page >= total : items.length < 50)) return;
        url.searchParams.set('page', String(++page));
      } else {
        offset += items.length;
        if (!items.length || (data.count != null ? offset >= Number(data.count) : items.length < 50)) return;
        url.searchParams.set('offset', String(offset));
      }
      next = url.pathname + url.search;
    }
  }
}

module.exports = { shopPages };
