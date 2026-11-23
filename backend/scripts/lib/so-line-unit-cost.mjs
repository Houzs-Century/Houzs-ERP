import { combosStandingOn, planComboCostSpread } from '../../src/scm/lib/sofa-combo-cost-spread.ts';
import { isOnePieceSetCombo } from '../../src/scm/shared/sofa-combo-pricing.ts';
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

/** Every master set-price row, deleted ones included, as the matcher reads it.
 *  Supplier and customer rows never cost a set, nor does a one-slot row that
 *  holds a whole set (isOnePieceSetCombo). Dates arrive from the driver as
 *  Date objects; the start date becomes a day, created and deleted stay instants. */
export function masterSetRows(comboRows) {
  const instant = (v) => (v == null ? null : new Date(v).toISOString());
  return comboRows
    .filter((r) => r.supplier_id == null && r.customer_id == null && !isOnePieceSetCombo(r.modules ?? []))
    .map((r) => ({
      id: String(r.id), baseModel: r.base_model, modules: r.modules, tier: r.tier ?? null, customerId: null,
      pricesByHeight: r.prices_by_height ?? {}, label: r.label ?? null,
      effectiveFrom: isoDay(r.effective_from), createdAt: instant(r.created_at) ?? '', deletedAt: instant(r.deleted_at),
    }));
}

/** A product's cost as it stood on `day`: the newest cost-history row in effect
 *  by then (a later save first on a tie), each field the row leaves empty read
 *  from the product as it is now, the rule approved amendments already use
 *  (resolveMfgProductCostAsOf). No row: the product as it is now. */
export function productAsOf(product, history, day) {
  if (!product) return product;
  const row = (history ?? [])
    .filter((h) => isoDay(h.effective_from) <= day)
    .sort((a, b) => isoDay(b.effective_from).localeCompare(isoDay(a.effective_from))
      || new Date(b.created_at ?? 0).getTime() - new Date(a.created_at ?? 0).getTime())[0];
  if (!row) return product;
  return {
    ...product,
    base_price_sen: row.base_price_sen ?? product.base_price_sen,
    price1_sen: row.price1_sen ?? product.price1_sen,
    seat_height_prices: row.seat_height_prices ?? product.seat_height_prices,
  };
}

/** A line's own unit cost on `day` (unitCostSen of productAsOf). A product with
 *  no cost that day takes the cost it has now: the gap the nightly fill was
 *  made to close (owner 2026-09-25) had no earlier price to use. */
export function ownCostOn(product, history, day, variants, usual) {
  return unitCostSen(productAsOf(product, history, day), variants, usual) || unitCostSen(product, variants, usual);
}

/**
 * What an order's sofa sets cost on `day` by the owner's rules (2026-11-19/20):
 *   1. the prices of the order date, set price and piece price alike; a set
 *      price that stood that day counts even if deleted since, one created
 *      later never does;
 *   2. a later change to the product that moved its cost prices the order at
 *      the change day: `day` is then that day.
 * Per base model:
 *   - a set price stood on `day` for the set: the set costs it, shared by each
 *     piece's own cost of that day as a save shares it.
 *   - none did, and the pieces off their own cost carry, between them, exactly
 *     the set price of a row that did not stand on `day` (a later save spread
 *     it over them): each piece of that set back to its own cost of `day`.
 *     HC-SO-2609-359, opened 2026-09-30, carried its 26" set price of
 *     2026-10-10 on its 1A, with the 2A's own cost on top.
 * Either way a set whose pieces are all costed and already add up to that
 * total is left alone: another split of the right total is not worth a write.
 * Everything else stands. A POS order never edited since its sale can carry,
 * by coincidence, the figure of a set price that came later (its pieces were
 * costed from the POS module costs): the repair names its orders after
 * checking each was re-costed after that set price existed.
 *
 * `lines`: { id, item_code, item_group, variants, qty, held, own, cancelled }
 * with `held` the unit cost the line carries and `own` its own unit cost on
 * `day`. `rows`: masterSetRows. Returns line id -> line cost for every piece
 * this re-costs.
 */
export function setCostsOnDay(lines, rows, tierOfFabric, day) {
  const qtyOf = (l) => Math.max(1, Number(l.qty) || 1);
  const modelKey = (l) => modelOf(l.item_code).toUpperCase();
  const sofa = lines.filter((l) => !l.cancelled && String(l.item_group ?? '').toLowerCase() === 'sofa');
  const standingRows = combosStandingOn(rows, day);
  const stood = new Set(standingRows.filter((r) => r.effectiveFrom <= day).map((r) => r.id));
  const standing = setSpreadByOwnCost(sofa, standingRows, tierOfFabric, day);
  const out = new Map();
  const heldOf = (l) => (Number(l.held) || 0) * qtyOf(l);
  // A set already costing the right total, every piece costed, is left as it is.
  // A piece at RM 0 always takes its share: left out, the fill would cost it
  // again on top of a sibling carrying the whole set price.
  const settled = (ps, total) => ps.every((l) => Number(l.held) > 0) && ps.reduce((s, l) => s + heldOf(l), 0) === total;
  for (const [model, pieces] of Map.groupBy(sofa, modelKey)) {
    const covered = pieces.filter((l) => standing.has(l.id));
    if (covered.length > 0) {
      if (!settled(covered, covered.reduce((s, l) => s + standing.get(l.id), 0))) {
        for (const l of covered) out.set(l.id, standing.get(l.id));
      }
      continue;
    }
    const offOwn = pieces.filter((l) => (Number(l.held) || 0) !== (Number(l.own) || 0));
    if (offOwn.length === 0) continue;
    const carried = offOwn.reduce((s, l) => s + heldOf(l), 0);
    for (const r of rows.filter((x) => !stood.has(x.id) && String(x.baseModel ?? '').toUpperCase() === model)) {
      const one = setSpreadByOwnCost(pieces, [{ ...r, deletedAt: null }], tierOfFabric, '9999-12-31');
      const setPrice = [...one.values()].reduce((s, v) => s + v, 0);
      if (setPrice > 0 && carried === setPrice && offOwn.every((l) => one.has(l.id))) {
        const back = pieces.filter((l) => one.has(l.id));
        if (!settled(back, back.reduce((s, l) => s + (Number(l.own) || 0) * qtyOf(l), 0))) {
          for (const l of back) out.set(l.id, (Number(l.own) || 0) * qtyOf(l));
        }
        break;
      }
    }
  }
  return out;
}

/**
 * The lines the order-date set rule may re-cost: every line but the pieces of a
 * sofa set re-costed on a later change day (rule 2, owner 2026-11-23: the set
 * carries `set_cost_day`, backend/src/scm/lib/so-set-change-cost.ts). Such a set
 * keeps the cost of its change day; spreading the order-date set price over it
 * again would undo the change. `lines`: { item_code, item_group, set_cost_day }.
 */
export function linesOutsideChangedSets(lines) {
  const changed = new Set(lines
    .filter((l) => l.set_cost_day && String(l.item_group ?? '').toLowerCase() === 'sofa')
    .map((l) => modelOf(l.item_code).toUpperCase()));
  if (changed.size === 0) return lines;
  return lines.filter((l) => String(l.item_group ?? '').toLowerCase() !== 'sofa' || !changed.has(modelOf(l.item_code).toUpperCase()));
}

/**
 * The sofa sets of an order whose piece is about to be stamped, costed by
 * setCostsOnDay on its order date, the pieces already costed included.
 *
 * Why: stamping each piece with its own cost missed the set price a set had when
 * it was sold (the fill once read a combo's start date as "Mon Oct 19", so no
 * combo was ever in effect), and a piece left at RM 0 beside a sibling carrying a
 * whole set price got costed again on top (HC-SO-2609-359; 2990-SO-2611-107 on
 * the POS). A set price that came after the order date is not the order's cost.
 *
 * `lines`: as setCostsOnDay. Returns line id -> new line cost for every
 * piece of a set with a piece to stamp; a set with nothing to stamp is never moved.
 */
export function wholeSetCosts(lines, rows, tierOfFabric, orderDate) {
  const out = new Map();
  const modelKey = (l) => modelOf(l.item_code).toUpperCase();
  const wanting = lines.filter((l) => !l.cancelled && String(l.item_group ?? '').toLowerCase() === 'sofa'
    && Number(l.held) === 0 && Number(l.own) > 0);
  if (wanting.length === 0) return out;
  const costs = setCostsOnDay(lines, rows, tierOfFabric, orderDate);
  const models = new Set(wanting.filter((l) => costs.has(l.id)).map(modelKey));
  for (const l of lines) {
    if (costs.has(l.id) && models.has(modelKey(l))) out.set(l.id, costs.get(l.id));
  }
  return out;
}

/**
 * One named order's sofa sets re-costed by setCostsOnDay: the pure half of
 * repair-fill-sofa-set-cost.mjs.
 * @param order { doc_no, so_date, status, total_revenue_sen, total_cost_sen, total_margin_sen, mattress_sofa_cost_sen }
 *   The margin moves with the cost (it is revenue - cost on every header) and its
 *   basis is margin / revenue, as a save writes it: 0 on an order imported with no
 *   revenue on its header, never a new figure there.
 * @param lines every line of the order: { id, item_code, item_group, variants, qty, total_sen, line_cost_sen, cancelled }
 * @param ctx   { rows: masterSetRows, tierOfFabric(code) -> tier, ownCost(line, day) -> unit sen }
 * @param day   the day whose prices cost the order: its order date, or the day of
 *   a later change to the product that moved its cost (rule 2)
 * @returns { status: 'refused', why } | { status: 'repair', changes: [{ id, item_code, qty, total_sen, from, to }], header }
 */
export function recostSetOrder(order, lines, ctx, day) {
  if (['DRAFT', 'CANCELLED'].includes(String(order.status))) return { status: 'refused', why: `the order is ${order.status}` };
  const qtyOf = (l) => Math.max(1, Number(l.qty) || 1);
  const live = lines.filter((l) => !l.cancelled);
  const lineSum = live.reduce((s, l) => s + (Number(l.line_cost_sen) || 0), 0);
  if (lineSum !== Number(order.total_cost_sen)) return { status: 'refused', why: 'its header cost is not the sum of its lines; save the order in the app first' };
  const costs = setCostsOnDay(live.map((l) => ({ ...l, own: ctx.ownCost(l, day), held: (Number(l.line_cost_sen) || 0) / qtyOf(l) })),
    ctx.rows, ctx.tierOfFabric, day);
  const changes = live
    .filter((l) => costs.has(l.id) && costs.get(l.id) !== (Number(l.line_cost_sen) || 0))
    .map((l) => ({ id: l.id, item_code: l.item_code, qty: qtyOf(l), total_sen: Number(l.total_sen) || 0, from: Number(l.line_cost_sen) || 0, to: costs.get(l.id) }));
  if (changes.length === 0) return { status: 'refused', why: 'nothing to change: its sofa sets already carry the cost of their day' };
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
