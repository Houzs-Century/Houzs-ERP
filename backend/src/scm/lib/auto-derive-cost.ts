
import {
  deriveProductCostFromSuppliers,
  type DerivedProductCost,
  type SupplierBindingCost,
} from './derive-product-cost-from-suppliers';
import { readMfgProductBindings } from './supplier-bindings';
import { todayMyt } from './my-time';

/** app_config key holding the on/off switch. Row absent / any non-on value =
 *  OFF (today's behaviour). */
export const AUTO_DERIVE_FLAG_KEY = 'scm.auto_derive_product_cost';

type Sb = { from: (t: string) => any }; // eslint-disable-line @typescript-eslint/no-explicit-any

/**
 * Is the auto-derive mechanism switched on FOR THIS COMPANY? Reads the
 * app_config flag; a missing row or any value other than on/1/true is OFF.
 * Fails CLOSED on a read error, so a database blip leaves the routes on their
 * existing (is_cost_anchor) path rather than silently switching mechanism
 * mid-outage.
 *
 * ⚠️ SINGLE GLOBAL SWITCH (owner 2026-09-25: both companies must behave the
 * same). scm.app_config's primary key is (key) ALONE, so this flag is one row
 * for the whole database — one switch, both companies. It read PER-COMPANY
 * between 2026-09-20 and 2026-09-25, after a stage-4 GO wrote one row (company
 * 1) with no company predicate on the read and the derive erased 193 of company
 * 2's RETAIL prices. Retail is now defended where it is WRITTEN, not by hiding
 * the switch from company 2: every write path merges through
 * mergeRetailOntoDerivedSeatGrid, and company 2 carries a BEFORE-UPDATE DB
 * trigger (trg_mfg_products_retail_price_lock) that keeps its selling prices no
 * matter what a writer sends. So arming both companies can no longer blank a
 * retail price.
 *
 * companyId stays required and a null/undefined one reads OFF: no company
 * context, no derive.
 */
export async function autoDeriveEnabled(sb: Sb, companyId: number | null | undefined): Promise<boolean> {
  if (companyId == null) return false;
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

type SeatGridSlot = {
  height?: unknown;
  tier?: unknown;
  priceSen?: unknown;
  sellingPriceSen?: unknown;
};

const slotKey = (s: SeatGridSlot): string => `${String(s.height ?? '')}|${String(s.tier ?? 'PRICE_2')}`;
const asSlots = (v: unknown): SeatGridSlot[] =>
  Array.isArray(v) ? (v.filter((x) => x && typeof x === 'object') as SeatGridSlot[]) : [];

/**
 * Lay a freshly derived COST grid over the stored one WITHOUT losing the RETAIL
 * dimension. Pure; exported for the tests.
 *
 * The rule is key presence, per (height, tier) slot — the same rule the company-2
 * database trigger enforces (migration 20260920T1300), so app and database agree
 * by construction rather than by comment:
 *
 *   · derived slot names `sellingPriceSen`  → it wins (this never happens today;
 *                                             the derivation is cost-only)
 *   · derived slot omits it, stored has one → the stored retail price carries
 *   · stored slot absent from derived       → re-appended retail-only, because a
 *                                             cost grid that no longer lists a
 *                                             height is a statement about COST
 *
 * An explicitly stored `null` carries across too: null is "the operator cleared
 * this", which is not the same as "never priced", and only the POS may change it.
 */
export function mergeRetailOntoDerivedSeatGrid(stored: unknown, derived: unknown): SeatGridSlot[] {
  const storedSlots = asSlots(stored);
  const derivedSlots = asSlots(derived);
  const storedByKey = new Map(storedSlots.map((s) => [slotKey(s), s] as const));

  const merged: SeatGridSlot[] = derivedSlots.map((d) => {
    if ('sellingPriceSen' in d) return d;
    const s = storedByKey.get(slotKey(d));
    return s && 'sellingPriceSen' in s ? { ...d, sellingPriceSen: s.sellingPriceSen } : d;
  });

  const derivedKeys = new Set(derivedSlots.map(slotKey));
  for (const s of storedSlots) {
    if (derivedKeys.has(slotKey(s))) continue;
    if (!('sellingPriceSen' in s) || s.sellingPriceSen == null) continue;
    merged.push({ height: s.height, tier: s.tier ?? 'PRICE_2', sellingPriceSen: s.sellingPriceSen });
  }
  return merged;
}

/** The I/O this recompute needs, as a seam so the orchestrator can be unit
 *  tested without a database. `makeSupabaseDerivedCostIO` is the real one. */
export type DerivedCostIO = {
  loadProduct(companyId: number | null | undefined, code: string): Promise<{ id: string; category: string | null } | null>;
  loadBindings(companyId: number | null | undefined, code: string): Promise<SupplierBindingCost[]>;
  writeProductCost(productId: string, patch: DerivedProductCost): Promise<void>;
  latestCostHistory(
    companyId: number | null | undefined,
    code: string,
  ): Promise<{ base_price_sen: number | null; price1_sen: number | null; seat_height_prices: unknown } | null>;
  appendCostHistory(
    companyId: number | null | undefined,
    code: string,
    patch: DerivedProductCost,
    sourceSupplierId: string,
    effectiveFrom: string,
  ): Promise<void>;
};

function costHistoryChanged(
  latest: { base_price_sen: number | null; price1_sen: number | null; seat_height_prices: unknown } | null,
  patch: DerivedProductCost,
): boolean {
  if (!latest) return true;
  const num = (v: number | null | undefined) => (v == null ? null : Number(v));
  if ('base_price_sen' in patch && num(patch.base_price_sen) !== num(latest.base_price_sen)) return true;
  if ('price1_sen' in patch && num(patch.price1_sen) !== num(latest.price1_sen)) return true;
  if (patch.seat_height_prices !== undefined) {
    const key = (rows: unknown) =>
      JSON.stringify(
        (Array.isArray(rows) ? rows : [])
          .map((r: { height?: unknown; tier?: unknown; priceSen?: unknown }) =>
            `${String(r.height ?? '')}|${String(r.tier ?? 'PRICE_2')}|${Number(r.priceSen ?? 0)}`)
          .sort(),
      );
    if (key(patch.seat_height_prices) !== key(latest.seat_height_prices)) return true;
  }
  return false;
}

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

  const latest = await io.latestCostHistory(companyId, code);
  if (costHistoryChanged(latest, derived.patch)) {
    await io.appendCostHistory(companyId, code, derived.patch, derived.chosenSupplierId, todayMyt());
  }
  return { written: true, chosenSupplierId: derived.chosenSupplierId };
}

/** The real IO over a supabase-js client. */
export function makeSupabaseDerivedCostIO(sb: Sb): DerivedCostIO {
  return {
    async loadProduct(companyId, code) {
      let q = sb.from('mfg_products').select('id, category').eq('code', code);
      if (companyId != null) q = q.eq('company_id', companyId);
      const { data, error } = await q.maybeSingle();
      if (error) throw new Error(`product read failed for ${code}: ${error.message}`);
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
      if (patch.seat_height_prices !== undefined) {
        const { data: stored, error } = await sb
          .from('mfg_products')
          .select('seat_height_prices')
          .eq('id', productId)
          .maybeSingle();
        if (error) throw new Error(`seat grid read failed for ${productId}: ${error.message}`);
        update.seat_height_prices = mergeRetailOntoDerivedSeatGrid(
          (stored as { seat_height_prices?: unknown } | null)?.seat_height_prices,
          patch.seat_height_prices,
        );
      }
      await sb.from('mfg_products').update(update).eq('id', productId);
    },
    async latestCostHistory(companyId, code) {
      let q = sb
        .from('mfg_product_cost_history')
        .select('base_price_sen, price1_sen, seat_height_prices')
        .eq('item_code', code);
      if (companyId != null) q = q.eq('company_id', companyId);
      const { data, error } = await q
        .order('effective_from', { ascending: false })
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw new Error(`cost history read failed for ${code}: ${error.message}`);
      return (data as { base_price_sen: number | null; price1_sen: number | null; seat_height_prices: unknown } | null) ?? null;
    },
    async appendCostHistory(companyId, code, patch, sourceSupplierId, effectiveFrom) {
      const { error } = await sb.from('mfg_product_cost_history').insert({
        company_id: companyId,
        item_code: code,
        base_price_sen: 'base_price_sen' in patch ? (patch.base_price_sen ?? null) : null,
        price1_sen: 'price1_sen' in patch ? (patch.price1_sen ?? null) : null,
        seat_height_prices: patch.seat_height_prices ?? null,
        source_supplier_id: sourceSupplierId,
        effective_from: effectiveFrom,
        notes: 'auto-derived (max supplier)',
      });
      if (error) throw new Error(`cost history append failed for ${code}: ${error.message}`);
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

/**
 * Snapshot ONE supplier's price for a SKU into supplier_binding_price_history —
 * the source timeline (stage 3b-supplier: "a supplier price keeps its prior
 * value"). Deduped: appends only when the price differs from the latest row for
 * that (company, supplier, code), so a no-op re-save adds nothing. Best-effort —
 * a failure never blocks the binding write (the flat binding is the source of
 * truth); the read/write errors are bound and thrown internally, then logged.
 */
export async function recordSupplierPriceHistorySafe(
  sb: Sb,
  args: {
    companyId: number | null | undefined;
    supplierId: string;
    itemCode: string;
    unitPriceSen: number | null;
    priceMatrix: unknown;
    isMainSupplier: boolean | null;
    effectiveFrom?: string | null;
  },
): Promise<void> {
  const code = args.itemCode.trim();
  if (!code || !args.supplierId) return;
  const effectiveFrom = (args.effectiveFrom ?? '').trim() || todayMyt();
  try {
    let q = sb
      .from('supplier_binding_price_history')
      .select('unit_price_sen, price_matrix')
      .eq('material_kind', 'mfg_product')
      .eq('item_code', code)
      .eq('supplier_id', args.supplierId)
      .lte('effective_from', effectiveFrom);
    if (args.companyId != null) q = q.eq('company_id', args.companyId);
    const { data: latest, error: readErr } = await q
      .order('effective_from', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (readErr) throw new Error(readErr.message);
    const prev = latest as { unit_price_sen?: number | null; price_matrix?: unknown } | null;
    if (
      prev &&
      Number(prev.unit_price_sen ?? 0) === Number(args.unitPriceSen ?? 0) &&
      JSON.stringify(prev.price_matrix ?? null) === JSON.stringify(args.priceMatrix ?? null)
    ) {
      return;
    }
    const { error: insErr } = await sb.from('supplier_binding_price_history').insert({
      company_id: args.companyId,
      supplier_id: args.supplierId,
      material_kind: 'mfg_product',
      item_code: code,
      unit_price_sen: args.unitPriceSen ?? null,
      price_matrix: args.priceMatrix ?? null,
      is_main_supplier: Boolean(args.isMainSupplier),
      effective_from: effectiveFrom,
      applied_at: new Date().toISOString(),
      notes: 'supplier price snapshot',
    });
    if (insErr) throw new Error(insErr.message);
  } catch (e) {
    console.error(`[auto-derive] supplier price history record failed for ${code}:`, e instanceof Error ? e.message : e);
  }
}
