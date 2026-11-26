
import { authedFetch } from "./authed-fetch";
import { instantToMytLocal, mytDayOf, todayMyt } from "./dates";

export type PiScanJob = {
  id: string;
  status: string;
  linkedDocNo: string | null;
  error: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

export type PiScanJobsResp = { success?: boolean; data?: { jobs?: Array<Record<string, unknown>> } };

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
  return mytDayOf(new Date(t).toISOString()) === todayMyt();
};
export const piHhmm = (t: number): string => instantToMytLocal(new Date(t).toISOString()).slice(11, 16);
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
