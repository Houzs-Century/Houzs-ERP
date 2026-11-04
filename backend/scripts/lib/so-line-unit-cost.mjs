import { pickComboMatch, splitSofaCode, spreadComboTotal } from '../../src/scm/shared/sofa-combo-pricing.ts';

const heightOf = (variants) => variants?.depth ?? variants?.seatHeight ?? variants?.seat_height ?? null;
const clean = (h) => String(h).replace(/"/g, '').trim();

/** The model of a code: 9058-1B(LHF) -> 9058. */
const modelOf = (code) => String(code).split('-')[0];

const mostFirst = (m) => [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], undefined, { numeric: true })).map(([h]) => h);

/** The heights sold, most sold first, by SKU, by model and across all sofas, from
 *  the height counts of the lines that named one: [{ item_code, height, n }]. */
export function usualHeights(rows) {
  const tally = new Map();
  const add = (key, h, n) => {
    const m = tally.get(key) ?? new Map();
    m.set(h, (m.get(h) ?? 0) + n);
    tally.set(key, m);
  };
  for (const r of rows) {
    if (r.height == null || clean(r.height) === '') continue;
    const n = Number(r.n) || 0;
    add(`sku:${r.item_code}`, clean(r.height), n);
    add(`model:${modelOf(r.item_code)}`, clean(r.height), n);
    add('all', clean(r.height), n);
  }
  return new Map([...tally].map(([k, m]) => [k, mostFirst(m)]));
}

const gridOf = (p) => (Array.isArray(p?.seat_height_prices) ? p.seat_height_prices : [])
  .filter((e) => (e.tier ?? 'PRICE_2') === 'PRICE_2' && Number(e.priceSen) > 0);

/** The height a sofa line costs at: the one it names, else the one this SKU, then
 *  its model, then all sofas sell at most (owner 2026-11-04: with nothing chosen,
 *  cost it as the usual variant), else the first the grid holds. Null when the
 *  line names a height the grid lacks, or the grid is empty. */
export function costHeight(p, variants, usual) {
  const grid = gridOf(p);
  if (grid.length === 0) return null;
  const has = (h) => grid.some((e) => String(e.height) === h);
  const named = heightOf(variants);
  if (named != null) return has(clean(named)) ? clean(named) : null;
  const tried = [...(usual.get(`sku:${p.code}`) ?? []), ...(usual.get(`model:${modelOf(p.code)}`) ?? []), ...(usual.get('all') ?? [])];
  return tried.find(has) ?? String(grid[0].height);
}

/** The product cost for one sales order line, current (not as-of). SOFA reads the
 *  seat grid PRICE_2 cost at costHeight; everything else the flat cost lane. Colour
 *  never moves a cost, so height is the only variant read. */
export function unitCostSen(p, variants, usual) {
  if (!p) return 0;
  if (String(p.category || '').toUpperCase() === 'SOFA') {
    const h = costHeight(p, variants, usual);
    const hit = gridOf(p).find((e) => String(e.height) === h);
    if (hit) return Number(hit.priceSen);
  }
  return Number(p.base_price_sen) || Number(p.cost_price_sen) || 0;
}

/**
 * A set priced as a combo costs the combo, as saving the order does: lines of one
 * model, one height, one tier and one qty that match the model's combo share its
 * cost, in proportion to their piece costs. Mixed qtys keep the piece costs.
 * `lines`: { id, itemCode, qty, tier, height, lineCostSen } of the sofa lines being
 * stamped. Returns line id -> new line cost for the lines a combo covers.
 */
export function comboLineCosts(lines, combos) {
  const out = new Map();
  const groups = new Map();
  for (const l of lines) {
    const { baseModel, sizeCode } = splitSofaCode(l.itemCode);
    if (!sizeCode) continue;
    const key = baseModel.toUpperCase();
    groups.set(key, [...(groups.get(key) ?? []), { ...l, sizeCode }]);
  }
  for (const [model, members] of groups) {
    const tiers = new Set(members.map((m) => m.tier));
    const heights = new Set(members.map((m) => m.height));
    if (tiers.size !== 1 || heights.size !== 1 || !members[0].height) continue;
    const pool = combos.filter((c) => (c.baseModel ?? '').toUpperCase() === model);
    if (pool.length === 0) continue;
    const match = pickComboMatch({ baseModel: '', modules: members.map((m) => m.sizeCode), customerId: null, tier: members[0].tier, height: members[0].height }, pool);
    if (!match) continue;
    const matched = match.matchedIndices.map((i) => members[i]).filter(Boolean);
    const qtys = new Set(matched.map((m) => Math.max(1, m.qty || 1)));
    if (matched.length === 0 || qtys.size !== 1) continue;
    const total = match.comboPriceSen * [...qtys][0];
    if (total <= 0) continue;
    const spread = spreadComboTotal(matched.map((m) => m.lineCostSen), total);
    matched.forEach((m, i) => out.set(m.id, spread[i] ?? 0));
  }
  return out;
}
