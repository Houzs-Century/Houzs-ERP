// Types for duplicate-sku-merge-run.mjs (see its header).
import type { MergePairPlan, MergePlan } from './duplicate-sku-merge-plan.mjs';

export type MergeWorld = {
  products: unknown[];
  refs: unknown[];
  ids: Map<string, string[]>;
  missing: string[];
  stock: Array<{ code: string; warehouseCode: string; ledgerQty: number; lotQty: number }>;
  uniques: unknown[];
  masters: unknown[];
  mainSuppliers: unknown[];
  stockTakeLines: unknown[];
};
type Cascade = ReadonlyArray<{ table: string; col: string; kind?: unknown }>;

export function readMergeColumns(sql: any, cascade: Cascade): Promise<Map<string, Set<string>>>;
export function readMergeWorld(sql: any, w: {
  co: number; pairs: Array<{ drop: string; keep: string }>; cascade: Cascade; cols: Map<string, Set<string>>;
}): Promise<MergeWorld>;
export function rekeyIds(world: MergeWorld, p: MergePairPlan, r: MergePairPlan['rekey'][number]): string[];
export function applyMerge(sql: any, w: {
  co: number; plan: MergePlan; world: MergeWorld; cascade: Cascade;
  audit: { actorId: number | null; actorEmail: string | null; requestId: string | null } | null;
}): Promise<{ committed: MergePairPlan[]; problems: string[]; rekeyed: number }>;
export function verifyMerge(v: any, w: { co: number; committed: MergePairPlan[]; world: MergeWorld }): Promise<string[]>;
