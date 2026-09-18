// ─────────────────────────────────────────────────────────────────────────
// derive-product-cost-from-suppliers.ts — the auto-derive rule (owner
// 2026-09-16). Pure functions only: NO db, NO io.
//
// RULE. The Product Maintenance cost price stops being hand-typed and is
// derived from the supplier side:
//   · one supplier  -> that supplier's cost.
//   · many suppliers -> the MOST EXPENSIVE supplier's cost, taken as a WHOLE
//     SET (owner decision 1: not a per-cell max — the whole matrix comes from
//     the single dearest supplier, so it matches a PO raised at that supplier).
//   · no supplier    -> nothing derivable (a "binding gap"; see the stage-1
//     report). We SKIP rather than write a 0 — a blank source must not silently
//     zero a cost.
//
// This is the REVERSE of the retired cost-anchor mirror: instead of the owner
// typing a product cost and it flowing to one anchored supplier, the suppliers
// are the source and the product cost is derived from them. It is date-UNAWARE
// on purpose (owner: "current most expensive" now; effective-dating is Phase 2,
// deferred) — the caller passes whatever bindings are current.
//
// SHAPE MAPPING reuses the audited `bindingToProductPatch` for FLAT and
// BEDFRAME so the money mapping stays identical to the existing sync. SOFA is
// the one net-new mapping: the retired mirror was product->binding one-way for
// sofa, so there was no binding->product sofa path; here we build the product's
// seat_height_prices COST grid from the chosen supplier's price_matrix (the
// exact inverse of productToBindingPatch's sofa branch).
//
// SCALE: sen throughout (centi === sen). No unit conversion.
// ─────────────────────────────────────────────────────────────────────────

import {
  bindingToProductPatch,
  type AnchorCategory,
  type ProductSeatCost,
} from './cost-anchor-sync';

/** One supplier's cost binding for a single (company, item_code). */
export type SupplierBindingCost = {
  supplier_id: string;
  is_main_supplier: boolean | null;
  unit_price_sen: number | null;
  price_matrix: unknown; // JSONB — {P1,P2} (bedframe) | {h:{P1,P2,P3}} (sofa) | null
};

/** The cost fields this rule writes onto mfg_products. `seat_height_prices` is
 *  present only for SOFA; FLAT/BEDFRAME leave it undefined (not touched). */
export type DerivedProductCost = {
  base_price_sen?: number | null;
  price1_sen?: number | null;
  seat_height_prices?: ProductSeatCost[];
};

export type DeriveResult =
  | { skipped: true; reason: string }
  | {
      skipped: false;
      /** The supplier whose whole set was taken. */
      chosenSupplierId: string;
      /** The dearness scalar the choice ranked on (sen). 0 = every candidate
       *  was zero-priced; the caller decides whether to write a 0 cost. */
      dearnessSen: number;
      patch: DerivedProductCost;
    };

function laneFor(category: AnchorCategory | null): 'FLAT' | 'BEDFRAME' | 'SOFA' {
  const cat = (category ?? '').toUpperCase();
  if (cat === 'SOFA') return 'SOFA';
  if (cat === 'BEDFRAME') return 'BEDFRAME';
  return 'FLAT';
}

function asCent(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

function matrixOf(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** The comparable "dearness" of ONE supplier's binding, per lane — the scalar
 *  that decides which supplier is "most expensive".
 *
 *  ASSUMPTION worth the owner's eye: for the matrix lanes there is no single
 *  natural price, so we rank on the DEAREST cell the supplier quotes (bedframe:
 *  the P2 cost ref, else P1; sofa: the max cell across the whole grid), then the
 *  flat price. Two suppliers still each contribute a whole set — this only
 *  decides which whole set wins. */
function dearnessSen(lane: 'FLAT' | 'BEDFRAME' | 'SOFA', b: SupplierBindingCost): number {
  const flat = asCent(b.unit_price_sen) ?? 0;
  if (lane === 'FLAT') return flat;
  const m = matrixOf(b.price_matrix);
  if (lane === 'BEDFRAME') {
    return asCent(m.P2) ?? asCent(m.P1) ?? flat;
  }
  // SOFA — dearest cell across {height:{P1,P2,P3}}.
  let max = 0;
  let sawCell = false;
  for (const cell of Object.values(m)) {
    for (const v of Object.values(matrixOf(cell))) {
      const c = asCent(v);
      if (c !== null) {
        sawCell = true;
        if (c > max) max = c;
      }
    }
  }
  return sawCell ? max : flat;
}

/** Does this binding carry an actual COST tier — not merely a P1/selling number
 *  or nothing (owner 2026-09-16)?
 *
 *  The rule takes the most-expensive SUPPLIER's price. A binding whose only
 *  price is a non-cost tier (a P1/selling figure, or an empty grid) must NOT be
 *  allowed to win the "most expensive" contest and then anchor the cost as 0 or
 *  null — that is how ARMANI's 9058-L ({"24":{P1:1040500},"30":{P1:110000}},
 *  no P2, flat 0) would otherwise import a 10405 selling number, or a null, as
 *  cost. "Most expensive supplier" therefore means most expensive AMONG the
 *  suppliers that actually quote a cost. This does NOT change the max-cell
 *  ranking for bindings that DO have a cost tier; it only excludes cost-less
 *  bindings from winning.
 *
 *  Per lane the cost is exactly what `bindingToProductPatch` / the sofa mapping
 *  read as cost:
 *   · FLAT     — the flat unit_price IS the cost (no separate selling tier), so a
 *                flat binding always has one; a 0 is handled downstream by the
 *                dearnessSen === 0 guard, not excluded here.
 *   · BEDFRAME — P2, falling back to the flat unit_price. Only-P1 (no P2, no
 *                flat) carries no cost.
 *   · SOFA     — a P2 in ANY seat cell, else the flat fallback. A grid of only
 *                P1/P3 cells with no flat carries no cost. */
function hasCostTier(lane: 'FLAT' | 'BEDFRAME' | 'SOFA', b: SupplierBindingCost): boolean {
  if (lane === 'FLAT') return true;
  const flat = asCent(b.unit_price_sen);
  const m = matrixOf(b.price_matrix);
  if (lane === 'BEDFRAME') return asCent(m.P2) !== null || (flat !== null && flat > 0);
  for (const cell of Object.values(m)) {
    if (asCent(matrixOf(cell).P2) !== null) return true;
  }
  return flat !== null && flat > 0;
}

/** Build the product's SOFA seat_height_prices COST grid from a supplier's
 *  price_matrix {height:{P1,P2,P3}} — the inverse of productToBindingPatch's
 *  sofa branch. */
function sofaSeatRowsFromMatrix(price_matrix: unknown): ProductSeatCost[] {
  const rows: ProductSeatCost[] = [];
  const m = matrixOf(price_matrix);
  for (const [height, cellRaw] of Object.entries(m)) {
    if (!height) continue;
    const cell = matrixOf(cellRaw);
    const p2 = asCent(cell.P2);
    const p1 = asCent(cell.P1);
    const p3 = asCent(cell.P3);
    if (p2 !== null) rows.push({ height, tier: 'PRICE_2', priceSen: p2 });
    if (p1 !== null) rows.push({ height, tier: 'PRICE_1', priceSen: p1 });
    if (p3 !== null) rows.push({ height, tier: 'PRICE_3', priceSen: p3 });
  }
  return rows;
}

/**
 * Derive the product cost from a SKU's supplier bindings, taking the whole set
 * of the single most-expensive supplier.
 *
 * Ties (equal dearness) break deterministically: main supplier first, then the
 * lexically smaller supplier_id — so the same inputs always pick the same
 * supplier and a stored derived value cannot flip on a re-run.
 *
 * Returns `{ skipped }` when there are no bindings (the gap case). It never
 * fabricates a value; a zero-priced winner is reported with `dearnessSen === 0`
 * so the caller can choose not to clobber a real cost with a 0.
 */
export function deriveProductCostFromSuppliers(
  category: AnchorCategory | null,
  bindings: readonly SupplierBindingCost[],
): DeriveResult {
  if (bindings.length === 0) {
    return { skipped: true, reason: 'no_supplier_binding' };
  }
  const lane = laneFor(category);

  // Exclude bindings that carry no cost tier (only a P1/selling number, or an
  // empty grid) so a cost-less binding can never win the "most expensive"
  // contest and anchor a 0/null cost. Ranking among the survivors is unchanged.
  const costed = bindings.filter((x) => hasCostTier(lane, x));
  if (costed.length === 0) {
    return { skipped: true, reason: 'no_supplier_with_cost' };
  }

  const [first, ...rest] = costed;
  let best = first;
  let bestDear = dearnessSen(lane, best);
  for (const cur of rest) {
    const d = dearnessSen(lane, cur);
    // tie-break on equal dearness: main supplier wins, else smaller supplier_id.
    const better =
      d > bestDear ||
      (d === bestDear &&
        ((Boolean(cur.is_main_supplier) && !best.is_main_supplier) ||
          (Boolean(cur.is_main_supplier) === Boolean(best.is_main_supplier) &&
            cur.supplier_id < best.supplier_id)));
    if (better) {
      best = cur;
      bestDear = d;
    }
  }

  if (lane === 'SOFA') {
    const seat = sofaSeatRowsFromMatrix(best.price_matrix);
    const flat = asCent(best.unit_price_sen);
    const patch: DerivedProductCost = { base_price_sen: flat };
    if (seat.length > 0) patch.seat_height_prices = seat;
    return { skipped: false, chosenSupplierId: best.supplier_id, dearnessSen: bestDear, patch };
  }

  // FLAT / BEDFRAME — reuse the audited binding->product mapping unchanged.
  const mapped = bindingToProductPatch({
    category,
    unit_price_sen: best.unit_price_sen,
    price_matrix: best.price_matrix,
  });
  if (mapped.skipped) {
    // Only SOFA is skipped by bindingToProductPatch, and this branch is not
    // SOFA — so this is unreachable. Surface it rather than silently drop.
    return { skipped: true, reason: `unexpected_mapping_skip:${mapped.reason}` };
  }
  return {
    skipped: false,
    chosenSupplierId: best.supplier_id,
    dearnessSen: bestDear,
    patch: mapped.patch,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// DISPLAY resolver — the anchor + state a drawer/list shows (read-only).
//
// This is a THIN wrapper over deriveProductCostFromSuppliers: it does NOT change
// what gets written (auto-derive-cost.ts owns the write path), it only classifies
// the SAME inputs for display so the UI can say "anchored to <supplier>", "took
// highest", or "missing price". Kept in this module so the classification runs on
// the one audited money rule (laneFor / hasCostTier / dearnessSen), not a copy.
// ─────────────────────────────────────────────────────────────────────────

/** The four states the SKU drawer / SKU-master column render:
 *   · ok       — a single supplier, or all costed suppliers agree.
 *   · conflict — >1 costed supplier and they DIFFER; the highest set was taken.
 *   · empty    — no costed supplier (nothing bound, or the price is blank/zero).
 *   · service  — a SERVICE-category SKU; cost is labour/freight, not supplier-derived. */
export type CostAnchorState = 'ok' | 'conflict' | 'empty' | 'service';

export type CostAnchorResult = {
  state: CostAnchorState;
  /** Why the state is 'empty': 'no_supplier_binding' (nothing bound) or
   *  'no_supplier_with_cost' (bound, but no supplier carries a real cost). null
   *  for every other state. Lets the UI pick "add a supplier" vs "fill the price". */
  reason: string | null;
  /** The supplier whose whole set anchors the cost (states ok | conflict), else null. */
  anchorSupplierId: string | null;
  /** The derived headline cost in sen (base_price_sen lane; falls back to the
   *  ranking scalar for a sofa with no flat), or null when not resolvable. Callers
   *  that must not reveal cost null this out — it is the only cost-bearing field. */
  costSen: number | null;
  /** Suppliers that carry a real cost tier — the "N" in "highest full set (N of M)". */
  costedCount: number;
  /** Total supplier bindings for this SKU — the "M". */
  totalCount: number;
};

/**
 * ONE supplier binding's comparable cost scalar (sen), per the SKU's category
 * lane — the same "dearness" the anchor ranks on. Used by the supplier-price
 * History tab to decide whether a supplier RAISED or LOWERED its price between
 * two effective dates, so the direction arrow is computed on the one audited
 * rule rather than a hand-rolled comparison that would disagree with the anchor.
 */
export function comparableCostSen(
  category: AnchorCategory | null,
  binding: Pick<SupplierBindingCost, 'unit_price_sen' | 'price_matrix'>,
): number {
  return dearnessSen(laneFor(category), {
    supplier_id: '',
    is_main_supplier: null,
    unit_price_sen: binding.unit_price_sen,
    price_matrix: binding.price_matrix,
  });
}

/**
 * Classify a SKU's supplier bindings for DISPLAY: which supplier anchors the
 * derived cost and in what state. Runs the exact rule the write path runs
 * (deriveProductCostFromSuppliers), so the drawer can never disagree with the
 * stored derived cost.
 *
 * SERVICE is a display-only carve-out (owner: a service item's cost is
 * labour/freight, not supplier-derived) — it does not change the derivation for a
 * service SKU that happens to carry a binding, only how the drawer labels it.
 */
export function resolveProductCostAnchor(
  category: AnchorCategory | null,
  bindings: readonly SupplierBindingCost[],
): CostAnchorResult {
  const totalCount = bindings.length;
  if ((category ?? '').toUpperCase() === 'SERVICE') {
    return { state: 'service', reason: null, anchorSupplierId: null, costSen: null, costedCount: 0, totalCount };
  }
  const lane = laneFor(category);
  const costed = bindings.filter((x) => hasCostTier(lane, x));
  const costedCount = costed.length;
  if (costedCount === 0) {
    return {
      state: 'empty',
      reason: totalCount === 0 ? 'no_supplier_binding' : 'no_supplier_with_cost',
      anchorSupplierId: null,
      costSen: null,
      costedCount,
      totalCount,
    };
  }
  const derived = deriveProductCostFromSuppliers(category, bindings);
  // A zero-dearness winner is "no real price" — the same condition auto-derive
  // refuses to write (all_zero_priced). Surface it as the missing-price gap, not
  // an anchored RM 0.00.
  if (derived.skipped || derived.dearnessSen === 0) {
    return {
      state: 'empty',
      reason: derived.skipped ? derived.reason : 'no_supplier_with_cost',
      anchorSupplierId: null,
      costSen: null,
      costedCount,
      totalCount,
    };
  }
  const conflict = costedCount > 1 && costed.some((x) => dearnessSen(lane, x) !== derived.dearnessSen);
  return {
    state: conflict ? 'conflict' : 'ok',
    reason: null,
    anchorSupplierId: derived.chosenSupplierId,
    costSen: derived.patch.base_price_sen ?? derived.dearnessSen,
    costedCount,
    totalCount,
  };
}
