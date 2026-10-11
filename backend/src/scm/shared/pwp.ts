// ----------------------------------------------------------------------------
// Purchase-with-purchase (PWP / 换购优惠) — the SOLE source of truth for which
// reward lines in an order get the PWP price. Pure — no I/O.
//
// Buying a TRIGGER (a specified Mattress model) unlocks buying a REWARD (a
// specified Bed Frame model) at its PWP price. The POS configurator (to show
// the toggle + price) AND the server recompute (to lock the price + anti-tamper)
// import THIS same function so the figure cannot drift.
//
//   allowance(rule) = qtyPerTrigger × (Σ qty of eligible trigger lines)
//
// Each reward line that the salesperson toggled on is granted PWP greedily by
// order (idx), consuming its qty from the allowance — whole-line, all-or-nothing
// (a line whose qty exceeds the remaining allowance is simply NOT granted; the
// POS hides its toggle rather than splitting the line). A granted line is bound
// to a specific trigger unit (the Mattress it is "redeemed against") so the
// invoice can print "PWP Price · 换购自 <Mattress>". POS-SELLING only.
// ----------------------------------------------------------------------------

export interface PwpRule {
  /** UPPERCASE mfg category, e.g. 'MATTRESS'. */
  triggerCategory: string;
  /** product_models.id[] that qualify as triggers. [] = whole trigger category. */
  triggerEligibleModelIds: string[];
  /** UPPERCASE mfg category, e.g. 'BEDFRAME'. */
  rewardCategory: string;
  /** product_models.id[] that may be redeemed. [] = whole reward category. */
  eligibleRewardModelIds: string[];
  /** Variant/compartment refinement (migration 0182 · Houzs 0051), ANDed on top of the model
   *  lists. [] / absent = no refinement. Matched by passesRefinementColumns so
   *  this POS preview agrees with the server mint/claim gates. */
  triggerSizeCodes?: string[];
  triggerCompartments?: string[];
  rewardSizeCodes?: string[];
  rewardCompartments?: string[];
  /** Reward units unlocked per qualifying trigger unit (≥ 1). */
  qtyPerTrigger: number;
  /** SOFA trigger: sofa_combo_pricing.id[] whose build qualifies as a trigger
   *  (Phase 2). Sofa is modular (no Model) so it's matched by Combo. Mattress /
   *  bedframe rules leave this empty and use the model-id lists above. */
  triggerComboIds?: string[];
  /** SOFA reward: sofa_combo_pricing.id[] redeemable at the combo PWP price. */
  rewardComboIds?: string[];
  /** 'promo' prices the reward FREE (migration 0145). Promo is ONE-WAY
   *  (Loo 2026-06-06): a line that is itself a reward never creates trigger
   *  slots for a promo rule — a free ARRUS must not free another ARRUS.
   *  'pwp' rules are unaffected (rewards may chain into further 换购).
   *  Optional — absent reads as 'pwp'. */
  type?: 'pwp' | 'promo';
}

export interface PwpLineInput {
  /** Stable line index (cart line order / order item order). */
  idx: number;
  /** UPPERCASE mfg category of the line's product. */
  category: string;
  /** product_models.id of the line's product. null = legacy / unknown → never matches a model list. */
  modelId: string | null;
  /** mfg size_code (mattress/bedframe) + sofa build modules — for the 0182
   *  refinement gate. Absent = no size / no modules (refinement still passes when
   *  the rule has no refinement). */
  sizeCode?: string | null;
  builtCompartments?: string[];
  /** Units on this line (≥ 0). */
  qty: number;
  /** Display label of the product (for the trigger reference on the invoice). */
  productName?: string;
  /** Product code (for the trigger reference). */
  productCode?: string;
  /** The salesperson toggled "use PWP price" on this reward line. */
  pwpRequested: boolean;
  /** This line IS a reward already (bought with a PWP/promo code). Reward
   *  lines still trigger 'pwp' rules but never 'promo' rules (one-way). */
  isReward?: boolean;
}

export interface PwpGrant {
  /** The reward line (idx) that is granted the PWP price. */
  idx: number;
  /** The trigger unit this reward is redeemed against (for the invoice), or null. */
  triggerRef: { name: string; code: string } | null;
}

import { passesRefinementColumns, type RuleLineInput } from './rule-target';

const inList = (modelId: string | null, list: string[]): boolean =>
  list.length === 0 ? true : modelId != null && list.includes(modelId);

/** PwpLineInput → the RuleLineInput shape the 0182 refinement gate needs. */
const toRuleLine = (l: PwpLineInput): RuleLineInput => ({
  category: l.category,
  modelId: l.modelId,
  sizeCode: l.sizeCode ?? null,
  builtCompartments: l.builtCompartments ?? [],
});

const safeQty = (n: number): number => {
  const q = Math.floor(Number(n) || 0);
  return q > 0 ? q : 0;
};

/**
 * Decide, per reward line, whether the PWP price applies and which trigger unit
 * it binds to. Deterministic: rules in order, lines greedily by idx. A reward
 * line is granted only if it was toggled (pwpRequested), its Model is eligible,
 * and the remaining allowance covers its full qty.
 *
 * Returns one PwpGrant per granted reward line. Lines not granted are absent.
 */
export function resolvePwp(rules: PwpRule[], lines: PwpLineInput[]): PwpGrant[] {
  const grants: PwpGrant[] = [];
  const granted = new Set<number>();           // reward idx already granted (a line matches ≤ 1 rule)
  const ordered = [...lines].sort((a, b) => a.idx - b.idx);

  for (const rule of rules) {
    const qpt = Math.max(1, Math.floor(Number(rule.qtyPerTrigger) || 1));

    // Build the trigger slot queue: each eligible trigger unit contributes
    // qtyPerTrigger slots, labelled with its product so a grant can reference it.
    const slots: Array<{ name: string; code: string }> = [];
    for (const line of ordered) {
      if (line.category !== rule.triggerCategory) continue;
      if (!inList(line.modelId, rule.triggerEligibleModelIds)) continue;
      // Variant/compartment refinement (0182 · Houzs 0051) — narrows the trigger further.
      if (!passesRefinementColumns(toRuleLine(line), rule.triggerSizeCodes, rule.triggerCompartments)) continue;
      // Promo is one-way (Loo 2026-06-06): a reward-side line (already bought
      // with a code, or asking to be priced as a reward right now) never
      // opens promo allowance — else a rule whose trigger set == reward set
      // (buy ARRUS → free ARRUS) lets the free unit fund the next free unit.
      if (rule.type === 'promo' && (line.isReward === true || line.pwpRequested)) continue;
      const units = safeQty(line.qty);
      for (let u = 0; u < units * qpt; u++) {
        slots.push({ name: line.productName ?? '', code: line.productCode ?? '' });
      }
    }

    let cursor = 0; // next free slot
    for (const line of ordered) {
      if (granted.has(line.idx)) continue;
      if (!line.pwpRequested) continue;
      if (line.category !== rule.rewardCategory) continue;
      if (!inList(line.modelId, rule.eligibleRewardModelIds)) continue;
      // Variant/compartment refinement (0182 · Houzs 0051) — narrows the reward further.
      if (!passesRefinementColumns(toRuleLine(line), rule.rewardSizeCodes, rule.rewardCompartments)) continue;
      const need = safeQty(line.qty);
      if (need <= 0) continue;
      if (cursor + need > slots.length) continue;   // not enough allowance → not granted
      const ref = slots[cursor];
      cursor += need;
      granted.add(line.idx);
      grants.push({ idx: line.idx, triggerRef: ref ? { ...ref } : null });
    }
  }

  return grants;
}
