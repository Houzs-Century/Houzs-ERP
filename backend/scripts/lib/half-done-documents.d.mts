// Types for half-done-documents.mjs, which stays plain ESM so the node audit
// (check-half-done-documents.mjs) and the Worker's nightly pass
// (src/services/nightlyIntegrity.ts) judge with one implementation.

type When = string | number | Date | null;

export const DEFAULT_DAYS: number;
export const DEFAULT_LIMIT: number;
export const DUPLICATE_WINDOW_SECONDS: number;

export interface DocRef { docId: string; docNo: string; createdAt: When }
export interface DocLine { docId: string; itemCode: string; itemGroup?: string | null; qty: number | string | null }
export interface DocMovement { docId: string; itemCode: string; net: number | string | null }
export interface DocItemFinding {
  docId: string; docNo: string; createdAt: When; itemCode: string;
  expected: number; actual: number; kind: string;
}
export function compareDocItems(docs: DocRef[], lines: DocLine[], movements: DocMovement[]): DocItemFinding[];
export function cancelledResidue(docs: DocRef[], movements: DocMovement[]): DocItemFinding[];

export interface PoLineRow { poItemId: string; docNo: string; lineNo: number | null; itemCode: string; receivedQty: number | string | null; createdAt: When }
export interface GrnLineRow { poItemId: string; status: string; qty_accepted: number | string | null; returned_qty: number | string | null; returned_closed_qty: number | string | null }
export function comparePoReceived<T extends PoLineRow>(poLines: T[], grnLines: GrnLineRow[]): Array<T & { expected: number; actual: number; kind: "over" | "under" }>;

export interface RebankRow { jeNo: string; sourceType: string; paymentId: string; createdAt: When; paymentExists: boolean; liveEntries: number | string }
export function strandedRebanks<T extends RebankRow>(rows: T[]): Array<T & { docNo: string }>;

export interface LotBucketRow { itemCode: string; warehouse: string; variantKey: string | null; movementNet: number | string; lotOpen: number | string; lastAt: When }
export function lotBucketDiffs<T extends LotBucketRow>(rows: T[]): Array<T & { createdAt: When; docNo: string; diff: number; kind: string }>;

export interface DupDoc { docNo: string; fingerprint: string | null; createdAt: When; status: string | null }
export interface DupCluster { fingerprint: string; docs: DupDoc[]; createdAt: When; docNo: string; spanSeconds: number }
export function duplicateClusters(docs: DupDoc[], windowSeconds?: number): DupCluster[];
