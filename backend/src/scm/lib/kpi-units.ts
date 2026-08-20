// ----------------------------------------------------------------------------
// kpi-units — build the item-KPI "units" for a set of Sales Orders, the single
// source /hr/commission reads its per-salesperson bonus + goods exclusion +
// detail from.
//
// Ported from 2990 apps/api/src/lib/kpi-units.ts. The MATH is untouched (it
// lives in ../shared/hr-commission, byte-identical to 2990's). Only the I/O
// layer is adapted to Houzs — see PORT NOTES below.
//
// An item-KPI-flagged purchase earns a FIXED bonus INSTEAD of % commission on
// the flagged portion (Loo 2026-06-20) — see hr-commission.ts. The "unit" is one
// purchased item: a POS sofa build is split into per-module SO lines that all
// share one fabric, and its fabric-tier Δ is a flat per-build figure spread
// across them, so module lines collapse back into ONE unit by variants.buildKey.
// The Δ a line actually charged is reproduced with the SAME shared
// fabricTierAddon the SO recompute used (incl. per-Model overrides), so this can
// never drift from what was billed (subject to the current-config caveat below).
//
// PORT NOTES (Houzs deltas — each one is a correctness requirement here, not a
// tidy-up; the arithmetic is unchanged):
//
//   1. COMPANY SCOPE. Houzs runs both companies' books in ONE database, so the
//      item-KPI flags and the SO lines are read `.eq('company_id', companyId)`.
//      companyId is REQUIRED, not optional: a commission figure computed against
//      an unknown company is not a figure, it is a guess, and this one is
//      payroll. The caller (routes/hr.ts) refuses before it gets here.
//
//   2. loadFabricTierAddonConfig TAKES A companyId IN HOUZS (2990's does not) —
//      each company has its own Δ config row (2990's is id=100001, not 1).
//      Passing it is what keeps the reported Δ equal to the BILLED Δ; omitting
//      it would silently price one company's sofa with the other's add-on and
//      quietly move real money.
//
//   3. ROW-CAP SAFETY. 2990 chunks the doc list 200-at-a-time but does not page
//      the RESULT. PostgREST caps a response at 1000 rows and drops the rest
//      with NO error — 200 docs can easily exceed 1000 lines, and a dropped line
//      is a silently missing KPI unit (under-paid bonus AND under-excluded
//      goods). chunkIn is the Houzs convention for exactly this and pages each
//      chunk to exhaustion.
//
//   4. FLAG LOAD FAILURES STILL THROW. Kept from 2990 deliberately: "no flags
//      configured" and "the flag read failed" must never collapse into the same
//      empty list, because the empty list silently pays every bonus as RM 0.
// ----------------------------------------------------------------------------

import { type ItemKpiFlag, type KpiUnit } from '../shared/hr-commission';
import {
  fabricTierAddon,
  type FabricAddonCategory,
  type FabricTier,
  type FabricTierModelOverride,
} from '../shared/fabric-tier-addon';
import { resolveFabricTierOverride } from '../shared/fabric-tier-override-resolve';
import {
  loadCompartmentFabricTierOverrides,
  loadFabricSellingTiersByIds,
  loadFabricTierAddonConfig,
  loadModelFabricTierOverrides,
  loadProductsByCodes,
} from './mfg-pricing-recompute';
import { buildCompartmentsFromModuleLines } from './compartments-from-module-lines';
import { chunkIn, paginateAll } from './paginate-all';

const chunk = <T>(arr: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

export interface KpiUnitsResult {
  /** Active item-KPI flags (empty when none configured). */
  flags: ItemKpiFlag[];
  /** `${flag_type}:${ref}` → display label, for the commission detail rollup. */
  flagLabel: Map<string, string>;
  /** doc_no → its KPI units (split-sofa modules already collapsed per build). */
  unitsByDoc: Map<string, KpiUnit[]>;
}

const EMPTY: KpiUnitsResult = { flags: [], flagLabel: new Map(), unitsByDoc: new Map() };

type LineRow = {
  doc_no: string; item_code: string; qty: number; total_sen: number;
  special_order_price_sen: number; item_group: string | null; variants: Record<string, unknown> | null;
};
type ProductLite = { category?: string | null; model_id?: string | null };
type TierLite = { sofaTier: FabricTier | null; bedframeTier: FabricTier | null };

/**
 * Resolve every SO's item-KPI units for ONE company. Returns the active flags +
 * a per-doc unit map; callers roll the units up however they need (bonus,
 * exclusion, detail).
 *
 * Caveat (inherited from 2990, unchanged): the fabric-tier Δ is reproduced with
 * the CURRENT fabric-tier config — exact unless a tier price changes between
 * sale and payout (stable in practice).
 */
export async function loadKpiUnitsByDoc(
  sb: any,
  docNos: string[],
  companyId: number,
): Promise<KpiUnitsResult> {
  const docs = [...new Set(docNos.map((d) => (d ?? '').trim()).filter(Boolean))];
  if (docs.length === 0) return EMPTY;

  const flagsRes = await paginateAll<{ flag_type: string; ref: string; label: string | null; bonus_sen: number }>(
    (from, to) => sb
      .from('hr_item_kpi')
      .select('flag_type, ref, label, bonus_sen')
      .eq('active', true)
      .eq('company_id', companyId)
      .order('id')
      .range(from, to),
  );
  // A failed flag read is NOT "no flags" — see PORT NOTE 4.
  if (flagsRes.error) throw new Error(`kpi_flags_failed: ${flagsRes.error.message}`);
  const flagRows = flagsRes.data ?? [];
  const flags: ItemKpiFlag[] = flagRows.map((f: any) => ({ flagType: f.flag_type, ref: f.ref, bonusSen: f.bonus_sen }));
  if (flags.length === 0) return EMPTY;
  const flagLabel = new Map<string, string>(
    flagRows.map((f: any) => [`${f.flag_type}:${f.ref}`, (f.label as string) ?? f.ref]),
  );
  const hasFabricFlag = flags.some((f) => f.flagType === 'fabric');
  const hasCategoryFlag = flags.some((f) => f.flagType === 'category');

  // 1. gather every non-cancelled line for these docs (paged — PORT NOTE 3).
  const lineRes = await chunkIn<LineRow>(
    docs,
    (batch, from, to) => sb
      .from('mfg_sales_order_items')
      .select('doc_no, item_code, qty, total_sen, special_order_price_sen, item_group, variants')
      .eq('cancelled', false)
      .eq('company_id', companyId)
      .in('doc_no', batch)
      .order('id')
      .range(from, to),
  );
  if (lineRes.error) throw new Error(`kpi_lines_failed: ${lineRes.error.message}`);
  const lines: LineRow[] = lineRes.data;

  const norm = (v: unknown) => String(v ?? '').trim();
  const fabricIdOf = (variants: Record<string, unknown> | null): string | null => norm((variants ?? {}).fabricId) || null;
  const specialsOf = (variants: Record<string, unknown> | null): string[] => {
    const arr = (variants ?? {}).specials;
    return Array.isArray(arr) ? arr.map((s) => norm((s as { code?: unknown })?.code)).filter(Boolean) : [];
  };

  // 2. fabric-tier add-on inputs — only for lines whose fabric is actually
  //    flagged, so the work stays O(flagged lines).
  const fabricFlagRefs = new Set(flags.filter((f) => f.flagType === 'fabric').map((f) => f.ref));
  const fabricFlaggedLines = lines.filter((l) => {
    const fid = fabricIdOf(l.variants);
    return !!fid && fabricFlagRefs.has(fid);
  });
  const uniqNonEmpty = (xs: string[]) => [...new Set(xs.map((x) => (x ?? '').trim()).filter(Boolean))];
  const productByCode = new Map<string, ProductLite>();
  const tiersByFabricId = new Map<string, TierLite>();
  // PORT NOTE 2 — companyId is what makes the reported Δ equal the billed Δ.
  const addonConfig = hasFabricFlag ? await loadFabricTierAddonConfig(sb, companyId) : null;
  const modelOverrides = hasFabricFlag ? await loadModelFabricTierOverrides(sb) : new Map<string, FabricTierModelOverride>();
  // migration 0184 — per-compartment Δ map. A sofa billed a compartment-driven Δ
  // would under-report on model-only resolution, so the reported Δ matches what
  // was billed (keeps the "never drift" promise true).
  const compartmentOverrides = hasFabricFlag ? await loadCompartmentFabricTierOverrides(sb) : new Map<string, FabricTierModelOverride>();
  /* A category flag is matched on mfg_products.category, so EVERY line needs its
     product row — not just the fabric-flagged ones. Loading the whole set is
     gated on a category flag actually existing so a company with none pays
     nothing extra for this. */
  if (hasCategoryFlag) {
    for (const b of chunk(uniqNonEmpty(lines.map((l) => l.item_code)), 200))
      for (const [k, v] of await loadProductsByCodes(sb, b, companyId)) productByCode.set(k, v as ProductLite);
  }
  if (hasFabricFlag) {
    // These two loaders are shared with the SO recompute and MUST be read here
    // with the same call the billing path makes, or the reported Δ diverges from
    // the billed Δ — the one thing this file promises never to do. That used to
    // mean passing no company; since the billing path now scopes (a plain `code`
    // matches both companies' SKU masters — 17 collided on production
    // 2026-08-01), matching it means passing `companyId` HERE TOO. The rule is
    // unchanged: read exactly what billing reads.
    for (const b of chunk(uniqNonEmpty(fabricFlaggedLines.map((l) => l.item_code)), 200))
      for (const [k, v] of await loadProductsByCodes(sb, b, companyId)) productByCode.set(k, v as ProductLite);
    for (const b of chunk(uniqNonEmpty(fabricFlaggedLines.map((l) => fabricIdOf(l.variants) ?? '')), 200))
      for (const [k, v] of await loadFabricSellingTiersByIds(sb, b)) tiersByFabricId.set(k, v);
  }
  // Reconstruct each split sofa build's compartment codes from its module lines'
  // item_code suffix (a persisted split build STRIPS variants.cells). Keyed by
  // `${doc}::${buildKey}` so a build's per-compartment Δ resolves across modules.
  const compartmentsByBuild = new Map<string, string[]>();
  if (hasFabricFlag) {
    const buildGroups = new Map<string, LineRow[]>();
    for (const l of lines) {
      const bk = norm((l.variants ?? {}).buildKey);
      if (!bk) continue;
      const key = `${l.doc_no}::${bk}`;
      const arr = buildGroups.get(key) ?? [];
      arr.push(l); buildGroups.set(key, arr);
    }
    for (const [key, group] of buildGroups) {
      const bk = key.slice(key.indexOf('::') + 2);
      compartmentsByBuild.set(key, buildCompartmentsFromModuleLines(
        group.map((l) => ({ item_code: l.item_code, buildKey: norm((l.variants ?? {}).buildKey) })),
        bk,
      ));
    }
  }

  // The flat fabric-tier Δ a single built item charged (centi). SOFA / BEDFRAME
  // only (the shared fn returns 0 elsewhere); for a sofa the Δ is per BUILD, so
  // every module line reports the SAME figure and the collapse keeps one.
  const fabricAddonUnitSenOf = (l: LineRow): number => {
    if (!hasFabricFlag || !addonConfig) return 0;
    const fid = fabricIdOf(l.variants);
    if (!fid || !fabricFlagRefs.has(fid)) return 0; // unflagged fabric → its Δ stays goods
    const product = productByCode.get(norm(l.item_code));
    let cat = norm(product?.category).toUpperCase();
    if (cat !== 'SOFA' && cat !== 'BEDFRAME') {
      const g = norm(l.item_group).toLowerCase(); // product-lookup miss → fall back to the line group
      cat = g.includes('sofa') ? 'SOFA' : g.includes('bedframe') ? 'BEDFRAME' : '';
    }
    if (cat !== 'SOFA' && cat !== 'BEDFRAME') return 0;
    const category: FabricAddonCategory = cat;
    const tiers = tiersByFabricId.get(fid);
    const tier = category === 'SOFA' ? tiers?.sofaTier : tiers?.bedframeTier;
    const baseOverride = product?.model_id ? (modelOverrides.get(product.model_id) ?? null) : null;
    // Fold the per-Model Δ with any per-compartment Δ matching this build's
    // cells (MAX per tier), exactly as the SO recompute billed — SOFA only
    // (a bedframe has no per-module compartments). Reconstructed from the build.
    const bk = norm((l.variants ?? {}).buildKey);
    const buildCompartments = category === 'SOFA' && bk
      ? (compartmentsByBuild.get(`${l.doc_no}::${bk}`) ?? [])
      : [];
    const override = resolveFabricTierOverride(buildCompartments, baseOverride, compartmentOverrides);
    return fabricTierAddon(category, tier ?? null, addonConfig, override) * 100;
  };

  /* The unit's product category, for `category` item-KPI rules.
     Resolved from mfg_products.category ONLY — the authoritative
     mfg_product_category enum the rule's ref is picked from.

     A product-lookup miss returns NULL and the category rule simply does not
     fire. It deliberately does NOT fall back to the item_group text heuristic
     used for the fabric Δ above: that heuristic answers "is this sofa-ish enough
     to carry a fabric surcharge", which is a safe guess about an add-on already
     on the invoice. Guessing here would INVENT a bonus payment out of a
     free-text field — an unreadable category is an unpaid one, not a paid one. */
  const categoryOf = (l: LineRow): string | null => {
    if (!hasCategoryFlag) return null;
    const cat = norm(productByCode.get(norm(l.item_code))?.category).toUpperCase();
    return cat || null;
  };

  // 3. collapse split-sofa module lines (shared variants.buildKey, same doc)
  //    into ONE unit; every other line is its own unit.
  const unitsByDoc = new Map<string, KpiUnit[]>();
  const buildIndex = new Map<string, KpiUnit>(); // `${doc}::${buildKey}` → the build's unit
  for (const l of lines) {
    const unit: KpiUnit = {
      itemCodes: [norm(l.item_code)],
      qty: Number(l.qty) || 0,
      category: categoryOf(l),
      fabricId: fabricIdOf(l.variants),
      specialCodes: specialsOf(l.variants),
      lineTotalSen: Number(l.total_sen) || 0,
      fabricAddonUnitSen: fabricAddonUnitSenOf(l),
      specialSurchargeUnitSen: Number(l.special_order_price_sen) || 0,
    };
    const arr = unitsByDoc.get(l.doc_no) ?? [];
    if (!unitsByDoc.has(l.doc_no)) unitsByDoc.set(l.doc_no, arr);

    const buildKey = norm((l.variants ?? {}).buildKey);
    if (!buildKey) { arr.push(unit); continue; }
    const key = `${l.doc_no}::${buildKey}`;
    const existing = buildIndex.get(key);
    if (!existing) { buildIndex.set(key, unit); arr.push(unit); continue; }
    // merge a module line into its build's unit.
    existing.itemCodes.push(...unit.itemCodes);
    /* One build is ONE item, so it has ONE category. Keep the first non-null the
       modules resolve to: a split sofa's modules are all SOFA, but an individual
       module's product row can be missing, and letting that null overwrite a
       resolved category would silently stop the build's rule firing. */
    existing.category = existing.category ?? unit.category;
    existing.lineTotalSen += unit.lineTotalSen;            // Σ → whole build's goods
    // fabric Δ + special surcharge are per-BUILD figures on the lead module line;
    // keep the lead's value (max picks it over the 0s), never sum. qty is uniform.
    existing.fabricAddonUnitSen = Math.max(existing.fabricAddonUnitSen, unit.fabricAddonUnitSen);
    existing.specialSurchargeUnitSen = Math.max(existing.specialSurchargeUnitSen, unit.specialSurchargeUnitSen);
  }

  return { flags, flagLabel, unitsByDoc };
}
