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
  triggerCategory: string;
  triggerEligibleModelIds: string[];
  rewardCategory: string;
  eligibleRewardModelIds: string[];
  triggerSizeCodes?: string[];
  triggerCompartments?: string[];
  rewardSizeCodes?: string[];
  rewardCompartments?: string[];
  qtyPerTrigger: number;
  triggerComboIds?: string[];
  rewardComboIds?: string[];
  /** 'promo' prices the reward FREE (migration 0145). Promo is ONE-WAY
   *  (Loo 2026-06-06): a line that is itself a reward never creates trigger
   *  slots for a promo rule — a free ARRUS must not free another ARRUS.
   *  'pwp' rules are unaffected (rewards may chain into further 换购).
   *  Optional — absent reads as 'pwp'. */
  type?: 'pwp' | 'promo';
}

export interface PwpLineInput {
  idx: number;
  category: string;
  modelId: string | null;
  sizeCode?: string | null;
  builtCompartments?: string[];
  qty: number;
  productName?: string;
  itemCode?: string;
  pwpRequested: boolean;
  isReward?: boolean;
}

export interface PwpGrant {
  idx: number;
  triggerRef: { name: string; code: string } | null;
}

import { passesRefinementColumns, type RuleLineInput } from './rule-target';

const inList = (modelId: string | null, list: string[]): boolean =>
  list.length === 0 ? true : modelId != null && list.includes(modelId);

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
  const granted = new Set<number>();
  const ordered = [...lines].sort((a, b) => a.idx - b.idx);

  for (const rule of rules) {
    const qpt = Math.max(1, Math.floor(Number(rule.qtyPerTrigger) || 1));

    const slots: Array<{ name: string; code: string }> = [];
    for (const line of ordered) {
      if (line.category !== rule.triggerCategory) continue;
      if (!inList(line.modelId, rule.triggerEligibleModelIds)) continue;
      if (!passesRefinementColumns(toRuleLine(line), rule.triggerSizeCodes, rule.triggerCompartments)) continue;
      if (rule.type === 'promo' && (line.isReward === true || line.pwpRequested)) continue;
      const units = safeQty(line.qty);
      for (let u = 0; u < units * qpt; u++) {
        slots.push({ name: line.productName ?? '', code: line.itemCode ?? '' });
      }
    }

    let cursor = 0;
    for (const line of ordered) {
      if (granted.has(line.idx)) continue;
      if (!line.pwpRequested) continue;
      if (line.category !== rule.rewardCategory) continue;
      if (!inList(line.modelId, rule.eligibleRewardModelIds)) continue;
      if (!passesRefinementColumns(toRuleLine(line), rule.rewardSizeCodes, rule.rewardCompartments)) continue;
      const need = safeQty(line.qty);
      if (need <= 0) continue;
      if (cursor + need > slots.length) continue;
      const ref = slots[cursor];
      cursor += need;
      granted.add(line.idx);
      grants.push({ idx: line.idx, triggerRef: ref ? { ...ref } : null });
    }
  }

  return grants;
}
