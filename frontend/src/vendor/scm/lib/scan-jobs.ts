// ----------------------------------------------------------------------------
// scan-jobs — SHARED background-scan-job helpers for BOTH the mobile Scan screen
// (MobileScan.tsx) and the desktop Scan Order modal (ScanOrderModal.tsx).
//
// The /scan-so/enqueue → /scan-so/jobs background-draft flow is identical on
// both surfaces (owner 2026-07-04). These helpers — the job shape, the
// dual-read (camelCase ?? snake_case, pg camelCase rule) normaliser and the
// small time predicates — were originally defined inside MobileScan; they now
// live here so the desktop modal reuses the SAME code path instead of keeping a
// third copy. MobileScan re-exports normalizeJobs / ScanJob / ScanJobsResp so
// its existing consumers (MobileSalesOrders) are unaffected.
// ----------------------------------------------------------------------------

import { instantToMytLocal, mytDayOf, todayMyt } from "./dates";

export type ScanJob = {
  id: string;
  status: string;
  soDocNo: string | null;
  linkedDocNo: string | null;
  linkedDocId: string | null;
  error: string | null;
  duplicateOf: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};
export type ScanJobsResp = { success?: boolean; data?: { jobs?: Array<Record<string, unknown>> } };

export function normalizeJobs(resp: ScanJobsResp | undefined): ScanJob[] {
  const raw = resp?.data?.jobs ?? [];
  return raw
    .map((j) => ({
      id: String(j.id ?? ""),
      status: String(j.status ?? ""),
      soDocNo: (j.soDocNo ?? j.so_doc_no ?? null) as string | null,
      linkedDocNo: (j.linkedDocNo ?? j.linked_doc_no ?? j.soDocNo ?? j.so_doc_no ?? null) as string | null,
      linkedDocId: (j.linkedDocId ?? j.linked_doc_id ?? null) as string | null,
      error: (j.error ?? null) as string | null,
      duplicateOf: (j.duplicateOf ?? j.duplicate_of ?? null) as string | null,
      createdAt: (j.createdAt ?? j.created_at ?? null) as string | null,
      updatedAt: (j.updatedAt ?? j.updated_at ?? null) as string | null,
    }))
    .filter((j) => j.id !== "");
}

export const jobTs = (s: string | null): number => {
  const t = s ? Date.parse(s) : NaN;
  return Number.isNaN(t) ? 0 : t;
};
export const isTodayTs = (t: number): boolean => {
  if (t === 0) return false;
  return mytDayOf(new Date(t).toISOString()) === todayMyt();
};
export const hhmm = (t: number): string => instantToMytLocal(new Date(t).toISOString()).slice(11, 16);
export const isActiveJob = (j: ScanJob): boolean => j.status === "queued" || j.status === "running";

export const SCAN_SALESPEOPLE_PATH = "/scan-so/salespeople";
export type ScanSalespeopleResp = { data?: { salespeople?: unknown } };

/** GET /scan-so/salespeople payload → the datalist. A malformed or missing
 *  answer is an EMPTY list and never a throw: the field stays free-text either
 *  way, so a hiccup here must not take the scan screen down with it. */
export function normalizeScanSalespeople(resp: unknown): string[] {
  const raw = (resp as ScanSalespeopleResp | undefined)?.data?.salespeople;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.trim())
    .filter((v) => v !== "");
}
