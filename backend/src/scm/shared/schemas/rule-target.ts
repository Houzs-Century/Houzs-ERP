// Zod schemas for unified rule targeting (RuleTarget / TargetRefinement).
// Ported from 2990 (#691). Used by the special-delivery-fee write endpoint to
// reject malformed / cross-category shapes before they reach the DB. See
// ../rule-target.ts for the runtime types + matcher.
import { z } from 'zod';

const baseRefinement = z.object({
  scope: z.enum(['model', 'variant', 'combo', 'compartment']),
  sizeCodes: z.array(z.string().min(1)).optional(),
  comboIds: z.array(z.string().min(1)).optional(),
  compartments: z.array(z.string().min(1)).optional(),
});

type BaseRefinement = z.infer<typeof baseRefinement>;

/** Cross-field rule: each scope requires its own list and forbids the others. */
function refineScopeFields(t: BaseRefinement, ctx: z.RefinementCtx): void {
  const need = (k: 'sizeCodes' | 'comboIds' | 'compartments'): void => {
    if (!t[k] || t[k]!.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${t.scope} requires ${k}`, path: [k] });
    }
  };
  const forbid = (keys: Array<'sizeCodes' | 'comboIds' | 'compartments'>): void => {
    for (const k of keys) {
      if (t[k] && t[k]!.length > 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${k} not allowed for scope ${t.scope}`, path: [k] });
      }
    }
  };
  switch (t.scope) {
    case 'model':
      forbid(['sizeCodes', 'comboIds', 'compartments']);
      break;
    case 'variant':
      need('sizeCodes');
      forbid(['comboIds', 'compartments']);
      break;
    case 'combo':
      need('comboIds');
      forbid(['sizeCodes', 'compartments']);
      break;
    case 'compartment':
      need('compartments');
      forbid(['sizeCodes', 'comboIds']);
      break;
  }
}

/** Refinement only (no modelId). */
export const targetRefinementSchema = baseRefinement.superRefine(refineScopeFields);

/** A full target entry (modelId + scope). */
export const ruleTargetSchema = baseRefinement
  .extend({ modelId: z.string().min(1) })
  .superRefine(refineScopeFields);

export const ruleTargetArraySchema = z.array(ruleTargetSchema);
