// Special delivery fee rules — server-side matcher (migration 0024, #691 RuleTarget).
//
// Generalises the model-only model_special_delivery_fees lookup onto the unified
// RuleTarget abstraction. A rule's target jsonb is RuleTarget[] (scopes
// model | variant | compartment | combo); a cart/order is fed in as
// RuleLineInput[] and matched with the SAME shared deliveryTargetMatchesAnyLine
// the POS uses, so the >0.5% drift gate never sees divergent client/server
// matching. Every matching rule contributes one special fee to
// computeSoDeliveryFee (the pure pricing fn folds in the highest standalone +
// cross-followup). Fees are whole MYR in the DB → ×100 to sen here, the unit
// computeSoDeliveryFee expects.
import {
  deliveryTargetMatchesAnyLine, parseRuleTargets, splitSofaCode, type RuleLineInput,
} from '../shared';
import { scopeToCompanyIdOrOpen } from './companyScope';

/** A persisted SO goods row, as the customer-change redetect path reads it back
 *  from mfg_sales_order_items (joined to its product). */
export interface PersistedGoodsLine {
  itemCode: string;
  /** mfg_products.category (falls back to item_group). */
  category: string | null;
  /** product_models.id; null = no model match possible. */
  modelId: string | null;
  /** mfg_products.size_code — POPULATED for mattress/bedframe, NULL for sofa
   *  modules (a sofa's compartment lives in the item_code suffix instead). */
  sizeCode: string | null;
  /** variants.buildKey — groups the split-sofa module rows of one build. */
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
      // Compartment from the item_code suffix — size_code is NULL for sofa.
      const compartment = splitSofaCode(l.itemCode).sizeCode;
      const buildKey = String(l.buildKey ?? '');
      if (buildKey) {
        const g = sofaBuilds.get(buildKey) ?? { modelId: l.modelId ?? null, modules: [] };
        if (compartment) g.modules.push(compartment);
        sofaBuilds.set(buildKey, g);
        continue; // one consolidated RuleLineInput emitted per build below
      }
      out.push({
        category,
        modelId: l.modelId ?? null,
        sizeCode: null,
        builtCompartments: compartment ? [compartment] : [],
      });
      continue;
    }
    // Non-sofa (mattress/bedframe): the variant code IS size_code.
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
  // Each company keeps its own rules: unscoped, a 2990 rule priced Houzs SOs.
  const { data, error } = await scopeToCompanyIdOrOpen(
    sb.from('special_delivery_fee_rules').select('target, standalone_fee, cross_cat_followup_fee'),
    companyId,
  );
  if (error) throw error;
  const out: { standaloneFee: number; crossCategoryFollowupFee: number }[] = [];
  for (const r of (data ?? []) as Array<Record<string, unknown>>) {
    const target = r.target;
    // dual-read camelCase ?? snake_case (supabase-js returns snake_case; guard
    // against any client that camelCases).
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
