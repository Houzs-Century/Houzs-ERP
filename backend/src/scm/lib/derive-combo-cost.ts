// ─────────────────────────────────────────────────────────────────────────
// derive-combo-cost.ts — the sofa-combo COST derivation (auto-derive stage 5b,
// owner Option 1: COST-ONLY). Pure: NO db, NO io.
//
// A sofa combo's `prices_by_height` is its COST-by-seat-height grid (the "COST
// BY SEAT HEIGHT" the Edit-combo modal shows; the PO-benchmark cost read by the
// purchase-order path). The MASTER combo (supplier_id NULL) holds that cost plus
// the separate SELLING grid (`selling_prices_by_height`, set on the POS). Owner
// 2026-09-16: the master COST grid auto-derives from the MOST EXPENSIVE supplier
// combo (whole set), exactly like the SKU cost — while the SELLING grid is never
// touched. When no supplier combo exists the master cost is left as-is (a gap the
// owner fills), mirroring "有 supplier 就自动 create, 没有就不 create".
// ─────────────────────────────────────────────────────────────────────────

/** One supplier's combo cost grid for a given scope tuple. */
export type SupplierComboCost = {
  supplier_id: string;
  is_main_supplier?: boolean | null;
  prices_by_height: Record<string, number | null> | null;
};

/** The dearest cell in a cost grid (the ranking scalar — whole set still comes
 *  from ONE supplier, this only decides which). 0 when the grid is empty. */
function dearestCell(grid: Record<string, number | null> | null | undefined): number {
  let max = 0;
  for (const v of Object.values(grid ?? {})) {
    const n = typeof v === 'number' ? v : Number(v);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max;
}

/**
 * The WHOLE `prices_by_height` cost grid of the most-expensive supplier combo,
 * or null when there are no supplier combos. Ties (equal dearest cell) break to
 * the main supplier, then the lexically smaller `supplier_id`, so the choice is
 * deterministic and a stored derived grid cannot flip on a re-run.
 *
 * Whole-set (not per-cell max): the returned grid is exactly one supplier's, so
 * it matches a PO raised at that supplier — never a franken-grid.
 */
export function deriveMasterComboCostFromSuppliers(
  supplierCombos: readonly SupplierComboCost[],
): Record<string, number | null> | null {
  return pickDearestSupplierCombo(supplierCombos)?.prices_by_height ?? null;
}

/**
 * Like `deriveMasterComboCostFromSuppliers`, but also names WHICH supplier the
 * dearest whole-set grid came from — for the Combo Pricing "cost auto-derived,
 * anchored to <supplier>" badge. Same dearest-cell ranking + deterministic
 * tie-break (main supplier, then lexically smaller id). Returns null when there
 * are NO supplier combos (a gap the owner fills in the binding).
 */
export function pickDearestSupplierCombo(
  supplierCombos: readonly SupplierComboCost[],
): { supplierId: string; prices_by_height: Record<string, number | null> } | null {
  if (supplierCombos.length === 0) return null;
  let best = supplierCombos[0];
  let bestDear = dearestCell(best.prices_by_height);
  for (const c of supplierCombos.slice(1)) {
    const d = dearestCell(c.prices_by_height);
    const better =
      d > bestDear ||
      (d === bestDear &&
        ((Boolean(c.is_main_supplier) && !best.is_main_supplier) ||
          (Boolean(c.is_main_supplier) === Boolean(best.is_main_supplier) && c.supplier_id < best.supplier_id)));
    if (better) {
      best = c;
      bestDear = d;
    }
  }
  return { supplierId: best.supplier_id, prices_by_height: best.prices_by_height ?? {} };
}

/** True when two cost grids differ (worth appending a new master row). Compares
 *  the (height -> cost) maps numerically; order-independent. */
export function comboCostChanged(
  current: Record<string, number | null> | null | undefined,
  derived: Record<string, number | null> | null | undefined,
): boolean {
  const norm = (g: Record<string, number | null> | null | undefined) => {
    const m: Record<string, number> = {};
    for (const [k, v] of Object.entries(g ?? {})) m[k] = Number(v ?? 0);
    return JSON.stringify(Object.fromEntries(Object.entries(m).sort(([a], [b]) => (a < b ? -1 : 1))));
  };
  return norm(current) !== norm(derived);
}
