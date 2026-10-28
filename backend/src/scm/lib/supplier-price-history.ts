// ----------------------------------------------------------------------------
// Effective-dated resolvers for auto-derive stage 3 (owner 2026-09-16:
// "effective date 也很重要"). Copied from the sell-price resolver shape
// (product-pricing-history.ts): newest effective_from <= asOf, tie-broken by
// created_at. supabase-js only (`sb: any`, like po-pricing.ts).
//
// INERT until wired: with the history tables empty every resolver returns
// null / [] so the caller falls back to the live flat values and pricing is
// byte-identical to today. Company-scoped throughout.
// ----------------------------------------------------------------------------

import { todayMyt } from './my-time';
import type { SupplierBindingCost } from './derive-product-cost-from-suppliers';

/**
 * Each supplier's cost for `code` AS OF `asOf` — the newest
 * supplier_binding_price_history row per supplier with effective_from <= asOf.
 *
 * Returns [] when the code has no history at/under asOf, so the caller falls
 * back to the live scm.supplier_material_bindings rows. The shape matches
 * `SupplierBindingCost`, so the result feeds `deriveProductCostFromSuppliers`
 * directly (stage 3b's as-of recompute).
 */
export async function resolveSupplierPricesAsOf(
  sb: any, // eslint-disable-line @typescript-eslint/no-explicit-any
  companyId: number,
  code: string,
  asOf: string = todayMyt(),
): Promise<SupplierBindingCost[]> {
  const c = code.trim();
  if (!c || !Number.isInteger(companyId) || companyId <= 0) return [];
  const { data, error } = await sb
    .from('supplier_binding_price_history')
    .select('supplier_id, is_main_supplier, unit_price_sen, price_matrix, effective_from, created_at')
    .eq('company_id', companyId)
    .eq('material_kind', 'mfg_product')
    .eq('item_code', c)
    .lte('effective_from', asOf)
    .order('supplier_id', { ascending: true })
    .order('effective_from', { ascending: false })
    .order('created_at', { ascending: false });
  // Bind the error: a failed read must not read as "no history" (which would
  // silently fall back to live prices and hide the failure). Throw — callers
  // are best-effort and log.
  if (error) throw new Error(`supplier price history read failed for ${c}: ${error.message}`);
  const rows = (data as Array<{
    supplier_id: string; is_main_supplier: boolean | null;
    unit_price_sen: number | null; price_matrix: unknown;
  }> | null) ?? [];
  // First row per supplier wins (ordered newest-first within each supplier).
  const seen = new Set<string>();
  const out: SupplierBindingCost[] = [];
  for (const r of rows) {
    if (seen.has(r.supplier_id)) continue;
    seen.add(r.supplier_id);
    out.push({
      supplier_id: r.supplier_id,
      is_main_supplier: r.is_main_supplier,
      unit_price_sen: r.unit_price_sen,
      price_matrix: r.price_matrix,
    });
  }
  return out;
}

/** The derived PRODUCT cost fields to use as of a date, or null when no history
 *  applies (caller then uses the flat mfg_products columns). */
export type AsOfProductCost = {
  base_price_sen: number | null;
  price1_sen: number | null;
  seat_height_prices: unknown | null;
};

/**
 * The derived product cost AS OF `asOf` — the newest mfg_product_cost_history
 * row for (company, code) with effective_from <= asOf. Returns null when none,
 * so the SO recompute (stage 3c) falls back to the flat mfg_products cost. This
 * is the performance-critical read: one indexed single-row lookup, not an
 * aggregate over suppliers.
 */
export async function resolveMfgProductCostAsOf(
  sb: any, // eslint-disable-line @typescript-eslint/no-explicit-any
  companyId: number,
  code: string,
  asOf: string = todayMyt(),
): Promise<AsOfProductCost | null> {
  const c = code.trim();
  if (!c || !Number.isInteger(companyId) || companyId <= 0) return null;
  const { data, error } = await sb
    .from('mfg_product_cost_history')
    .select('base_price_sen, price1_sen, seat_height_prices')
    .eq('company_id', companyId)
    .eq('item_code', c)
    .lte('effective_from', asOf)
    .order('effective_from', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`product cost history read failed for ${c}: ${error.message}`);
  const row = data as AsOfProductCost | null;
  if (!row) return null;
  return {
    base_price_sen: typeof row.base_price_sen === 'number' ? row.base_price_sen : null,
    price1_sen: typeof row.price1_sen === 'number' ? row.price1_sen : null,
    seat_height_prices: row.seat_height_prices ?? null,
  };
}
