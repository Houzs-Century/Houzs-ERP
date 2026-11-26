import {
  deliveryTargetMatchesAnyLine, parseRuleTargets, splitSofaCode, type RuleLineInput,
} from '../shared';
import { scopeToCompanyIdOrOpen } from './companyScope';

/** A persisted SO goods row, as the customer-change redetect path reads it back
 *  from mfg_sales_order_items (joined to its product). */
export interface PersistedGoodsLine {
  itemCode: string;
  category: string | null;
  modelId: string | null;
  sizeCode: string | null;
  buildKey: string | null;
}

/** Reconstruct the RuleLineInput[] the create path feeds the matcher, but from
 *  PERSISTED SO rows (the customer-change redetect path). A POS sofa build is
 *  stored as one row PER module SKU (cells stripped, buildKey kept); we regroup
 *  those by buildKey so a combo's full module set lands on one RuleLineInput.
 *
 *  A sofa module's compartment code comes from its item_code SUFFIX
 *  (`ANNSA-1A(LHF)` → `1A(LHF)`), NOT from size_code — every sofa SKU has
 *  size_code = NULL in prod. size_code is used ONLY for the non-sofa
 *  (mattress/bedframe) variant scope, where that column IS populated. */
export function reconstructDeliveryRuleLines(rows: PersistedGoodsLine[]): RuleLineInput[] {
  const sofaBuilds = new Map<string, { modelId: string | null; modules: string[] }>();
  const out: RuleLineInput[] = [];
  for (const l of rows) {
    const category = String(l.category ?? '');
    const isSofa = category.toUpperCase() === 'SOFA';
    if (isSofa) {
      const compartment = splitSofaCode(l.itemCode).sizeCode;
      const buildKey = String(l.buildKey ?? '');
      if (buildKey) {
        const g = sofaBuilds.get(buildKey) ?? { modelId: l.modelId ?? null, modules: [] };
        if (compartment) g.modules.push(compartment);
        sofaBuilds.set(buildKey, g);
        continue;
      }
      out.push({
        category,
        modelId: l.modelId ?? null,
        sizeCode: null,
        builtCompartments: compartment ? [compartment] : [],
      });
      continue;
    }
    out.push({
      category,
      modelId: l.modelId ?? null,
      sizeCode: l.sizeCode ? String(l.sizeCode).toUpperCase() : null,
      builtCompartments: [],
    });
  }
  for (const g of sofaBuilds.values()) {
    out.push({ category: 'SOFA', modelId: g.modelId, sizeCode: null, builtCompartments: g.modules });
  }
  return out;
}

export async function specialDeliveryFeesForLines(
  sb: any,
  lines: RuleLineInput[],
  comboModulesById: Map<string, string[][]>,
  companyId: number | null | undefined,
): Promise<{ standaloneFee: number; crossCategoryFollowupFee: number }[]> {
  const { data, error } = await scopeToCompanyIdOrOpen(
    sb.from('special_delivery_fee_rules').select('target, standalone_fee, cross_cat_followup_fee'),
    companyId,
  );
  if (error) throw error;
  const out: { standaloneFee: number; crossCategoryFollowupFee: number }[] = [];
  for (const r of (data ?? []) as Array<Record<string, unknown>>) {
    const target = r.target;
    const standalone = Number((r as { standaloneFee?: unknown }).standaloneFee ?? (r as { standalone_fee?: unknown }).standalone_fee ?? 0);
    const crossFollowup = Number((r as { crossCatFollowupFee?: unknown }).crossCatFollowupFee ?? (r as { cross_cat_followup_fee?: unknown }).cross_cat_followup_fee ?? 0);
    if (deliveryTargetMatchesAnyLine(lines, parseRuleTargets(target), comboModulesById)) {
      out.push({
        standaloneFee: standalone * 100,
        crossCategoryFollowupFee: crossFollowup * 100,
      });
    }
  }
  return out;
}
