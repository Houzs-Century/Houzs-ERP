// Types for duplicate-model-merge-plan.mjs (see its header).
export function planModelGroup(w: { group: unknown; models: unknown[]; skus: unknown[] }): any;
export function confirmPhrase(t: { groups: number; pairs: number; moves: number; inactive: number; fills: number; folds: number; idleModels: number; idleSkus: number }): string;
export function foldOnlyPlan(plan: any, keptModelActive: boolean): { ok: true; plan: any } | { ok: false; reason: string };
export type FoldTarget = { fromModelId: string; from: string | null; intoModelId: string | null; into: string; fold: boolean; reason: string | null };
export function foldTargets(w: {
  pairs: ReadonlyArray<{ drop: string; keep: string }>;
  codeModels: Map<string, { model_id: string | null; model_code: string | null; status: string }>;
  activeByModel: Map<string, number>;
  retiring: Set<string>;
}): FoldTarget[];
