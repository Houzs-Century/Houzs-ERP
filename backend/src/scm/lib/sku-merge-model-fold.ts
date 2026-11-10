/**
 * After a SKU Master "Merge codes": a dropped code's Product Model left with no
 * ACTIVE code folds into the kept code's Model, in the same request (owner,
 * 2026-11-10, option C). The rules are the Model merge's own
 * (duplicate-model-merge-plan.mjs) and the writes its writer's; this file only
 * decides WHICH Models and reports every outcome, so a fold that is refused
 * reaches the person who merged instead of leaving the Model behind in silence.
 *
 * A refused or failed fold never undoes the SKU merge: that merge committed
 * first, on its own, and stands.
 */
import { foldOnlyPlan, foldTargets, type FoldTarget } from '../../../scripts/lib/duplicate-model-merge-plan.mjs';

export type FoldOutcome = { from: string | null; into: string; fold: boolean; codes: number; reason: string | null };

/** What a pure fold carries (duplicate-model-merge-plan.mjs planModelGroup, through foldOnlyPlan). */
export type FoldPlan = { keptModelId: string; label: string; inactiveMoves: Array<{ id: string; code: string; fromModelId: string | null }>; foldModels: Array<{ id: string; code: string }> };

export type FoldIo = {
  readFoldInputs: (w: { co: number; codes: string[] }) => Promise<{
    codeModels: Map<string, { model_id: string | null; model_code: string | null; status: string }>;
    activeByModel: Map<string, number>;
  }>;
  planModelFold: (w: { co: number; keep: string; drops: string[]; retiring: Set<string> | null }) => Promise<{ world: unknown; plan: unknown; keptActive: boolean }>;
  /** The undo on record, then the writes, then a re-read on a fresh connection; returns what the re-read found wrong. */
  applyFold: (w: { co: number; plan: FoldPlan; world: unknown; summary: string }) => Promise<string[]>;
};

const codesOf = (pairs: ReadonlyArray<{ drop: string; keep: string }>) => [...new Set(pairs.flatMap((p) => [p.drop, p.keep]))];

async function planned(io: FoldIo, co: number, t: FoldTarget, retiring: Set<string> | null) {
  if (!t.fold) return { t, verdict: { ok: false as const, reason: t.reason ?? '' }, world: null };
  const { world, plan, keptActive } = await io.planModelFold({ co, keep: t.into, drops: [t.from ?? ''], retiring });
  return { t, verdict: foldOnlyPlan(plan, keptActive), world };
}

/** What the merge WILL do to Models, for the Check preview. `retiring`: the drops the merge switches off. */
export async function previewModelFolds(io: FoldIo, co: number, pairs: ReadonlyArray<{ drop: string; keep: string }>, retiring: Set<string>): Promise<FoldOutcome[]> {
  if (pairs.length === 0) return [];
  const inputs = await io.readFoldInputs({ co, codes: codesOf(pairs) });
  const out: FoldOutcome[] = [];
  for (const t of foldTargets({ pairs, ...inputs, retiring })) {
    const { verdict } = await planned(io, co, t, retiring);
    out.push(verdict.ok
      ? { from: t.from, into: t.into, fold: true, codes: verdict.plan.inactiveMoves.length, reason: null }
      : { from: t.from, into: t.into, fold: false, codes: 0, reason: verdict.reason });
  }
  return out;
}

/** The folds, after the SKU merge committed. Reads the rows again: they now say which codes are off. */
export async function foldModelsAfterSkuMerge(io: FoldIo, co: number, committed: ReadonlyArray<{ drop: string; keep: string }>): Promise<{ folds: FoldOutcome[]; problems: string[] }> {
  if (committed.length === 0) return { folds: [], problems: [] };
  const inputs = await io.readFoldInputs({ co, codes: codesOf(committed) });
  const folds: FoldOutcome[] = [];
  const problems: string[] = [];
  for (const t of foldTargets({ pairs: committed, ...inputs, retiring: new Set() })) {
    try {
      const { verdict, world } = await planned(io, co, t, null);
      if (!verdict.ok) { folds.push({ from: t.from, into: t.into, fold: false, codes: 0, reason: verdict.reason }); continue; }
      const plan = verdict.plan as FoldPlan;
      const found = await io.applyFold({ co, plan, world, summary: `Folding Model "${t.from}" into "${t.into}" after a SKU merge left it with no active code` });
      problems.push(...found);
      folds.push({ from: t.from, into: t.into, fold: true, codes: plan.inactiveMoves.length, reason: null });
    } catch (e) {
      folds.push({ from: t.from, into: t.into, fold: false, codes: 0, reason: e instanceof Error ? e.message : String(e) });
    }
  }
  return { folds, problems };
}

/** The sentence a person reads for a Model that was not folded. */
export const notFoldedText = (f: FoldOutcome) => `Model ${f.from ?? '(none)'} was not merged: ${f.reason ?? 'unknown reason'}`;
