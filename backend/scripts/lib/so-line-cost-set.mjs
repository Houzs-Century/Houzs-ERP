/* The pure half of set-so-line-cost.mjs: put named lines of one sales order on
   a cost the owner decided, and move the header with them.

   The header's cost is the sum of its live lines, split into category columns;
   its margin is revenue - cost, and the margin basis is margin / revenue as a
   save writes it (0 on an order with no revenue on its header). */

const CATEGORY_COLUMN = {
  sofa: 'mattress_sofa_cost_sen', mattress: 'mattress_sofa_cost_sen', bedframe: 'bedframe_cost_sen',
  accessory: 'accessories_cost_sen', accessories: 'accessories_cost_sen', service: 'service_cost_sen',
};

/** The header column a line's cost belongs to. */
export const costColumnOf = (itemGroup) => CATEGORY_COLUMN[String(itemGroup ?? '').toLowerCase()] ?? 'others_cost_sen';

/** "id:sen,id:sen" -> Map id -> sen. Throws on anything else. */
export function parseLineCosts(text) {
  const out = new Map();
  for (const part of String(text ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = /^([0-9a-f-]{36}):(\d+)$/i.exec(part);
    if (!m) throw new Error(`LINES entry "${part}" must be <line uuid>:<cost in sen>`);
    if (out.has(m[1])) throw new Error(`LINES names line ${m[1]} twice`);
    out.set(m[1], Number(m[2]));
  }
  if (out.size === 0) throw new Error('LINES must name at least one line');
  return out;
}

/**
 * @param order { doc_no, status, total_cost_sen, total_revenue_sen, total_margin_sen, mattress_sofa_cost_sen, bedframe_cost_sen, accessories_cost_sen, service_cost_sen, others_cost_sen }
 * @param lines every line of the order: { id, item_code, item_group, qty, total_sen, line_cost_sen, cancelled }
 * @param wanted Map line id -> line cost in sen
 * @returns { status: 'refused', why } | { status: 'set', changes: [{ id, item_code, qty, total_sen, from, to }], header }
 */
export function planLineCosts(order, lines, wanted) {
  if (['DRAFT', 'CANCELLED'].includes(String(order.status))) return { status: 'refused', why: `the order is ${order.status}` };
  const live = lines.filter((l) => !l.cancelled);
  const lineSum = live.reduce((s, l) => s + (Number(l.line_cost_sen) || 0), 0);
  if (lineSum !== Number(order.total_cost_sen)) return { status: 'refused', why: 'its header cost is not the sum of its lines; save the order in the app first' };
  for (const id of wanted.keys()) {
    if (!live.some((l) => l.id === id)) return { status: 'refused', why: `line ${id} is not a live line of this order` };
  }
  const changes = live
    .filter((l) => wanted.has(l.id) && wanted.get(l.id) !== (Number(l.line_cost_sen) || 0))
    .map((l) => ({ id: l.id, item_code: l.item_code, item_group: l.item_group, qty: Math.max(1, Number(l.qty) || 1), total_sen: Number(l.total_sen) || 0, from: Number(l.line_cost_sen) || 0, to: wanted.get(l.id) }));
  if (changes.length === 0) return { status: 'refused', why: 'nothing to change: the named lines already carry those costs' };
  const delta = changes.reduce((s, c) => s + (c.to - c.from), 0);
  const columns = {};
  for (const c of changes) {
    const col = costColumnOf(c.item_group);
    columns[col] = (columns[col] ?? (Number(order[col]) || 0)) + (c.to - c.from);
  }
  const revenue = Number(order.total_revenue_sen) || 0;
  const margin = (Number(order.total_margin_sen) || 0) - delta;
  return {
    status: 'set',
    changes,
    header: {
      total_cost_sen: Number(order.total_cost_sen) + delta,
      ...columns,
      total_margin_sen: margin,
      margin_pct_basis: revenue > 0 ? Math.round((margin / revenue) * 10000) : 0,
    },
  };
}
