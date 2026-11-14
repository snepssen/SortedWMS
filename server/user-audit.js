/*
 * One CSV of moves, warehouse commands and sign-in events.
 * Dates are the warehouse's local days. Passwords are left out.
 */
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const SECRET = /password|passphrase|secret|token|pin|badge/i;

function cell(value) {
  return `"${String(value == null ? '' : value).replace(/"/g, '""')}"`;
}

function range(from, to) {
  if (!DAY.test(String(from || '')) || !DAY.test(String(to || ''))) throw new Error('Use dates as YYYY-MM-DD');
  if (from > to) throw new Error('The period ends before it starts');
  return { from, to };
}

function inside(wh, t, span) {
  const day = wh.localDay(Number(t));
  return day >= span.from && day <= span.to;
}

function detail(args) {
  if (!args || typeof args !== 'object') return '';
  const parts = [];
  for (const [key, value] of Object.entries(args)) {
    if (SECRET.test(key) || value == null || value === '') continue;
    const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
    if (text.length > 80) continue;
    parts.push(`${key}=${text}`);
  }
  return parts.join(' ');
}

function build({ store, from, to }) {
  const wh = store.wh;
  const span = range(from, to);
  const lines = [];
  const journal = store.db.prepare("SELECT t, op, args, by FROM journal WHERE op != 'tick' ORDER BY id").all();
  for (const row of journal) {
    if (!inside(wh, row.t, span)) continue;
    let args = {};
    try { args = JSON.parse(row.args || '{}'); } catch (e) { args = {}; }
    lines.push([wh.formatLocal(row.t), row.by || '', 'action', row.op, detail(args)]);
  }
  for (const move of wh.movements || []) {
    if (!inside(wh, move.t, span)) continue;
    const where = [move.from, move.to].filter(Boolean).join(' -> ');
    const bits = [where, move.qty == null ? '' : `qty ${move.qty}`, move.holder || move.sscc || '', move.note || ''].filter(Boolean);
    lines.push([wh.formatLocal(move.t), move.by || '', 'move', move.event || 'moved', bits.join(' ')]);
  }
  let signins = [];
  try { signins = store.db.prepare('SELECT t, action, by, detail FROM auth_audit ORDER BY id').all(); } catch (e) { signins = []; }
  for (const row of signins) {
    if (!inside(wh, row.t, span)) continue;
    lines.push([wh.formatLocal(row.t), row.by || '', 'sign-in', row.action, row.detail || '']);
  }
  lines.sort((a, b) => String(a[0]).localeCompare(String(b[0])) || String(a[2]).localeCompare(String(b[2])) || String(a[3]).localeCompare(String(b[3])));
  const head = ['when', 'user', 'kind', 'what', 'detail'];
  return [head, ...lines].map((row) => row.map(cell).join(',')).join('\n') + '\n';
}

module.exports = { build };
