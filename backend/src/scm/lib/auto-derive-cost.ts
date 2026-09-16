// ─────────────────────────────────────────────────────────────────────────
// auto-derive-cost.ts — the recompute hook (auto-derive stage 2b).
//
// When a supplier's price/binding for a SKU changes, recompute that ONE SKU's
// derived cost (whole-set max supplier, `deriveProductCostFromSuppliers`) and
// write it onto mfg_products. This REPLACES the near-unused is_cost_anchor
// mirror (1 SKU in production): the suppliers are the source, the product cost
// is derived from them.
//
// GATED, INERT BY DEFAULT. `autoDeriveEnabled` reads an app_config flag that
// defaults OFF (row absent = off), mirroring write-freeze. While OFF the routes
// keep today's behaviour exactly (the old is_cost_anchor mirror); only when the
// owner turns it ON does the recompute drive the product cost. A read failure
// fails CLOSED (returns false) so a blip cannot silently flip the mechanism.
//
// PERFORMANCE. The recompute is per-SKU: one product read + one binding read
// (indexed by idx_smb_material on (material_kind, item_code)) + one product
// update. No catalogue scan, and it runs only on a supplier-price WRITE — the
// read paths (Products list, Sales Report, SO form) are unchanged column reads.
//
// BACKEND-ONLY. Nothing here touches the frontend; the product cost column the
// UI already reads is simply kept fresh by the backend.
// ─────────────────────────────────────────────────────────────────────────

import {
  deriveProductCostFromSuppliers,
  type DerivedProductCost,
  type SupplierBindingCost,
} from './derive-product-cost-from-suppliers';
import { readMfgProductBindings } from './supplier-bindings';

/** app_config key holding the on/off switch. Row absent / any non-on value =
 *  OFF (today's behaviour). */
export const AUTO_DERIVE_FLAG_KEY = 'scm.auto_derive_product_cost';

// The SCM routes carry an untyped supabase-js client.
type Sb = { from: (t: string) => any }; // eslint-disable-line @typescript-eslint/no-explicit-any

/**
 * Is the auto-derive mechanism switched on? Reads the app_config flag; a missing
 * row or any value other than on/1/true is OFF. Fails CLOSED on a read error, so
 * a database blip leaves the routes on their existing (is_cost_anchor) path
 * rather than silently switching mechanism mid-outage.
 */
export async function autoDeriveEnabled(sb: Sb): Promise<boolean> {
  try {
    const { data, error } = await sb
      .from('app_config')
      .select('value')
      .eq('key', AUTO_DERIVE_FLAG_KEY)
      .maybeSingle();
    if (error) return false;
    const v = String((data as { value?: unknown } | null)?.value ?? '')
      .trim()
      .toLowerCase();
    return v === 'on' || v === '1' || v === 'true';
  } catch {
    return false;
  }
}

/** The I/O this recompute needs, as a seam so the orchestrator can be unit
 *  tested without a database. `makeSupabaseDerivedCostIO` is the real one. */
export type DerivedCostIO = {
  loadProduct(companyId: number | null | undefined, code: string): Promise<{ id: string; category: string | null } | null>;
  loadBindings(companyId: number | null | undefined, code: string): Promise<SupplierBindingCost[]>;
  writeProductCost(productId: string, patch: DerivedProductCost): Promise<void>;
};

export type RecomputeResult = {
  written: boolean;
  reason?: string;
  chosenSupplierId?: string;
};

/**
 * Recompute one SKU's derived product cost from its suppliers and write it.
 *
 * Does NOT write, and says why, when:
 *   · the product does not exist (`product_not_found`);
 *   · the SKU has no supplier binding (`no_supplier_binding`) — the binding-gap
 *     the stage-1 report surfaces; the existing cost is left untouched, never
 *     blanked;
 *   · every supplier binding is zero-priced (`all_zero_priced`) — a real cost is
 *     not clobbered with a 0 (a zero-priced pseudo-binding means "price keyed at
 *     PI time").
 *
 * Pure of the flag decision and of best-effort error handling — the caller
 * (`recomputeDerivedProductCostSafe`) owns those. This shape is what the tests
 * drive with a fake IO.
 */
export async function recomputeDerivedProductCost(
  io: DerivedCostIO,
  companyId: number | null | undefined,
  code: string,
): Promise<RecomputeResult> {
  const product = await io.loadProduct(companyId, code);
  if (!product) return { written: false, reason: 'product_not_found' };

  const bindings = await io.loadBindings(companyId, code);
  const derived = deriveProductCostFromSuppliers(product.category, bindings);
  if (derived.skipped) return { written: false, reason: derived.reason };
  if (derived.dearnessSen === 0) return { written: false, reason: 'all_zero_priced' };

  await io.writeProductCost(product.id, derived.patch);
  return { written: true, chosenSupplierId: derived.chosenSupplierId };
}

/** The real IO over a supabase-js client. */
export function makeSupabaseDerivedCostIO(sb: Sb): DerivedCostIO {
  return {
    async loadProduct(companyId, code) {
      let q = sb.from('mfg_products').select('id, category').eq('code', code);
      if (companyId != null) q = q.eq('company_id', companyId);
      const { data } = await q.maybeSingle();
      return (data as { id: string; category: string | null } | null) ?? null;
    },
    async loadBindings(companyId, code) {
      const { data, error } = await readMfgProductBindings<{
        item_code: string;
        supplier_id: string;
        is_main_supplier: boolean | null;
        unit_price_sen: number | null;
        price_matrix: unknown;
      }>(sb, {
        codes: [code],
        companyId,
        select: 'item_code, supplier_id, is_main_supplier, unit_price_sen, price_matrix',
      });
      if (error) throw new Error(`binding read failed for ${code}: ${error.message}`);
      return data
        .filter((r) => r.item_code === code)
        .map((r) => ({
          supplier_id: r.supplier_id,
          is_main_supplier: r.is_main_supplier,
          unit_price_sen: r.unit_price_sen,
          price_matrix: r.price_matrix,
        }));
    },
    async writeProductCost(productId, patch) {
      const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if ('base_price_sen' in patch) update.base_price_sen = patch.base_price_sen ?? null;
      if ('price1_sen' in patch) update.price1_sen = patch.price1_sen ?? null;
      if (patch.seat_height_prices !== undefined) update.seat_height_prices = patch.seat_height_prices;
      // Keyed by the product's own id (PK) — the loadProduct read already scoped
      // to the active company, so the id belongs to this company.
      await sb.from('mfg_products').update(update).eq('id', productId);
    },
  };
}

/**
 * Best-effort recompute for the ON path of a route. Assumes the caller has
 * already checked `autoDeriveEnabled`. Never throws — a recompute failure must
 * not fail the supplier-price write that triggered it (the binding is the
 * source of truth; a stale projection is repaired by the next write or the
 * backfill), exactly as the is_cost_anchor mirror it replaces was best-effort.
 */
export async function recomputeDerivedProductCostSafe(
  sb: Sb,
  companyId: number | null | undefined,
  code: string,
): Promise<void> {
  try {
    await recomputeDerivedProductCost(makeSupabaseDerivedCostIO(sb), companyId, code);
  } catch (e) {
    console.error(`[auto-derive] recompute failed for ${code}:`, e instanceof Error ? e.message : e);
  }
}
