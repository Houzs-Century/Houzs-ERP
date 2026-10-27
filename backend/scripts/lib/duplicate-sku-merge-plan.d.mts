// Types for duplicate-sku-merge-plan.mjs, plain ESM so the Actions script and
// the Worker route (src/scm/routes/mfg-product-merge.ts) share one planner.
export const STAYS_ON_DROP: Set<string>;
export type MergePairPlan = {
  drop: string;
  keep: string;
  dropRowId: string | null;
  dropRowStatus: string | null;
  refusals: string[];
  rekey: Array<{ table: string; col: string; rows: number; ids?: string[] }>;
  stay: Array<{ table: string; col: string; rows: number }>;
  unitsMoved: number;
  retire: boolean;
};
export type MergeTotals = { pairs: number; refused: number; rowsToRekey: number; unitsMoved: number; toRetire: number };
export type MergePlan = { pairs: MergePairPlan[]; totals: MergeTotals };
export function planDuplicateSkuMerge(w: {
  pairs: Array<{ drop: string; keep: string }>;
  products: unknown[];
  refs: unknown[];
  stock: unknown[];
  stockTakeLines: unknown[];
}): MergePlan;
export function confirmPhrase(totals: MergeTotals): string;
