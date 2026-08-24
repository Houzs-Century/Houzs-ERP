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

export type ScanJob = {
  id: string;
  status: string; // queued | running | done | error
  soDocNo: string | null;
  error: string | null;
  duplicateOf: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};
export type ScanJobsResp = { success?: boolean; data?: { jobs?: Array<Record<string, unknown>> } };

/* GET /scan-so/jobs payload → typed rows, dual-read camelCase ?? snake_case
   (jobToJson camelizes today, but the pg camelCase rule means we never trust
   one casing). Rows without an id are dropped. */
export function normalizeJobs(resp: ScanJobsResp | undefined): ScanJob[] {
  const raw = resp?.data?.jobs ?? [];
  return raw
    .map((j) => ({
      id: String(j.id ?? ""),
      status: String(j.status ?? ""),
      soDocNo: (j.soDocNo ?? j.so_doc_no ?? null) as string | null,
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
  const d = new Date(t);
  const n = new Date();
  return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
};
export const hhmm = (t: number): string => {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};
/* A job is "active" while the server is still working it — the only states that
   keep a poll interval running. */
export const isActiveJob = (j: ScanJob): boolean => j.status === "queued" || j.status === "running";

/* ── The known-reps list, shared for the same reason as the jobs poll ────────
   The salesperson sent with a scan is the OCR LEARNING KEY: the backend loads
   that rep's distilled rules and few-shot examples to read the slip
   (`loadPromptInjections(svc, job.salesperson)`), files the resulting sample
   under that name, and filters the Recent-scans list by it. Desktop's modal
   defaults it to whoever is signed in and keeps it EDITABLE against this list,
   "for the occasional someone-else slip"; mobile had a `const` off the signed-in
   user, so an office person working through a stack of colleagues' slips read
   every one of them against their OWN handwriting rules. The endpoint is named
   ONCE here so the two surfaces cannot offer different lists.

   NOT the SO's own salesperson_id: that is stamped server-side from the authed
   caller (`resolveScanUploaderStaffId`) and is not caller-trusted. */
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
