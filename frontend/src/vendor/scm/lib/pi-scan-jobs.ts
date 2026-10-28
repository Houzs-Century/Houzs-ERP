// ----------------------------------------------------------------------------
// pi-scan-jobs — SHARED background invoice-scan helpers for BOTH the desktop
// Scan-invoice modal and the mobile invoice scanner. The PI mirror of
// scan-jobs.ts (the SO scanner's shared job helpers).
//
// A PI scan is the SAME /enqueue -> queue -> DRAFT flow as the SO scanner, but
// against /scan-pi and producing a DRAFT Purchase Invoice CONVERTED from the
// matching Goods Receipt. The produced document number rides `linkedDocNo` (the
// generic column, mig 20260919T1000), not `soDocNo`.
// ----------------------------------------------------------------------------

import { authedFetch } from "./authed-fetch";

export type PiScanJob = {
  id: string;
  status: string; // queued | running | done | error
  /** the DRAFT Purchase Invoice number this scan produced (null until done, or
   *  when the scan landed a needs-review outcome with no PI). */
  linkedDocNo: string | null;
  /** a plain sentence: the "needs review" reason on a done-with-no-doc job, or
   *  the failure reason on an error job. */
  error: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

export type PiScanJobsResp = { success?: boolean; data?: { jobs?: Array<Record<string, unknown>> } };

/* GET /scan-pi/jobs payload -> typed rows, dual-read camelCase ?? snake_case
   (the pg camelCase rule — never trust one casing). Rows without an id drop. */
export function normalizePiJobs(resp: PiScanJobsResp | undefined): PiScanJob[] {
  const raw = resp?.data?.jobs ?? [];
  return raw
    .map((j) => ({
      id: String(j.id ?? ""),
      status: String(j.status ?? ""),
      linkedDocNo: (j.linkedDocNo ?? j.linked_doc_no ?? null) as string | null,
      error: (j.error ?? null) as string | null,
      createdAt: (j.createdAt ?? j.created_at ?? null) as string | null,
      updatedAt: (j.updatedAt ?? j.updated_at ?? null) as string | null,
    }))
    .filter((j) => j.id !== "");
}

export const piJobTs = (s: string | null): number => {
  const t = s ? Date.parse(s) : NaN;
  return Number.isNaN(t) ? 0 : t;
};
export const isPiTodayTs = (t: number): boolean => {
  if (t === 0) return false;
  const d = new Date(t);
  const n = new Date();
  return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
};
export const piHhmm = (t: number): string => {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};
/** A job is "active" while the server is still working it (poll keeps running). */
export const isActivePiJob = (j: PiScanJob): boolean => j.status === "queued" || j.status === "running";

/** POST files to /scan-pi/enqueue. Returns fast with { job_id } before any OCR —
 *  the DRAFT PI is minted server-side. Files should already be OCR-compressed. */
export async function enqueuePiScan(files: File[]): Promise<{ job_id: string; status: string }> {
  const form = new FormData();
  for (const f of files) form.append("file", f);
  return authedFetch<{ job_id: string; status: string }>("/scan-pi/enqueue", { method: "POST", body: form });
}

/** GET /scan-pi/jobs — this company's latest 20 invoice-scan jobs. */
export async function fetchPiScanJobs(): Promise<PiScanJob[]> {
  const resp = await authedFetch<PiScanJobsResp>("/scan-pi/jobs");
  return normalizePiJobs(resp);
}

/** POST /scan-pi/jobs/clear-failed — clear terminal error cards. */
export async function clearFailedPiScans(): Promise<void> {
  await authedFetch("/scan-pi/jobs/clear-failed", { method: "POST" });
}
