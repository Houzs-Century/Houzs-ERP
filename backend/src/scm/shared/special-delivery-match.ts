import { refinementMatchesLine, type RuleTarget, type RuleLineInput } from './rule-target';

/**
 * Does ANY order/cart line satisfy ANY of this rule's targets?
 * Delivery treats `combo` and `compartment` as MODEL-AGNOSTIC (a heavy module or
 * combo ships the same in any sofa), so it calls refinementMatchesLine directly
 * and skips the model check that lineMatchesTarget would impose. `model` and
 * `variant` still require the line's Model. Reuses refinementMatchesLine — no
 * parallel logic.
 */
export function deliveryTargetMatchesAnyLine(
  lines: RuleLineInput[],
  targets: RuleTarget[],
  comboModulesById: Map<string, string[][]>,
): boolean {
  return targets.some((t) =>
    lines.some((line) => {
      const needsModel = t.scope === 'model' || t.scope === 'variant';
      if (needsModel && t.modelId && t.modelId !== line.modelId) return false;
      return refinementMatchesLine(line, t, comboModulesById);
    }),
  );
}
