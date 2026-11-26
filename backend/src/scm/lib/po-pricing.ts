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
import { scopeToCompanyIdOrOpen } from './companyScope';

const todayIso = () => todayMyt();

async function loadConfigForScope(
  sb: any,
  scope: string,
  asOf: string,
  companyId: number | null,
): Promise<MaintenanceConfig | null> {
  // Unscoped, the newest master of ANY company priced another company's PO (HC-0134).
  const { data } = await scopeToCompanyIdOrOpen(
    sb.from('maintenance_config_history').select('config'),
    companyId,
  )
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
  companyId: number | null,
  asOf: string = todayIso(),
): Promise<{ config: MaintenanceConfig | null; scope: 'supplier' | 'master' | null }> {
  if (supplierId) {
    const supplierCfg = await loadConfigForScope(sb, `supplier:${supplierId}`, asOf, companyId);
    if (supplierCfg) return { config: supplierCfg, scope: 'supplier' };
  }
  const masterCfg = await loadConfigForScope(sb, 'master', asOf, companyId);
  if (masterCfg) return { config: masterCfg, scope: 'master' };
  return { config: null, scope: null };
}

/** The variant half of `computeMfgPoUnitCost`'s input — the five spec fields
 *  whose values come off the line's `variants` blob, in ONE place.
 *
 *  IT IS ONE PLACE BECAUSE IT WAS THREE. Every backend caller hand-copied this
 *  object, and each copy silently decided which surcharge pools existed: all
 *  three omitted `totalHeight`, so a PO raised from a Sales Order was costed
 *  with the total-height surcharge at 0 — RM80 short on 2990-PO-2608-003's 18"
 *  CODY-(SS) (SO line cost RM487.50, PO RM407.50), and invisible on every line
 *  at 20"+ where that tier is priced 0. The five FRONTEND callers had always
 *  passed it, which is why a hand-keyed PO priced correctly and only the
 *  converted ones came out short. A shared constructor makes the next added
 *  pool reach all three callers by construction instead of by three people
 *  remembering.
 *
 *  Category gating is preserved exactly as each copy had it: seat size and the
 *  sofa leg pool are SOFA-only, the bedframe leg pool is BEDFRAME-only, and
 *  divan / total height are passed unconditionally (the engine reads them for
 *  BEDFRAME and ignores them elsewhere) — matching what the frontend sends. */
export function poVariantPricingInput(
  category: 'BEDFRAME' | 'SOFA' | 'MATTRESS' | 'ACCESSORY' | 'SERVICE',
  variants: Record<string, unknown>,
): {
  seatSize: string | null; divanHeight: string | null; legHeight: string | null;
  totalHeight: string | null; sofaLegHeight: string | null; specials: string[];
} {
  const str = (k: string): string | null => (variants[k] as string | undefined) ?? null;
  return {
    seatSize:      category === 'SOFA' ? str('seatHeight') : null,
    divanHeight:   str('divanHeight'),
    legHeight:     category === 'BEDFRAME' ? str('legHeight') : null,
    totalHeight:   str('totalHeight'),
    sofaLegHeight: category === 'SOFA' ? str('legHeight') : null,
    specials:      Array.isArray(variants.specials) ? (variants.specials as string[]) : [],
  };
}

export async function deriveMfgPoUnitCost(
  sb: any,
  input: {
    supplierId: string;
    companyId: number | null;
    itemCode: string;
    itemGroup: string | null;
    variants: Record<string, unknown> | null;
  },
): Promise<number> {
  const { data: bindingRow } = await sb
    .from('supplier_material_bindings')
    .select('unit_price_sen, price_matrix')
    .eq('item_code', input.itemCode)
    .eq('material_kind', 'mfg_product')
    .eq('supplier_id', input.supplierId)
    .order('is_main_supplier', { ascending: false })
    .limit(1)
    .maybeSingle();
  const binding = bindingRow as
    | { unit_price_sen?: number | null; price_matrix?: Record<string, unknown> | null }
    | null;
  const flatPriceSen = Number(binding?.unit_price_sen ?? 0);
  const priceMatrix = (binding?.price_matrix ?? null) as PoPriceMatrix;

  const variants = (input.variants ?? {}) as Record<string, unknown>;
  const category = (input.itemGroup?.toUpperCase() ?? '') as
    'BEDFRAME' | 'SOFA' | 'MATTRESS' | 'ACCESSORY' | 'SERVICE' | '';
  if (!category) return flatPriceSen;

  const fabricTier = await resolveFabricTierForLine(sb, input.itemGroup, variants);

  const { config } = await resolveMaintenanceConfigForSupplier(sb, input.supplierId, input.companyId);

  return computeMfgPoUnitCost(
    {
      category,
      priceMatrix,
      unitPriceSen: flatPriceSen,
      fabricTier,
      ...poVariantPricingInput(category, variants),
    },
    config,
  ).unitPriceSen;
}

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
