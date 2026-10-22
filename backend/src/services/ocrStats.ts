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
import { CLAUDE_MODEL } from "../scm/lib/scan-ocr";
import { SCAN_DOCUMENT_TYPES, SCAN_DOCUMENT_TYPE_LABEL, isScanDocumentType } from "../scm/lib/scan-document-type";

export type ScanOutcome = "pending" | "failed" | "discarded" | "clean" | "corrected" | "awaiting" | "imported";

/** One scan_jobs row joined to its sample, as the query returns it. */
export interface ScanRow {
  id: string;
  document_type: string;
  status: string;
  error: string | null;
  doc_no: string | null;
  created_at: string | Date;
  updated_at: string | Date;
  sample_status: string | null;
  sample_error: string | null;
  extracted: unknown;
  corrected: unknown;
  /** SO only: the draft this scan made no longer exists (deleted). */
  so_missing: boolean;
}

/** scan-so.ts writes this prefix on a `done` job whose slip it could not read (a blank shell draft). */
const UNREADABLE_PREFIX = "The scan could not read";

export function classifyScan(r: ScanRow): { outcome: ScanOutcome; detail: string | null } {
  if (r.status === "queued" || r.status === "running") return { outcome: "pending", detail: null };
  if (r.status === "error") return { outcome: "failed", detail: r.error };
  if (r.sample_status === "FAILED") return { outcome: "failed", detail: r.sample_error ?? r.error };
  const so = r.document_type === "SO";
  if (so && r.error?.startsWith(UNREADABLE_PREFIX)) return { outcome: "failed", detail: r.error };
  // GR / PI "needs review": done, but no document was made.
  if (!so && !r.doc_no) return { outcome: "failed", detail: r.error ?? "No document was created" };
  if (so && r.so_missing) return { outcome: "discarded", detail: null };
  // Only the SO review records whether the operator edited the read: GR marks
  // every posted scan ACCEPTED, and an edited PI leaves no trace.
  if (!so) return { outcome: "imported", detail: null };
  if (r.sample_status === "ACCEPTED") return { outcome: "clean", detail: null };
  if (r.sample_status === "CONFIRMED") {
    const fields = changedFields(r.extracted, r.corrected);
    return { outcome: "corrected", detail: fields.length ? fields.join(", ") : null };
  }
  return { outcome: "awaiting", detail: null };
}

const HEADER_FIELDS: Array<[string, string]> = [
  ["customerName", "Customer name"],
  ["addressLine1", "Address"],
  ["address", "Address"],
  ["city", "City"],
  ["postcode", "Postcode"],
  ["addressStateMatch", "State"],
  ["phones", "Phone"],
  ["customerSoRef", "Customer ref"],
  ["customerTypeMatch", "Customer type"],
  ["buildingTypeMatch", "Building type"],
  ["paymentMethodMatch", "Payment method"],
  ["bankMatch", "Bank"],
  ["approvalCode", "Approval code"],
  ["depositRm", "Deposit"],
  ["deliveryDate", "Delivery date"],
];
const LINE_FIELDS: Array<[string, string]> = [
  ["skuMatch", "Product code"],
  ["qtyGuess", "Qty"],
  ["fabricMatch", "Fabric code"],
  ["specialsMatch", "Special order"],
];
export const LINES_CHANGED = "Line added/removed";

const j = (v: unknown) => JSON.stringify(v ?? null);
const asObj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/**
 * Which fields the operator changed, read from a CONFIRMED sample.
 * buildCorrectedSlipFromSo (scm/lib/scan-sample-review.ts) overwrites only the
 * keys whose value moved, so a key-by-key compare is the diff.
 */
export function changedFields(extracted: unknown, corrected: unknown): string[] {
  const ai = asObj(extracted);
  const op = asObj(corrected);
  if (!ai || !op) return [];
  const out = new Set<string>();
  for (const [key, label] of HEADER_FIELDS) if (j(ai[key]) !== j(op[key])) out.add(label);
  const aiLines = Array.isArray(ai.lines) ? (ai.lines as Array<Record<string, unknown>>) : [];
  const opLines = Array.isArray(op.lines) ? (op.lines as Array<Record<string, unknown>>) : [];
  if (aiLines.length !== opLines.length) {
    // ponytail: with a line added or removed the per-line fields are not compared;
    // pairing lines would need alignSoLinesToSlip's matching, add it if this hides misses.
    out.add(LINES_CHANGED);
  } else {
    // Compared as sorted lists so the review's line re-ordering is not a change.
    const col = (lines: Array<Record<string, unknown>>, key: string) => lines.map((l) => j(asObj(l)?.[key])).sort().join("|");
    for (const [key, label] of LINE_FIELDS) if (col(aiLines, key) !== col(opLines, key)) out.add(label);
  }
  return [...out];
}

// ── Report ───────────────────────────────────────────────────────────────────

export interface DocTypeStats {
  documentType: string;
  label: string;
  scans: number;
  pending: number;
  failed: number;
  discarded: number;
  awaiting: number;
  clean: number;
  corrected: number;
  imported: number;
  /** clean / (clean + corrected); null where the review is not recorded (GR, PI). */
  accuracy: { clean: number; reviewed: number } | null;
  avgSec: number | null;
  p90Sec: number | null;
}
export interface FieldMiss { field: string; count: number }
export interface ProblemScan {
  id: string;
  at: string;
  documentType: string;
  docNo: string | null;
  outcome: "failed" | "corrected";
  detail: string | null;
}
export interface OcrReport {
  month: string;
  model: string;
  docTypes: DocTypeStats[];
  /** SO only: per field, how many reviewed scans the operator corrected it on. */
  fieldMisses: { reviewed: number; fields: FieldMiss[] };
  problems: ProblemScan[];
}

const PROBLEM_LIMIT = 30;
const iso = (v: string | Date) => new Date(v).toISOString();

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
}

/** Pure: rows (newest first) to the report. */
export function buildOcrReport(month: string, rows: ScanRow[]): OcrReport {
  const byType = new Map<string, DocTypeStats>();
  const secs = new Map<string, number[]>();
  const misses = new Map<string, number>();
  let reviewed = 0;
  const problems: ProblemScan[] = [];

  for (const r of rows) {
    const t = r.document_type;
    let s = byType.get(t);
    if (!s) {
      s = {
        documentType: t, label: isScanDocumentType(t) ? SCAN_DOCUMENT_TYPE_LABEL[t] : t, scans: 0, pending: 0, failed: 0, discarded: 0, awaiting: 0, clean: 0, corrected: 0, imported: 0,
        accuracy: null, avgSec: null, p90Sec: null,
      };
      byType.set(t, s);
      secs.set(t, []);
    }
    const { outcome, detail } = classifyScan(r);
    s.scans++;
    s[outcome]++;
    if (outcome !== "pending") {
      const sec = (new Date(r.updated_at).getTime() - new Date(r.created_at).getTime()) / 1000;
      if (Number.isFinite(sec) && sec >= 0) secs.get(t)!.push(sec);
    }
    if (outcome === "clean" || outcome === "corrected") reviewed++;
    if (outcome === "corrected" && detail) {
      for (const f of detail.split(", ")) misses.set(f, (misses.get(f) ?? 0) + 1);
    }
    if ((outcome === "failed" || outcome === "corrected") && problems.length < PROBLEM_LIMIT) {
      problems.push({ id: r.id, at: iso(r.created_at), documentType: t, docNo: r.doc_no, outcome, detail });
    }
  }

  for (const s of byType.values()) {
    if (s.documentType === "SO") s.accuracy = { clean: s.clean, reviewed: s.clean + s.corrected };
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
    model: CLAUDE_MODEL,
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
    SELECT j.id, j.document_type, j.status, j.error,
           coalesce(j.linked_doc_no, j.so_doc_no) AS doc_no,
           j.created_at, j.updated_at,
           s.status AS sample_status,
           CASE WHEN s.status = 'FAILED' THEN s.extracted->>'error' END AS sample_error,
           CASE WHEN s.status = 'CONFIRMED' THEN s.extracted END AS extracted,
           CASE WHEN s.status = 'CONFIRMED' THEN s.corrected END AS corrected,
           (j.document_type = 'SO' AND j.status = 'done' AND j.so_doc_no IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM scm.mfg_sales_orders so
                              WHERE so.doc_no = j.so_doc_no AND so.company_id = j.company_id)) AS so_missing
      FROM scm.scan_jobs j
      LEFT JOIN scm.so_scan_samples s ON s.id = j.sample_id
     WHERE j.company_id = ${companyId}
       AND j.created_at >= ${startIso}::timestamptz AND j.created_at < ${endIso}::timestamptz
     ORDER BY j.created_at DESC`);
  return buildOcrReport(month, [...rows]);
}
