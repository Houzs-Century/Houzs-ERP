import { planComboCostSpread } from '../../src/scm/lib/sofa-combo-cost-spread.ts';
import { isoDay } from './sofa-combo-set-cost.mjs';

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

/** The height a sofa line costs at: the one it names, or the nearest the grid holds
 *  when it has no price there, the taller on a tie (owner 2026-11-04: 8069 is priced
 *  at 28" and sold at 30"). With none named, the one this SKU, then its model, then
 *  all sofas sell at most, else the first the grid holds. Null on an empty grid. */
export function costHeight(p, variants, usual) {
  const grid = gridOf(p);
  if (grid.length === 0) return null;
  const has = (h) => grid.some((e) => String(e.height) === h);
  const named = heightOf(variants);
  if (named != null) {
    const want = clean(named);
    if (has(want)) return want;
    const away = (e) => Math.abs(Number(e.height) - Number(want));
    const near = grid.filter((e) => Number.isFinite(away(e))).sort((a, b) => away(a) - away(b) || Number(b.height) - Number(a.height))[0];
    return near ? String(near.height) : null;
  }
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
 * Every sofa piece a set price covers on `asOf`, priced as the order's save prices
 * the set (planComboCostSpread: the combo covering the most pieces, at the line's
 * own height and fabric tier), but shared by each piece's own product cost rather
 * than by what the line carries now: a line may carry a whole set price, or RM 0.
 * A cancelled line is no part of the set, as on a save.
 *
 * `lines`: { id, item_code, item_group, variants, qty, own, cancelled } where `own`
 * is the product's unit cost (unitCostSen). `combos`: cost-priced master combos
 * with dates as YYYY-MM-DD (costCombos; the driver hands a date over as a Date).
 * `asOf`: the day whose set prices count, YYYY-MM-DD; null is today.
 * Returns line id -> new line cost for every covered piece.
 */
export function setSpreadByOwnCost(lines, combos, tierOfFabric, asOf) {
  const qtyOf = (l) => Math.max(1, Number(l.qty) || 1);
  const sofa = lines.filter((l) => !l.cancelled && String(l.item_group ?? '').toLowerCase() === 'sofa');
  return planComboCostSpread(sofa.map((l) => ({
    id: l.id, item_code: l.item_code, item_group: 'sofa', variants: l.variants, qty: qtyOf(l),
    line_cost_sen: (Number(l.own) || 0) * qtyOf(l),
  })), combos, tierOfFabric, asOf);
}

/**
 * What an order's sofa sets cost by the owner's rule (2026-11-19): the set price
 * that existed on the order date; with none then, each piece its own cost.
 *   - A set a set price covered on the order date costs it, shared by own cost.
 *   - A set none covered then, whose pieces not at their own price carry, between
 *     them, exactly the set price that came later (a save after it existed spread
 *     it over them), goes back to each piece's own cost: HC-SO-2609-359, opened
 *     2026-09-30, its 26" set price from 2026-10-10, had it on its 1A and the 2A's
 *     own cost on top.
 * Every other set is left to its pieces' own costs as they stand.
 *
 * `lines`: as setSpreadByOwnCost, plus `held`, the unit cost the line carries.
 * `orderDate`: the order's date, YYYY-MM-DD.
 * Returns line id -> line cost for every piece of a set this prices.
 */
export function orderDateSetCosts(lines, combos, tierOfFabric, orderDate) {
  const qtyOf = (l) => Math.max(1, Number(l.qty) || 1);
  const modelKey = (l) => modelOf(l.item_code).toUpperCase();
  const out = setSpreadByOwnCost(lines, combos, tierOfFabric, orderDate);
  const priced = new Set(lines.filter((l) => out.has(l.id)).map(modelKey));
  const later = setSpreadByOwnCost(lines, combos, tierOfFabric, null);
  for (const [model, pieces] of Map.groupBy(lines.filter((l) => later.has(l.id)), modelKey)) {
    if (priced.has(model)) continue;
    const setPrice = pieces.reduce((s, l) => s + later.get(l.id), 0);
    const offOwn = pieces.filter((l) => (Number(l.held) || 0) !== (Number(l.own) || 0));
    const carried = offOwn.reduce((s, l) => s + (Number(l.held) || 0) * qtyOf(l), 0);
    if (setPrice > 0 && offOwn.length > 0 && carried === setPrice) for (const l of pieces) out.set(l.id, (Number(l.own) || 0) * qtyOf(l));
  }
  return out;
}

/**
 * The sofa sets of an order whose piece is about to be stamped, costed by
 * orderDateSetCosts, the pieces already costed included, on every order.
 *
 * Why: stamping each piece with its own cost missed the set price a set had when
 * it was sold (the fill once read a combo's start date as "Mon Oct 19", so no
 * combo was ever in effect), and a piece left at RM 0 beside a sibling carrying a
 * whole set price got costed again on top (HC-SO-2609-359; 2990-SO-2611-107 on
 * the POS). A set price that came after the order date is not the order's cost.
 *
 * `lines`: as orderDateSetCosts. Returns line id -> new line cost for every
 * piece of a set with a piece to stamp; a set with nothing to stamp is never moved.
 */
export function wholeSetCosts(lines, combos, tierOfFabric, orderDate) {
  const out = new Map();
  const modelKey = (l) => modelOf(l.item_code).toUpperCase();
  const wanting = lines.filter((l) => !l.cancelled && String(l.item_group ?? '').toLowerCase() === 'sofa'
    && Number(l.held) === 0 && Number(l.own) > 0);
  if (wanting.length === 0) return out;
  const costs = orderDateSetCosts(lines, combos, tierOfFabric, orderDate);
  const models = new Set(wanting.filter((l) => costs.has(l.id)).map(modelKey));
  for (const l of lines) {
    if (costs.has(l.id) && models.has(modelKey(l))) out.set(l.id, costs.get(l.id));
  }
  return out;
}

/**
 * One named order's sofa sets re-costed by orderDateSetCosts: the pure half of
 * repair-fill-sofa-set-cost.mjs.
 * @param order { doc_no, so_date, status, total_revenue_sen, total_cost_sen, total_margin_sen, mattress_sofa_cost_sen }
 *   The margin moves with the cost (it is revenue - cost on every header) and its
 *   basis is margin / revenue, as a save writes it: 0 on an order imported with no
 *   revenue on its header, never a new figure there.
 * @param lines every line of the order: { id, item_code, item_group, variants, qty, total_sen, line_cost_sen, cancelled }
 * @param ctx   { combos, tierOfFabric(code) -> tier, ownCost(line) -> unit sen }
 * @returns { status: 'refused', why } | { status: 'repair', changes: [{ id, item_code, qty, total_sen, from, to }], header }
 */
export function recostSetOrder(order, lines, ctx) {
  if (['DRAFT', 'CANCELLED'].includes(String(order.status))) return { status: 'refused', why: `the order is ${order.status}` };
  const qtyOf = (l) => Math.max(1, Number(l.qty) || 1);
  const live = lines.filter((l) => !l.cancelled);
  const lineSum = live.reduce((s, l) => s + (Number(l.line_cost_sen) || 0), 0);
  if (lineSum !== Number(order.total_cost_sen)) return { status: 'refused', why: 'its header cost is not the sum of its lines; save the order in the app first' };
  const costs = orderDateSetCosts(live.map((l) => ({ ...l, own: ctx.ownCost(l), held: (Number(l.line_cost_sen) || 0) / qtyOf(l) })),
    ctx.combos, ctx.tierOfFabric, isoDay(order.so_date));
  const changes = live
    .filter((l) => costs.has(l.id) && costs.get(l.id) !== (Number(l.line_cost_sen) || 0))
    .map((l) => ({ id: l.id, item_code: l.item_code, qty: qtyOf(l), total_sen: Number(l.total_sen) || 0, from: Number(l.line_cost_sen) || 0, to: costs.get(l.id) }));
  if (changes.length === 0) return { status: 'refused', why: 'nothing to change: its sofa sets already carry their order-date cost' };
  const delta = changes.reduce((s, c) => s + (c.to - c.from), 0);
  const grand = Number(order.total_revenue_sen) || 0;
  const margin = (Number(order.total_margin_sen) || 0) - delta;
  return {
    status: 'repair',
    changes,
    header: {
      total_cost_sen: Number(order.total_cost_sen) + delta,
      mattress_sofa_cost_sen: (Number(order.mattress_sofa_cost_sen) || 0) + delta,
      total_margin_sen: margin,
      margin_pct_basis: grand > 0 ? Math.round((margin / grand) * 10000) : 0,
    },
  };
}
