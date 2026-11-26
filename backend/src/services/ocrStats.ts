// ---------------------------------------------------------------------------
// ocrStats.ts — the IT OCR page (routes/ocrDashboard.ts): how well the AI read
// scanned documents in one month, for the active company. Built only from rows
// the scan pipeline already keeps (scm.scan_jobs + scm.so_scan_samples); see
// docs/modules/ocr-dashboard.md for what each number can and cannot say.
// ---------------------------------------------------------------------------
import { sql } from "drizzle-orm";
import type { Env } from "../types";
import { getDb } from "../db/client";
import { mytMonthRangeUtc } from "./agent-console";
import { scanSoModel } from "../scm/lib/scan-ocr";
import { changedFields, LINES_CHANGED } from "../scm/lib/scan-slip-fields";
import { correctionChanges, type FieldChange } from "../scm/lib/scan-correction-detail";
import { fieldScore } from "../scm/lib/scan-field-accuracy";
import { SCAN_DOCUMENT_TYPES, SCAN_DOCUMENT_TYPE_LABEL, isScanDocumentType } from "../scm/lib/scan-document-type";

export { changedFields, LINES_CHANGED };
export type { FieldChange };

export type ScanOutcome = "pending" | "failed" | "needsReview" | "discarded" | "clean" | "corrected" | "awaiting" | "imported";

/** One scan_jobs row joined to its sample, as the query returns it. */
export interface ScanRow {
  id: string;
  document_type: string;
  status: string;
  error: string | null;
  review_state: string | null;
  doc_no: string | null;
  created_at: string | Date;
  updated_at: string | Date;
  sample_status: string | null;
  sample_error: string | null;
  extracted: unknown;
  corrected: unknown;
  draft_baseline: unknown;
  so_missing: boolean;
  has_baseline: boolean;
  slip_image_key: string | null;
}

const UNREADABLE_PREFIX = "The scan could not read";

export function classifyScan(r: ScanRow): { outcome: ScanOutcome; detail: string | null } {
  if (r.status === "queued" || r.status === "running") return { outcome: "pending", detail: null };
  if (r.status === "error") return { outcome: "failed", detail: r.error };
  if (r.sample_status === "FAILED") return { outcome: "failed", detail: r.sample_error ?? r.error };
  const so = r.document_type === "SO";
  if (so && r.error?.startsWith(UNREADABLE_PREFIX)) return { outcome: "failed", detail: r.error };
  if (!so && !r.doc_no) {
    if (r.review_state === "pending") return { outcome: "awaiting", detail: null };
    if (r.review_state === "discarded") return { outcome: "discarded", detail: null };
    return { outcome: "needsReview", detail: r.error ?? "No document was created" };
  }
  if (so && r.so_missing) return { outcome: "discarded", detail: null };
  if (!so) return { outcome: "imported", detail: null };
  if (r.sample_status === "ACCEPTED") return { outcome: "clean", detail: null };
  if (r.sample_status === "CONFIRMED") {
    const fields = changedFields(r.extracted, r.corrected);
    return { outcome: "corrected", detail: fields.length ? fields.join(", ") : null };
  }
  return { outcome: "awaiting", detail: null };
}


export interface DocTypeStats {
  documentType: string;
  label: string;
  scans: number;
  pending: number;
  failed: number;
  needsReview: number;
  discarded: number;
  awaiting: number;
  clean: number;
  corrected: number;
  imported: number;
  accuracy: { clean: number; reviewed: number } | null;
  fieldAccuracy: { correct: number; total: number; scans: number } | null;
  avgSec: number | null;
  p90Sec: number | null;
}
export interface FieldMiss { field: string; count: number }
export interface ProblemScan {
  id: string;
  at: string;
  documentType: string;
  docNo: string | null;
  outcome: "failed" | "needsReview" | "corrected";
  detail: string | null;
  changes: FieldChange[] | null;
  fieldAccuracy: { correct: number; total: number } | null;
  slipImageKey: string | null;
}
export interface OcrReport {
  month: string;
  model: string;
  docTypes: DocTypeStats[];
  fieldMisses: { reviewed: number; fields: FieldMiss[] };
  problems: ProblemScan[];
}

const PROBLEM_LIMIT_PER_TYPE = 30;
/**
 * A reviewed slip's edits are exact only when the draft baseline was kept.
 * Without it the review counts the scan pipeline's own changes (phone format,
 * city, postcode) as a person's, so no slip could ever read as clean.
 */
export function editsRecordedExactly(r: ScanRow): boolean {
  return r.has_baseline;
}
const iso = (v: string | Date) => new Date(v).toISOString();

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
}

/** Pure: rows (newest first) to the report. */
export function buildOcrReport(month: string, model: string, rows: ScanRow[]): OcrReport {
  const byType = new Map<string, DocTypeStats>();
  const secs = new Map<string, number[]>();
  const misses = new Map<string, number>();
  let reviewed = 0;
  const problems: ProblemScan[] = [];
  const problemCounts = new Map<string, number>();

  for (const r of rows) {
    const t = r.document_type;
    let s = byType.get(t);
    if (!s) {
      s = {
        documentType: t, label: isScanDocumentType(t) ? SCAN_DOCUMENT_TYPE_LABEL[t] : t, scans: 0, pending: 0, failed: 0, needsReview: 0, discarded: 0, awaiting: 0, clean: 0, corrected: 0, imported: 0,
        accuracy: null, fieldAccuracy: null, avgSec: null, p90Sec: null,
      };
      byType.set(t, s);
      secs.set(t, []);
    }
    const { outcome, detail } = classifyScan(r);
    const changes = outcome === "corrected" ? correctionChanges(r.extracted, r.corrected, r.draft_baseline) : null;
    const exact = (outcome === "clean" || outcome === "corrected") && editsRecordedExactly(r);
    const score = exact
      ? fieldScore(r.extracted, outcome === "clean" ? r.extracted : r.corrected)
      : null;
    if (score) {
      const fa = (s.fieldAccuracy ??= { correct: 0, total: 0, scans: 0 });
      fa.correct += score.total - score.changed;
      fa.total += score.total;
      fa.scans++;
    }
    if (exact) {
      const acc = (s.accuracy ??= { clean: 0, reviewed: 0 });
      acc.reviewed++;
      if (outcome === "clean") acc.clean++;
    }
    s.scans++;
    s[outcome]++;
    if (outcome !== "pending") {
      const sec = (new Date(r.updated_at).getTime() - new Date(r.created_at).getTime()) / 1000;
      if (Number.isFinite(sec) && sec >= 0) secs.get(t)!.push(sec);
    }
    if (exact) reviewed++;
    if (exact && outcome === "corrected" && detail) {
      for (const f of detail.split(", ")) misses.set(f, (misses.get(f) ?? 0) + 1);
    }
    const problemsOfType = problemCounts.get(t) ?? 0;
    if ((outcome === "failed" || outcome === "needsReview" || outcome === "corrected") && problemsOfType < PROBLEM_LIMIT_PER_TYPE) {
      problemCounts.set(t, problemsOfType + 1);
      problems.push({ id: r.id, at: iso(r.created_at), documentType: t, docNo: r.doc_no, outcome, detail, changes,
        fieldAccuracy: outcome === "corrected" && score ? { correct: score.total - score.changed, total: score.total } : null,
        slipImageKey: r.slip_image_key,
      });
    }
  }

  for (const s of byType.values()) {
    if (s.documentType === "SO") {
      s.accuracy ??= { clean: 0, reviewed: 0 };
      s.fieldAccuracy ??= { correct: 0, total: 0, scans: 0 };
    }
    const list = secs.get(s.documentType)!.sort((a, b) => a - b);
    if (list.length) {
      s.avgSec = list.reduce((a, b) => a + b, 0) / list.length;
      s.p90Sec = percentile(list, 0.9);
    }
  }

  const order: readonly string[] = SCAN_DOCUMENT_TYPES;
  const rank = (t: string) => (order.includes(t) ? order.indexOf(t) : order.length);
  return {
    month,
    model,
    docTypes: [...byType.values()].sort((a, b) => rank(a.documentType) - rank(b.documentType)),
    fieldMisses: {
      reviewed,
      fields: [...misses].map(([field, count]) => ({ field, count })).sort((a, b) => b.count - a.count),
    },
    problems,
  };
}

/** One month (MYT, "YYYY-MM") of one company's scans. */
export async function loadOcrReport(env: Env, companyId: number, month: string): Promise<OcrReport> {
  const { startIso, endIso } = mytMonthRangeUtc(month);
  const rows = await getDb(env).execute<ScanRow & Record<string, unknown>>(sql`
    SELECT j.id, j.document_type, j.status, j.error, j.review_state,
           coalesce(j.linked_doc_no, j.so_doc_no) AS doc_no,
           j.created_at, j.updated_at,
           s.status AS sample_status,
           CASE WHEN s.status = 'FAILED' THEN s.extracted->>'error' END AS sample_error,
           CASE WHEN s.status IN ('ACCEPTED', 'CONFIRMED') AND j.document_type = 'SO' THEN s.extracted END AS extracted,
           CASE WHEN s.status = 'CONFIRMED' THEN s.corrected END AS corrected,
           CASE WHEN s.status = 'CONFIRMED' THEN s.draft_baseline END AS draft_baseline,
           CASE WHEN j.document_type = 'SO' THEN s.image_key END AS slip_image_key,
           (s.draft_baseline IS NOT NULL) AS has_baseline,
           (j.document_type = 'SO' AND j.status = 'done' AND j.so_doc_no IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM scm.mfg_sales_orders so
                              WHERE so.doc_no = j.so_doc_no AND so.company_id = j.company_id)) AS so_missing
      FROM scm.scan_jobs j
      LEFT JOIN scm.so_scan_samples s ON s.id = j.sample_id
     WHERE j.company_id = ${companyId}
       AND j.document_type NOT LIKE 'AI_%' -- AI reads (scm/lib/ai-read-jobs.ts) share the table; they are not scans
       AND j.created_at >= ${startIso}::timestamptz AND j.created_at < ${endIso}::timestamptz
     ORDER BY j.created_at DESC`);
  return buildOcrReport(month, scanSoModel(env), [...rows]);
}
