
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
  flags: ItemKpiFlag[];
  flagLabel: Map<string, string>;
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
  if (flagsRes.error) throw new Error(`kpi_flags_failed: ${flagsRes.error.message}`);
  const flagRows = flagsRes.data ?? [];
  const flags: ItemKpiFlag[] = flagRows.map((f: any) => ({ flagType: f.flag_type, ref: f.ref, bonusSen: f.bonus_sen }));
  if (flags.length === 0) return EMPTY;
  const flagLabel = new Map<string, string>(
    flagRows.map((f: any) => [`${f.flag_type}:${f.ref}`, (f.label as string) ?? f.ref]),
  );
  const hasFabricFlag = flags.some((f) => f.flagType === 'fabric');
  const hasCategoryFlag = flags.some((f) => f.flagType === 'category');

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

  const fabricFlagRefs = new Set(flags.filter((f) => f.flagType === 'fabric').map((f) => f.ref));
  const fabricFlaggedLines = lines.filter((l) => {
    const fid = fabricIdOf(l.variants);
    return !!fid && fabricFlagRefs.has(fid);
  });
  const uniqNonEmpty = (xs: string[]) => [...new Set(xs.map((x) => (x ?? '').trim()).filter(Boolean))];
  const productByCode = new Map<string, ProductLite>();
  const tiersByFabricId = new Map<string, TierLite>();
  const addonConfig = hasFabricFlag ? await loadFabricTierAddonConfig(sb, companyId) : null;
  const modelOverrides = hasFabricFlag ? await loadModelFabricTierOverrides(sb) : new Map<string, FabricTierModelOverride>();
  const compartmentOverrides = hasFabricFlag ? await loadCompartmentFabricTierOverrides(sb) : new Map<string, FabricTierModelOverride>();
  if (hasCategoryFlag) {
    for (const b of chunk(uniqNonEmpty(lines.map((l) => l.item_code)), 200))
      for (const [k, v] of await loadProductsByCodes(sb, b, companyId)) productByCode.set(k, v as ProductLite);
  }
  if (hasFabricFlag) {
    for (const b of chunk(uniqNonEmpty(fabricFlaggedLines.map((l) => l.item_code)), 200))
      for (const [k, v] of await loadProductsByCodes(sb, b, companyId)) productByCode.set(k, v as ProductLite);
    for (const b of chunk(uniqNonEmpty(fabricFlaggedLines.map((l) => fabricIdOf(l.variants) ?? '')), 200))
      for (const [k, v] of await loadFabricSellingTiersByIds(sb, b)) tiersByFabricId.set(k, v);
  }
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

  const fabricAddonUnitSenOf = (l: LineRow): number => {
    if (!hasFabricFlag || !addonConfig) return 0;
    const fid = fabricIdOf(l.variants);
    if (!fid || !fabricFlagRefs.has(fid)) return 0;
    const product = productByCode.get(norm(l.item_code));
    let cat = norm(product?.category).toUpperCase();
    if (cat !== 'SOFA' && cat !== 'BEDFRAME') {
      const g = norm(l.item_group).toLowerCase();
      cat = g.includes('sofa') ? 'SOFA' : g.includes('bedframe') ? 'BEDFRAME' : '';
    }
    if (cat !== 'SOFA' && cat !== 'BEDFRAME') return 0;
    const category: FabricAddonCategory = cat;
    const tiers = tiersByFabricId.get(fid);
    const tier = category === 'SOFA' ? tiers?.sofaTier : tiers?.bedframeTier;
    const baseOverride = product?.model_id ? (modelOverrides.get(product.model_id) ?? null) : null;
    const bk = norm((l.variants ?? {}).buildKey);
    const buildCompartments = category === 'SOFA' && bk
      ? (compartmentsByBuild.get(`${l.doc_no}::${bk}`) ?? [])
      : [];
    const override = resolveFabricTierOverride(buildCompartments, baseOverride, compartmentOverrides);
    return fabricTierAddon(category, tier ?? null, addonConfig, override) * 100;
  };

  const categoryOf = (l: LineRow): string | null => {
    if (!hasCategoryFlag) return null;
    const cat = norm(productByCode.get(norm(l.item_code))?.category).toUpperCase();
    return cat || null;
  };

  const unitsByDoc = new Map<string, KpiUnit[]>();
  const buildIndex = new Map<string, KpiUnit>();
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
    existing.itemCodes.push(...unit.itemCodes);
    existing.category = existing.category ?? unit.category;
    existing.lineTotalSen += unit.lineTotalSen;
    existing.fabricAddonUnitSen = Math.max(existing.fabricAddonUnitSen, unit.fabricAddonUnitSen);
    existing.specialSurchargeUnitSen = Math.max(existing.specialSurchargeUnitSen, unit.specialSurchargeUnitSen);
  }

  return { flags, flagLabel, unitsByDoc };
}
