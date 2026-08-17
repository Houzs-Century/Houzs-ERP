// ----------------------------------------------------------------------------
// PO line pricing — supplier-scoped maintenance config resolver.
//
// Commander 2026-05-27: "我开 PO 的时候, 我的 SKU 那边就会有它的 base price,
// 然后它又有 Maintenance 给我 set 它的价钱, 所以我们开的 PO 全部就会有
// 准的价钱了". The 3 surcharge types (divan / leg / specials) must read
// from the supplier's own maintenance_config_history row when one exists,
// and fall back to the master row when it doesn't.
//
// Read path:
//   1. Try scope = 'supplier:<id>' — newest effective_from <= today, limit 1
//   2. If empty → fall back to scope = 'master'
//   3. If both empty → return null (caller falls back to base price only)
//
// Write path is unchanged — `POST /maintenance-config/changes` already
// accepts any parsed scope (see routes/maintenance-config.ts §parseScope).
//
// ----------------------------------------------------------------------------

import {
  computeMfgPoUnitCost,
  type MaintenanceConfig,
  type MfgFabricTier,
  type PoPriceMatrix,
} from '../shared/mfg-pricing';
import { todayMyt } from './my-time';

const todayIso = () => todayMyt();

/** Internal: load the most-recent config row for a given scope at asOf. */
async function loadConfigForScope(
  sb: any,
  scope: string,
  asOf: string,
): Promise<MaintenanceConfig | null> {
  const { data } = await sb
    .from('maintenance_config_history')
    .select('config')
    .eq('scope', scope)
    .lte('effective_from', asOf)
    .order('effective_from', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  const cfg = (data as { config?: unknown } | null)?.config;
  return (cfg as MaintenanceConfig | null) ?? null;
}

/**
 * Resolve the maintenance config to use for a PO line keyed by supplierId.
 *
 * Returns the supplier's own config when one exists at the asOf date, else
 * the master config. Returns null only when neither exists (commander hasn't
 * seeded the master baseline either).
 *
 * Used by the PO pricing path (both client-side preview and server-side
 * recompute). The shape returned matches what `computeMfgLinePrice` accepts
 * directly — no projection needed.
 */
export async function resolveMaintenanceConfigForSupplier(
  sb: any,
  supplierId: string | null | undefined,
  asOf: string = todayIso(),
): Promise<{ config: MaintenanceConfig | null; scope: 'supplier' | 'master' | null }> {
  if (supplierId) {
    const supplierCfg = await loadConfigForScope(sb, `supplier:${supplierId}`, asOf);
    if (supplierCfg) return { config: supplierCfg, scope: 'supplier' };
  }
  const masterCfg = await loadConfigForScope(sb, 'master', asOf);
  if (masterCfg) return { config: masterCfg, scope: 'master' };
  return { config: null, scope: null };
}

/* ── deriveMfgPoUnitCost ────────────────────────────────────────────────────
   Port of 2990 apps/api/src/lib/po-pricing.ts::deriveMfgPoUnitCost. Shared
   supplier-cost anchor for a SINGLE (supplier, SKU, spec) line — the SAME
   per-line base-cost derivation the "Create PO from SO" path runs in its
   auto-cost pre-pass (mfg-purchase-orders.ts /from-sos, the `baseCostByItem`
   loop): the supplier's own material binding (`price_matrix` P2/P1 cells + flat
   `unit_price_centi` fallback) projected through the fabric tier resolved from
   the line's fabricCode, plus the supplier's maintenance surcharges (divan /
   leg / total height / specials), via the shared pure `computeMfgPoUnitCost`.

   Reused by reviseBoundPo (Approve-PO amendment engine) so a revised bound-PO
   line re-derives its supplier cost from the now-revised SO line's spec instead
   of carrying over the old cost — a fabric/spec swap re-prices the PO cost the
   same way the create path would have.

   Scope note vs the create path: this is the PER-LINE base cost. The create
   path additionally applies SOFA-COMBO redistribution across a whole matched
   module set (spreadComboTotal), which needs the full sibling-line group as
   context; that group-level step is NOT reproduced here (a bound-PO revision is
   a per-line re-derivation), so a sofa SET's combo discount is not re-spread on
   revision — only the per-module matrix/surcharge cost is re-derived.

   Returns the per-unit supplier cost in sen. When the SO line has NO item_group
   (can't project a matrix) it returns the binding's flat `unit_price_centi`,
   mirroring the create path's non-category fallback. When the SKU has no live
   binding for this supplier it returns 0 (the create path's zero-priced
   pseudo-binding — price keyed in at PI time). */
export async function deriveMfgPoUnitCost(
  sb: any,
  input: {
    supplierId: string;
    itemCode: string;
    itemGroup: string | null;
    variants: Record<string, unknown> | null;
  },
): Promise<number> {
  // (1) The supplier's own binding for this SKU (price_matrix + flat fallback).
  const { data: bindingRow } = await sb
    .from('supplier_material_bindings')
    .select('unit_price_centi, price_matrix')
    .eq('material_code', input.itemCode)
    .eq('material_kind', 'mfg_product')
    .eq('supplier_id', input.supplierId)
    .order('is_main_supplier', { ascending: false })
    .limit(1)
    .maybeSingle();
  const binding = bindingRow as
    | { unit_price_centi?: number | null; price_matrix?: Record<string, unknown> | null }
    | null;
  // No live binding for this supplier → zero-priced (mirrors the create path's
  // pseudo-binding; real cost is keyed in at Purchase Invoice time).
  const flatPriceCenti = Number(binding?.unit_price_centi ?? 0);
  const priceMatrix = (binding?.price_matrix ?? null) as PoPriceMatrix;

  const variants = (input.variants ?? {}) as Record<string, unknown>;
  const category = (input.itemGroup?.toUpperCase() ?? '') as
    'BEDFRAME' | 'SOFA' | 'MATTRESS' | 'ACCESSORY' | 'SERVICE' | '';
  // No category on the SO line → can't project a matrix; keep the flat price.
  if (!category) return flatPriceCenti;

  // (2) Fabric tier from the line's fabricCode (sofa vs bedframe column),
  //     mirroring the create path's resolveFabricTier.
  const fabricTier = await resolveFabricTierForLine(sb, input.itemGroup, variants);

  // (3) The supplier's maintenance config (supplier scope → master fallback).
  const { config } = await resolveMaintenanceConfigForSupplier(sb, input.supplierId);

  const specials = Array.isArray(variants.specials) ? (variants.specials as string[]) : [];
  return computeMfgPoUnitCost(
    {
      category,
      priceMatrix,
      unitPriceCenti: flatPriceCenti,
      fabricTier,
      seatSize:      category === 'SOFA' ? ((variants.seatHeight as string | undefined) ?? null) : null,
      divanHeight:   (variants.divanHeight as string | undefined) ?? null,
      legHeight:     category === 'BEDFRAME' ? ((variants.legHeight as string | undefined) ?? null) : null,
      /* TOTAL HEIGHT IS A PRICED POOL, exactly like divan and leg — the engine
         reads it for BEDFRAME out of the supplier's maintenance config. Leaving
         it out handed the engine `undefined`, the lookup returned 0, and the
         surcharge silently vanished: 2990-PO-2608-003's CODY-(SS) at 18" was
         raised at RM407.50 against the SO line's own RM487.50 cost — exactly
         one tier, RM80 — while the same order's 22" line matched, because that
         tier is priced 0 and the omission was invisible on it. Every FRONTEND
         caller has always passed this; all three BACKEND callers did not, which
         is why a hand-keyed PO priced correctly and only server-derived ones
         came out short. Passed unconditionally, as the frontend does; the
         engine ignores it off BEDFRAME. */
      totalHeight:   (variants.totalHeight as string | undefined) ?? null,
      sofaLegHeight: category === 'SOFA' ? ((variants.legHeight as string | undefined) ?? null) : null,
      specials,
    },
    config,
  ).unitPriceSen;
}

/** Resolve the fabric price tier for one line's fabricCode — the single-line
 *  form of the create path's `resolveFabricTier` (sofa vs bedframe column,
 *  falling back to the generic price_tier). Non-sofa/bedframe → null (P2). */
async function resolveFabricTierForLine(
  sb: any,
  category: string | null,
  variants: Record<string, unknown> | null,
): Promise<MfgFabricTier | null> {
  const code = String(variants?.fabricCode ?? '');
  if (!code) return null;
  const cat = (category ?? '').toLowerCase();
  if (cat !== 'sofa' && cat !== 'bedframe') return null;
  const { data } = await sb
    .from('fabric_trackings')
    .select('price_tier, sofa_price_tier, bedframe_price_tier')
    .eq('fabric_code', code)
    .limit(1)
    .maybeSingle();
  const f = data as {
    price_tier?: MfgFabricTier | null;
    sofa_price_tier?: MfgFabricTier | null;
    bedframe_price_tier?: MfgFabricTier | null;
  } | null;
  if (!f) return null;
  if (cat === 'sofa')     return f.sofa_price_tier ?? f.price_tier ?? null;
  return f.bedframe_price_tier ?? f.price_tier ?? null;
}
