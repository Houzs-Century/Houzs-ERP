/* The pure half of repair-sofa-combo-set-cost.mjs: which sales-order lines
   carry a set price a wrong-shaped combo put on one piece, and what each order
   costs once that price is taken off.

   A wrong-shaped combo is ONE slot listing several codes (isOnePieceSetCombo).
   Before PR "cost a sofa set by the combo that covers it", costing matched it
   to one piece of an order and wrote the whole set's price on that piece,
   while the order's other pieces kept their own cost. The old matcher read
   the combo's selling grid over its cost grid, so the price on the line is
   either figure.

   Taking it off, per polluted line, in this order:
     1. "build sibling": the order was built on the POS and split into pieces
        in proportion to their selling prices. A sibling piece of the same
        build with the same selling price still carries the original share,
        so the polluted piece gets that share back.
     2. "price list": otherwise the piece's own cost in the price list
        (mfg_products.seat_height_prices at its height and fabric tier).
   Then the order is re-priced by the fixed cost spread (planComboCostSpread),
   so a combo that covers the whole set prices it, exactly as the app will on
   the order's next save. Anything the rules cannot decide is REFUSED and
   printed, never guessed. */
import {
  comboChargedPrices, isOnePieceSetCombo, sofaHeightKey, splitSofaCode,
} from '../../src/scm/shared/sofa-combo-pricing.ts';
import { resolveSeatHeightSen } from '../../src/scm/shared/mfg-pricing.ts';
import { planComboCostSpread } from '../../src/scm/lib/sofa-combo-cost-spread.ts';

/** A sibling share further than this from the piece's own list cost is not
 *  trusted: the order is refused for a person to look at. */
export const SIBLING_TOLERANCE = 0.3;

const bmOf = (itemCode) => splitSofaCode(String(itemCode ?? '')).baseModel.toUpperCase();

/** A date or timestamp column as YYYY-MM-DD. postgres.js hands both back as a
 *  Date; String(Date) would read "Tue Jul 27" and break every date compare. */
export const isoDay = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v ?? '').slice(0, 10));
const isSofa = (l) => String(l.item_group ?? '').toLowerCase() === 'sofa';
const qtyOf = (l) => Math.max(1, Number(l.qty) || 1);

/** Every price a wrong-shaped combo could have written on one piece, keyed
 *  `MODEL|height`: its cost and its selling-over-cost figure. */
export function onePieceSetPrices(comboRows) {
  const out = new Map();
  for (const r of comboRows) {
    if (!isOnePieceSetCombo(r.modules ?? [])) continue;
    const charged = comboChargedPrices(r.selling_prices_by_height ?? {}, r.prices_by_height ?? {});
    for (const [grid, prices] of [['cost', r.prices_by_height ?? {}], ['selling', charged]]) {
      for (const [height, sen] of Object.entries(prices)) {
        if (typeof sen !== 'number' || sen <= 0) continue;
        const key = `${String(r.base_model ?? '').toUpperCase()}|${height}`;
        const list = out.get(key) ?? [];
        if (!list.some((p) => p.sen === sen)) list.push({ sen, comboId: r.id, grid });
        out.set(key, list);
      }
    }
  }
  return out;
}

/** The set price this line carries, or null. */
export function setPriceOn(line, setPrices) {
  if (!isSofa(line) || line.cancelled) return null;
  const list = setPrices.get(`${bmOf(line.item_code)}|${sofaHeightKey(line.variants)}`) ?? [];
  return list.find((p) => p.sen * qtyOf(line) === Number(line.line_cost_sen)) ?? null;
}

/** The cost-priced, correctly shaped live master combos, as the app reads them
 *  (loadMasterSofaComboCosts) once the wrong shapes are ignored. */
export function costCombos(comboRows) {
  return comboRows
    .filter((r) => r.supplier_id == null && r.customer_id == null && r.deleted_at == null && !isOnePieceSetCombo(r.modules ?? []))
    .map((r) => ({
      id: r.id, baseModel: r.base_model, modules: r.modules, tier: r.tier, customerId: null,
      pricesByHeight: r.prices_by_height ?? {}, label: r.label ?? null,
      effectiveFrom: isoDay(r.effective_from), createdAt: r.created_at ? new Date(r.created_at).toISOString() : '',
      deletedAt: null,
    }));
}

/**
 * Re-cost one order.
 * @param order    { doc_no, status, local_total_sen, total_cost_sen, total_margin_sen, mattress_sofa_cost_sen }
 * @param lines    the order's lines (all of them; cancelled ones are ignored)
 * @param ctx      { setPrices, combos, listCost(line) -> sen|null, tierOfFabric(code) -> tier, asOf }
 * @returns { status: 'clean' } | { status: 'refused', why } |
 *          { status: 'repair', changes: [{ id, item_code, from, to, how }], header: {...} }
 */
export function repairOrder(order, lines, ctx) {
  const live = lines.filter((l) => !l.cancelled);
  const polluted = new Map();
  for (const l of live) {
    const hit = setPriceOn(l, ctx.setPrices);
    if (hit) polluted.set(l.id, hit);
  }
  if (polluted.size === 0) return { status: 'clean' };

  const lineSum = live.reduce((s, l) => s + Number(l.line_cost_sen || 0), 0);
  if (lineSum !== Number(order.total_cost_sen)) {
    return { status: 'refused', why: `header total_cost_sen=${order.total_cost_sen} is not the sum of its lines_sen=${lineSum}; save the order in the app first` };
  }

  const restored = new Map();
  const how = new Map();
  const unknown = [];
  for (const l of live) {
    if (!polluted.has(l.id)) continue;
    const list = ctx.listCost(l);
    const listLine = list == null ? null : list * qtyOf(l);
    const buildKey = l.variants?.buildKey ?? null;
    const siblings = buildKey == null ? [] : live.filter((s) =>
      s.id !== l.id && isSofa(s) && !polluted.has(s.id) && s.variants?.buildKey === buildKey
      && bmOf(s.item_code) === bmOf(l.item_code)
      && Number(s.unit_price_sen) === Number(l.unit_price_sen) && qtyOf(s) === qtyOf(l));
    if (siblings.length > 0) {
      const share = Math.round(siblings.reduce((s, x) => s + Number(x.line_cost_sen) / qtyOf(x), 0) / siblings.length) * qtyOf(l);
      if (listLine != null && Math.abs(share - listLine) > listLine * SIBLING_TOLERANCE) {
        return { status: 'refused', why: `${l.item_code}: its build sibling's share_sen=${share} is far from its list_cost_sen=${listLine}` };
      }
      restored.set(l.id, share);
      how.set(l.id, 'build sibling');
    } else if (listLine != null && listLine > 0) {
      restored.set(l.id, listLine);
      how.set(l.id, 'price list');
    } else {
      unknown.push(l);
    }
  }
  /* A piece with neither a sibling nor a list cost can still be priced when a
     combo covers its whole set: its figure is then only a weight for the split,
     and the mean of the set's other pieces is the honest one. Whether it was
     covered is checked after the spread; if not, the order is refused. */
  const groupOf = (l) => live.filter((s) => isSofa(s) && bmOf(s.item_code) === bmOf(l.item_code));
  for (const l of unknown) {
    const known = groupOf(l).filter((s) => !unknown.includes(s)).map((s) => restored.get(s.id) ?? Number(s.line_cost_sen || 0));
    restored.set(l.id, known.length ? Math.round(known.reduce((a, b) => a + b, 0) / known.length) : 1);
  }

  const work = live.map((l) => ({
    id: l.id, item_code: l.item_code, item_group: l.item_group, variants: l.variants, qty: Number(l.qty) || 1,
    line_cost_sen: restored.get(l.id) ?? Number(l.line_cost_sen || 0),
  }));
  const spread = planComboCostSpread(work, ctx.combos, ctx.tierOfFabric, ctx.asOf);
  for (const l of unknown) {
    if (!groupOf(l).every((s) => spread.has(s.id))) {
      return { status: 'refused', why: `${l.item_code}: no build sibling, no list cost at height ${sofaHeightKey(l.variants)}, and no combo covers its set` };
    }
  }
  const changes = [];
  for (const l of live) {
    const w = work.find((x) => x.id === l.id);
    const to = spread.get(l.id) ?? w.line_cost_sen;
    const from = Number(l.line_cost_sen || 0);
    if (to === from) continue;
    changes.push({ id: l.id, item_code: l.item_code, qty: qtyOf(l), total_sen: Number(l.total_sen || 0), from, to, how: spread.has(l.id) ? 'set combo' : how.get(l.id) });
  }
  if (changes.length === 0) return { status: 'clean' };
  const delta = changes.reduce((s, c) => s + (c.to - c.from), 0);
  const grand = Number(order.local_total_sen || 0);
  const margin = Number(order.total_margin_sen || 0) - delta;
  return {
    status: 'repair',
    changes,
    header: {
      total_cost_sen: Number(order.total_cost_sen) + delta,
      mattress_sofa_cost_sen: Number(order.mattress_sofa_cost_sen || 0) + delta,
      total_margin_sen: margin,
      margin_pct_basis: grand > 0 ? Math.round((margin / grand) * 10000) : 0,
    },
  };
}

/** A line's own list cost, the way the app's cost engine reads the price list
 *  (resolveSeatHeightSen: exact tier, then PRICE_2, then any costed row). */
export function listCostOf(product, line, tier) {
  const v = line.variants ?? {};
  const size = String(v.depth ?? v.seatHeight ?? '').trim() || null;
  const hit = resolveSeatHeightSen(Array.isArray(product?.seat_height_prices) ? product.seat_height_prices : null, size, tier);
  return hit ? hit.priceSen : null;
}
