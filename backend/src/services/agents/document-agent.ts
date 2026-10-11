// ---------------------------------------------------------------------------
// document-agent.ts — the Document Agent's deterministic ENGINE: a daily
// document-flow patrol over the SCM graph (SO→DO→SI→payments sales chain,
// SO→PO→GRN→PI purchase chain — the same edges routes/document-flow.ts maps).
//
// Pattern ported from HOOKKA's compliance-report.ts ("stuck records" sweep:
// per-check try/catch, whole-day grace windows, plain-English rows) and
// delivery-agent.ts (INVOICE_GAP detector). Houzs adaptation: instead of
// regenerating a report each run, the patrol keeps a LIVING WORKLIST in
// document_agent_findings — one OPEN finding per (kind, doc), auto-RESOLVED
// the run its condition stops holding — plus a daily brief snapshot in
// document_agent_briefs (both from migration 0093).
//
// Findings taxonomy (kind → what it means):
//   INVOICE_GAP       delivered DO with no non-cancelled Sales Invoice
//   STUCK_SO          confirmed SO with no non-cancelled DO after N days
//   STALE_DRAFT       DRAFT document older than N days (SO/DO/SI/PO/GRN/PI —
//                     migrations 0040-0044 added DRAFT to DO/SI/PO/GRN/PI;
//                     SO had it already). Scan-origin SO drafts flagged
//                     distinctly (scm.scan_jobs.so_doc_no is the marker).
//   UNPAID_SI         SI with outstanding balance, aged into collection
//                     buckets 0-30 / 31-60 / 61-90 / 90+ days
//   GRN_NO_PI         posted GRN with no non-cancelled Purchase Invoice
//                     after N days
//   PAYMENT_MISMATCH  SO payments-ledger total exceeding the SO total, or an
//                     SI stamped PAID whose paid_centi is short of its total
//
// RED LINES (enforced structurally):
//   * READ-ONLY over business documents — this module never inserts, updates
//     or cancels any scm.* row. It writes ONLY document_agent_findings /
//     document_agent_briefs (public schema, migration 0093).
//   * Deterministic — no LLM calls. The scheduler hands ctx.llmKey to the
//     registered run; the AI narrative layer is wired by the console lead
//     later and sits ON TOP of this engine's JSON, never inside it.
//   * Money is integer sen end-to-end (scm columns are *_centi = sen; the
//     engine's payloads/brief expose them as *Sen).
//   * Every finding carries a one-sentence plain-English summary.
//
// DB handle = env.DB (the d1-compat shim over postgres.js, see db/d1-compat).
// scm tables are schema-qualified (`scm.mfg_sales_orders`) because the shim's
// connection search_path is public. Row reads are dual-keyed
// (r.camelCase ?? r.snake_case) per the house gotcha, though Houzs's pg.ts
// returns snake_case as-is.
// ---------------------------------------------------------------------------

import type { Env } from "../../types";
import { activeInstructions, readAgentSetting } from "../agent-console";
import { registerAgent } from "../agent-scheduler";
import { askAgentBrain, type AgentBrainUsageSink } from "../agent-brain";

// ── Tunables (module-constant defaults; per-key overrides may live in
//    app_settings['agents.document'] as whole-day numbers) ───────────────────

/** Confirmed SO with no DO after this many days → STUCK_SO. */
export const STUCK_SO_DAYS = 14;
/** DRAFT documents older than this many days → STALE_DRAFT. */
export const STALE_DRAFT_DAYS = 3;
/** Posted GRN with no PI after this many days → GRN_NO_PI. */
export const GRN_NO_PI_DAYS = 14;
/** Grace after delivery before an INVOICE_GAP opens (same-day invoicing lag). */
export const INVOICE_GAP_GRACE_DAYS = 1;

/** app_settings key for the Document Agent's tunable day-windows. */
export const DOCUMENT_AGENT_SETTING_KEY = "agents.document";

// Escalation thresholds (days) at which a WARN finding becomes CRIT.
const INVOICE_GAP_CRIT_DAYS = 7;
const STUCK_SO_CRIT_DAYS = 30;
const STALE_DRAFT_WARN_DAYS = 14;
const GRN_NO_PI_CRIT_DAYS = 30;
// An SO overpaid by at least this many sen is CRIT (below: WARN).
const OVERPAY_CRIT_SEN = 10_000; // RM 100

// Per-detector row cap: bounds a first run against a deep backlog. When a
// detector hits its cap the auto-close pass for that kind is SKIPPED that run
// (an uncapped condition may still hold for rows past the cap).
const MAX_FINDINGS_PER_KIND = 500;

export type DocumentFindingKind =
  | "INVOICE_GAP"
  | "STUCK_SO"
  | "STALE_DRAFT"
  | "UNPAID_SI"
  | "GRN_NO_PI"
  | "PAYMENT_MISMATCH";

export type DocumentFindingSeverity = "INFO" | "WARN" | "CRIT";
export type DocumentDocType = "SO" | "DO" | "SI" | "PO" | "GRN" | "PI";

const ALL_KINDS: DocumentFindingKind[] = [
  "INVOICE_GAP",
  "STUCK_SO",
  "STALE_DRAFT",
  "UNPAID_SI",
  "GRN_NO_PI",
  "PAYMENT_MISMATCH",
];

const SEVERITY_RANK: Record<DocumentFindingSeverity, number> = {
  CRIT: 0,
  WARN: 1,
  INFO: 2,
};

export interface DocumentFinding {
  id: string;
  kind: DocumentFindingKind;
  severity: DocumentFindingSeverity;
  docType: DocumentDocType;
  docId: string;
  docNo: string | null;
  summary: string;
  payload: Record<string, unknown>;
  status: "OPEN" | "RESOLVED";
  createdAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
}

export interface DocumentPatrolResult {
  findingsOpened: number;
  findingsClosed: number;
  /** OPEN findings after this patrol, by kind. */
  openByKind: Record<string, number>;
  openTotal: number;
  /** Detectors that hit MAX_FINDINGS_PER_KIND (their auto-close was skipped). */
  cappedKinds: DocumentFindingKind[];
  /** Detectors whose query failed this run (their auto-close was skipped). */
  failedKinds: DocumentFindingKind[];
}

export interface CollectionBucket {
  bucket: "0-30" | "31-60" | "61-90" | "90+";
  invoices: number;
  outstandingSen: number;
}

export interface DocumentBriefUrgentRow {
  kind: DocumentFindingKind;
  severity: DocumentFindingSeverity;
  docType: DocumentDocType;
  docNo: string | null;
  summary: string;
  openedAt: string;
  ageDays: number;
}

export interface DocumentBrief {
  generatedAt: string;
  open: {
    total: number;
    byKind: Record<string, number>;
    bySeverity: Record<string, number>;
  };
  /** Oldest CRIT first, then WARN, then INFO — max 10 rows. */
  topUrgent: DocumentBriefUrgentRow[];
  /** Live AR aging over unpaid SIs (not capped — computed by aggregate SQL). */
  collection: {
    agingBasis: "invoice_date";
    invoices: number;
    totalOutstandingSen: number;
    buckets: CollectionBucket[];
  };
}

export interface DocumentAgentRunResult {
  summary: string;
  brief: DocumentBrief;
  findingsOpened: number;
  findingsClosed: number;
}

export interface DocumentAgentStatus {
  openFindings: number;
  bySeverity: Record<string, number>;
  byKind: Record<string, number>;
  lastBriefAt: string | null;
}

// ── Small helpers ────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;

/** Dual-keyed column read: r.camelCase ?? r.snake_case (house gotcha). */
function col(r: Row, camel: string, snake: string): unknown {
  return r[camel] ?? r[snake];
}

function toIso(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function daysSince(v: unknown, nowMs: number): number {
  const iso = toIso(v);
  if (!iso) return 0;
  return Math.max(0, Math.floor((nowMs - new Date(iso).getTime()) / 86_400_000));
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function str(v: unknown): string {
  return v == null ? "" : String(v);
}

function rm(sen: number): string {
  return `RM ${(sen / 100).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function cutoffIso(days: number, nowMs: number): string {
  return new Date(nowMs - days * 86_400_000).toISOString();
}

/** Whole-day override from app_settings['agents.document'], clamped 0..365. */
async function dayWindow(
  db: D1Database,
  key: string,
  dflt: number,
): Promise<number> {
  const cfg = await readAgentSetting<Record<string, unknown>>(
    db,
    DOCUMENT_AGENT_SETTING_KEY,
  );
  const n = Number(cfg?.[key]);
  if (!Number.isFinite(n) || n < 0 || n > 365) return dflt;
  return Math.floor(n);
}

// A detector's desired finding for THIS patrol pass.
interface DesiredFinding {
  kind: DocumentFindingKind;
  severity: DocumentFindingSeverity;
  docType: DocumentDocType;
  docId: string;
  docNo: string | null;
  summary: string;
  payload: Record<string, unknown>;
}

const keyOf = (kind: string, docType: string, docId: string) =>
  `${kind}|${docType}|${docId}`;

// ── Detectors (pure reads over scm.*) ────────────────────────────────────────
// Each detector returns { rows, capped }. A throwing detector is caught by the
// patrol loop (compliance-report.ts pattern) so one broken query can't sink
// the whole patrol — its kind is reported in failedKinds and its auto-close
// pass is skipped that run.

interface DetectorResult {
  rows: DesiredFinding[];
  capped: boolean;
}

/** INVOICE_GAP — DO delivered with no non-cancelled SI covering it.
 *  "Delivered" = delivered_at stamped OR status SIGNED/DELIVERED/INVOICED
 *  (do_status: DRAFT LOADED DISPATCHED IN_TRANSIT SIGNED DELIVERED INVOICED
 *  CANCELLED). Coverage = si.delivery_order_id header link, OR an SI line
 *  referencing one of the DO's lines (sales_invoice_items.do_item_id), OR an
 *  SI raised straight on the DO's SO (si.so_doc_no) — the same three linkage
 *  paths document-flow.ts walks. */
async function detectInvoiceGap(
  db: D1Database,
  nowMs: number,
): Promise<DetectorResult> {
  const graceDays = await dayWindow(db, "invoiceGapGraceDays", INVOICE_GAP_GRACE_DAYS);
  const res = await db
    .prepare(
      `SELECT d.id, d.do_number, d.so_doc_no, d.status, d.debtor_name,
              d.delivered_at, d.do_date
         FROM scm.delivery_orders d
        WHERE d.status NOT IN ('CANCELLED', 'DRAFT')
          AND (d.delivered_at IS NOT NULL OR d.status IN ('SIGNED', 'DELIVERED', 'INVOICED'))
          AND COALESCE(d.delivered_at, d.do_date::timestamptz) < ?
          AND NOT EXISTS (
                SELECT 1 FROM scm.sales_invoices si
                 WHERE si.status <> 'CANCELLED'
                   AND (si.delivery_order_id = d.id
                        OR (d.so_doc_no IS NOT NULL AND si.so_doc_no = d.so_doc_no)))
          AND NOT EXISTS (
                SELECT 1
                  FROM scm.sales_invoice_items sii
                  JOIN scm.delivery_order_items doi ON doi.id = sii.do_item_id
                  JOIN scm.sales_invoices si2 ON si2.id = sii.sales_invoice_id
                 WHERE doi.delivery_order_id = d.id
                   AND si2.status <> 'CANCELLED')
        ORDER BY COALESCE(d.delivered_at, d.do_date::timestamptz) ASC
        LIMIT ?`,
    )
    .bind(cutoffIso(graceDays, nowMs), MAX_FINDINGS_PER_KIND + 1)
    .all<Row>();
  const raw = res.results ?? [];
  const capped = raw.length > MAX_FINDINGS_PER_KIND;
  const rows = raw.slice(0, MAX_FINDINGS_PER_KIND).map((r): DesiredFinding => {
    const deliveredAt = toIso(col(r, "deliveredAt", "delivered_at")) ?? toIso(col(r, "doDate", "do_date"));
    const age = daysSince(deliveredAt, nowMs);
    const docNo = str(col(r, "doNumber", "do_number")) || null;
    const debtor = str(col(r, "debtorName", "debtor_name"));
    return {
      kind: "INVOICE_GAP",
      severity: age >= INVOICE_GAP_CRIT_DAYS ? "CRIT" : "WARN",
      docType: "DO",
      docId: str(r.id),
      docNo,
      summary: `Delivery order ${docNo ?? str(r.id)}${debtor ? ` (${debtor})` : ""} was delivered ${age} day${age === 1 ? "" : "s"} ago but has no sales invoice.`,
      payload: {
        soDocNo: col(r, "soDocNo", "so_doc_no") ?? null,
        debtorName: debtor || null,
        doStatus: str(r.status),
        deliveredAt,
        daysSinceDelivered: age,
      },
    };
  });
  return { rows, capped };
}

/** STUCK_SO — active pre-delivery SO (CONFIRMED / IN_PRODUCTION /
 *  READY_TO_SHIP) older than N days with no non-cancelled DO, checked via
 *  BOTH linkage paths (delivery_orders.so_doc_no header link and
 *  delivery_order_items.so_item_id line link). DRAFT SOs are the STALE_DRAFT
 *  detector's job; SHIPPED+ SOs have a DO by definition. */
async function detectStuckSo(
  db: D1Database,
  nowMs: number,
): Promise<DetectorResult> {
  const days = await dayWindow(db, "stuckSoDays", STUCK_SO_DAYS);
  const res = await db
    .prepare(
      `SELECT s.doc_no, s.status, s.debtor_name, s.so_date, s.created_at,
              s.local_total_centi
         FROM scm.mfg_sales_orders s
        WHERE s.status IN ('CONFIRMED', 'IN_PRODUCTION', 'READY_TO_SHIP')
          AND s.created_at < ?
          AND NOT EXISTS (
                SELECT 1 FROM scm.delivery_orders d
                 WHERE d.so_doc_no = s.doc_no AND d.status <> 'CANCELLED')
          AND NOT EXISTS (
                SELECT 1
                  FROM scm.mfg_sales_order_items sit
                  JOIN scm.delivery_order_items doi ON doi.so_item_id = sit.id
                  JOIN scm.delivery_orders d2 ON d2.id = doi.delivery_order_id
                 WHERE sit.doc_no = s.doc_no AND d2.status <> 'CANCELLED')
        ORDER BY s.created_at ASC
        LIMIT ?`,
    )
    .bind(cutoffIso(days, nowMs), MAX_FINDINGS_PER_KIND + 1)
    .all<Row>();
  const raw = res.results ?? [];
  const capped = raw.length > MAX_FINDINGS_PER_KIND;
  const rows = raw.slice(0, MAX_FINDINGS_PER_KIND).map((r): DesiredFinding => {
    const docNo = str(col(r, "docNo", "doc_no"));
    const age = daysSince(col(r, "createdAt", "created_at"), nowMs);
    const debtor = str(col(r, "debtorName", "debtor_name"));
    const totalSen = num(col(r, "localTotalCenti", "local_total_centi"));
    return {
      kind: "STUCK_SO",
      severity: age >= STUCK_SO_CRIT_DAYS ? "CRIT" : "WARN",
      docType: "SO",
      docId: docNo,
      docNo,
      summary: `Sales order ${docNo}${debtor ? ` (${debtor})` : ""} has been ${str(r.status).toLowerCase().replace(/_/g, " ")} for ${age} days with no delivery order.`,
      payload: {
        status: str(r.status),
        debtorName: debtor || null,
        soDate: toIso(col(r, "soDate", "so_date")),
        ageDays: age,
        totalSen,
      },
    };
  });
  return { rows, capped };
}

/** STALE_DRAFT — DRAFT documents older than N days across all six doc types.
 *  DRAFT exists on: SO (original enum), and DO/SI/PO/GRN/PI via migrations
 *  0040/0041/0042/0043/0044 (verified: ALTER TYPE ... ADD VALUE 'DRAFT').
 *  SO drafts run as their own query so scan-origin ones (created by the
 *  scan-so background pipeline — scm.scan_jobs.so_doc_no links them) can be
 *  flagged distinctly: an unconfirmed scanned slip is a real showroom sale
 *  nobody has booked yet. */
async function detectStaleDrafts(
  db: D1Database,
  nowMs: number,
): Promise<DetectorResult> {
  const days = await dayWindow(db, "staleDraftDays", STALE_DRAFT_DAYS);
  const cutoff = cutoffIso(days, nowMs);
  const rows: DesiredFinding[] = [];
  let capped = false;

  const soRes = await db
    .prepare(
      `SELECT s.doc_no, s.debtor_name, s.created_at,
              EXISTS (SELECT 1 FROM scm.scan_jobs j WHERE j.so_doc_no = s.doc_no) AS scan_origin
         FROM scm.mfg_sales_orders s
        WHERE s.status = 'DRAFT' AND s.created_at < ?
        ORDER BY s.created_at ASC
        LIMIT ?`,
    )
    .bind(cutoff, MAX_FINDINGS_PER_KIND + 1)
    .all<Row>();
  const soRaw = soRes.results ?? [];
  capped = capped || soRaw.length > MAX_FINDINGS_PER_KIND;
  for (const r of soRaw.slice(0, MAX_FINDINGS_PER_KIND)) {
    const docNo = str(col(r, "docNo", "doc_no"));
    const age = daysSince(col(r, "createdAt", "created_at"), nowMs);
    const debtor = str(col(r, "debtorName", "debtor_name"));
    const scanOrigin = Boolean(col(r, "scanOrigin", "scan_origin"));
    rows.push({
      kind: "STALE_DRAFT",
      severity: age >= STALE_DRAFT_WARN_DAYS ? "WARN" : "INFO",
      docType: "SO",
      docId: docNo,
      docNo,
      summary: scanOrigin
        ? `Scanned draft sales order ${docNo}${debtor ? ` (${debtor})` : ""} has sat unconfirmed for ${age} days — the slip was captured but never booked.`
        : `Draft sales order ${docNo}${debtor ? ` (${debtor})` : ""} has been sitting for ${age} days.`,
      payload: { ageDays: age, scanOrigin, debtorName: debtor || null },
    });
  }

  // DO / SI / PO / GRN / PI drafts in one UNION pass. NULL::text keeps the
  // party column typed across branches.
  const restRes = await db
    .prepare(
      `SELECT 'DO' AS doc_type, d.id::text AS doc_id, d.do_number AS doc_no, d.debtor_name AS party, d.created_at
         FROM scm.delivery_orders d WHERE d.status = 'DRAFT' AND d.created_at < ?1
       UNION ALL
       SELECT 'SI', si.id::text, si.invoice_number, si.debtor_name, si.created_at
         FROM scm.sales_invoices si WHERE si.status = 'DRAFT' AND si.created_at < ?1
       UNION ALL
       SELECT 'PO', po.id::text, po.po_number, NULL::text, po.created_at
         FROM scm.purchase_orders po WHERE po.status = 'DRAFT' AND po.created_at < ?1
       UNION ALL
       SELECT 'GRN', g.id::text, g.grn_number, NULL::text, g.created_at
         FROM scm.grns g WHERE g.status = 'DRAFT' AND g.created_at < ?1
       UNION ALL
       SELECT 'PI', pi.id::text, pi.invoice_number, NULL::text, pi.created_at
         FROM scm.purchase_invoices pi WHERE pi.status = 'DRAFT' AND pi.created_at < ?1
       ORDER BY created_at ASC
       LIMIT ?2`,
    )
    .bind(cutoff, MAX_FINDINGS_PER_KIND + 1)
    .all<Row>();
  const restRaw = restRes.results ?? [];
  capped = capped || restRaw.length > MAX_FINDINGS_PER_KIND;
  const DOC_LABEL: Record<string, string> = {
    DO: "delivery order",
    SI: "sales invoice",
    PO: "purchase order",
    GRN: "goods received note",
    PI: "purchase invoice",
  };
  for (const r of restRaw.slice(0, MAX_FINDINGS_PER_KIND)) {
    const docType = str(col(r, "docType", "doc_type")) as DocumentDocType;
    const docId = str(col(r, "docId", "doc_id"));
    const docNo = str(col(r, "docNo", "doc_no")) || null;
    const party = str(r.party);
    const age = daysSince(col(r, "createdAt", "created_at"), nowMs);
    rows.push({
      kind: "STALE_DRAFT",
      severity: age >= STALE_DRAFT_WARN_DAYS ? "WARN" : "INFO",
      docType,
      docId,
      docNo,
      summary: `Draft ${DOC_LABEL[docType] ?? docType} ${docNo ?? docId}${party ? ` (${party})` : ""} has been sitting for ${age} days.`,
      payload: { ageDays: age, scanOrigin: false, party: party || null },
    });
  }
  return { rows, capped };
}

/** UNPAID_SI — SI with an outstanding balance, aged from invoice_date into
 *  the collection buckets. sales_invoice_status: DRAFT SENT PARTIALLY_PAID
 *  PAID OVERDUE CANCELLED — DRAFT excluded (no AR posted yet; same leak-guard
 *  outstanding.ts applies), PAID/CANCELLED have nothing to collect.
 *  Outstanding = total_centi - paid_centi (paid_centi is the header stamp the
 *  SI payment routes maintain). One finding per SI; the bucket/severity
 *  refresh in place as the invoice ages. */
async function detectUnpaidSi(
  db: D1Database,
  nowMs: number,
): Promise<DetectorResult> {
  const res = await db
    .prepare(
      `SELECT si.id, si.invoice_number, si.status, si.debtor_name,
              si.invoice_date, si.due_date, si.total_centi, si.paid_centi
         FROM scm.sales_invoices si
        WHERE si.status IN ('SENT', 'PARTIALLY_PAID', 'OVERDUE')
          AND (si.total_centi - si.paid_centi) > 0
        ORDER BY si.invoice_date ASC
        LIMIT ?`,
    )
    .bind(MAX_FINDINGS_PER_KIND + 1)
    .all<Row>();
  const raw = res.results ?? [];
  const capped = raw.length > MAX_FINDINGS_PER_KIND;
  const rows = raw.slice(0, MAX_FINDINGS_PER_KIND).map((r): DesiredFinding => {
    const age = daysSince(col(r, "invoiceDate", "invoice_date"), nowMs);
    const bucket: CollectionBucket["bucket"] =
      age <= 30 ? "0-30" : age <= 60 ? "31-60" : age <= 90 ? "61-90" : "90+";
    const severity: DocumentFindingSeverity =
      age > 90 ? "CRIT" : age > 30 ? "WARN" : "INFO";
    const totalSen = num(col(r, "totalCenti", "total_centi"));
    const paidSen = num(col(r, "paidCenti", "paid_centi"));
    const outstandingSen = totalSen - paidSen;
    const docNo = str(col(r, "invoiceNumber", "invoice_number")) || null;
    const debtor = str(col(r, "debtorName", "debtor_name"));
    return {
      kind: "UNPAID_SI",
      severity,
      docType: "SI",
      docId: str(r.id),
      docNo,
      summary: `Invoice ${docNo ?? str(r.id)}${debtor ? ` (${debtor})` : ""} still has ${rm(outstandingSen)} outstanding after ${age} days (${bucket} bucket).`,
      payload: {
        debtorName: debtor || null,
        siStatus: str(r.status),
        invoiceDate: toIso(col(r, "invoiceDate", "invoice_date")),
        dueDate: toIso(col(r, "dueDate", "due_date")),
        totalSen,
        paidSen,
        outstandingSen,
        ageDays: age,
        bucket,
      },
    };
  });
  return { rows, capped };
}

/** GRN_NO_PI — GRN posted N+ days ago with no non-cancelled Purchase Invoice,
 *  via BOTH linkage paths (purchase_invoices.grn_id header link and
 *  purchase_invoice_items.grn_item_id line link — the document-flow edges).
 *  grn_status: DRAFT POSTED CLOSED CANCELLED — DRAFT/CANCELLED skipped. */
async function detectGrnNoPi(
  db: D1Database,
  nowMs: number,
): Promise<DetectorResult> {
  const days = await dayWindow(db, "grnNoPiDays", GRN_NO_PI_DAYS);
  const res = await db
    .prepare(
      `SELECT g.id, g.grn_number, g.status, g.received_at, g.total_centi
         FROM scm.grns g
        WHERE g.status NOT IN ('CANCELLED', 'DRAFT')
          AND g.received_at < ?
          AND NOT EXISTS (
                SELECT 1 FROM scm.purchase_invoices pi
                 WHERE pi.grn_id = g.id AND pi.status <> 'CANCELLED')
          AND NOT EXISTS (
                SELECT 1
                  FROM scm.purchase_invoice_items pii
                  JOIN scm.grn_items gi ON gi.id = pii.grn_item_id
                  JOIN scm.purchase_invoices pi2 ON pi2.id = pii.purchase_invoice_id
                 WHERE gi.grn_id = g.id AND pi2.status <> 'CANCELLED')
        ORDER BY g.received_at ASC
        LIMIT ?`,
    )
    .bind(cutoffIso(days, nowMs).slice(0, 10), MAX_FINDINGS_PER_KIND + 1)
    .all<Row>();
  const raw = res.results ?? [];
  const capped = raw.length > MAX_FINDINGS_PER_KIND;
  const rows = raw.slice(0, MAX_FINDINGS_PER_KIND).map((r): DesiredFinding => {
    const age = daysSince(col(r, "receivedAt", "received_at"), nowMs);
    const docNo = str(col(r, "grnNumber", "grn_number")) || null;
    const totalSen = num(col(r, "totalCenti", "total_centi"));
    return {
      kind: "GRN_NO_PI",
      severity: age >= GRN_NO_PI_CRIT_DAYS ? "CRIT" : "WARN",
      docType: "GRN",
      docId: str(r.id),
      docNo,
      summary: `Goods received note ${docNo ?? str(r.id)} was received ${age} days ago but the supplier invoice has not been recorded.`,
      payload: {
        grnStatus: str(r.status),
        receivedAt: toIso(col(r, "receivedAt", "received_at")),
        ageDays: age,
        totalSen,
      },
    };
  });
  return { rows, capped };
}

/** PAYMENT_MISMATCH — two cheap header-level integrity checks:
 *   (a) SO overpaid: SUM(mfg_sales_order_payments.amount_centi) exceeds the
 *       SO's local_total_centi (the exact total/paid pair the SO routes'
 *       processing-date payment gate compares). DRAFT/CANCELLED SOs excluded
 *       (drafts are still being priced — comparing them is noise).
 *   (b) SI stamped PAID whose paid_centi is short of total_centi.
 *  SKIPPED (deliberately, schema verified): reconciling si.paid_centi against
 *  SUM(scm.sales_invoice_payments.amount_centi) — customer credits (2990 mig
 *  0110 customer_credits) apply against invoices OUTSIDE that ledger, so the
 *  sums legitimately diverge and the check would cry wolf. */
async function detectPaymentMismatch(
  db: D1Database,
  _nowMs: number,
): Promise<DetectorResult> {
  const rows: DesiredFinding[] = [];
  let capped = false;

  const soRes = await db
    .prepare(
      `SELECT s.doc_no, s.debtor_name, s.status, s.local_total_centi,
              p.paid AS paid_centi
         FROM scm.mfg_sales_orders s
         JOIN (SELECT so_doc_no, SUM(amount_centi) AS paid
                 FROM scm.mfg_sales_order_payments
                GROUP BY so_doc_no) p ON p.so_doc_no = s.doc_no
        WHERE s.status NOT IN ('CANCELLED', 'DRAFT')
          AND p.paid > s.local_total_centi
        ORDER BY p.paid - s.local_total_centi DESC
        LIMIT ?`,
    )
    .bind(MAX_FINDINGS_PER_KIND + 1)
    .all<Row>();
  const soRaw = soRes.results ?? [];
  capped = capped || soRaw.length > MAX_FINDINGS_PER_KIND;
  for (const r of soRaw.slice(0, MAX_FINDINGS_PER_KIND)) {
    const docNo = str(col(r, "docNo", "doc_no"));
    const totalSen = num(col(r, "localTotalCenti", "local_total_centi"));
    const paidSen = num(col(r, "paidCenti", "paid_centi"));
    const diffSen = paidSen - totalSen;
    const debtor = str(col(r, "debtorName", "debtor_name"));
    rows.push({
      kind: "PAYMENT_MISMATCH",
      severity: diffSen >= OVERPAY_CRIT_SEN ? "CRIT" : "WARN",
      docType: "SO",
      docId: docNo,
      docNo,
      summary: `Sales order ${docNo}${debtor ? ` (${debtor})` : ""} has collected ${rm(paidSen)} against a ${rm(totalSen)} total — ${rm(diffSen)} over.`,
      payload: {
        variant: "SO_OVERPAID",
        debtorName: debtor || null,
        soStatus: str(r.status),
        totalSen,
        paidSen,
        diffSen,
      },
    });
  }

  const siRes = await db
    .prepare(
      `SELECT si.id, si.invoice_number, si.debtor_name, si.total_centi, si.paid_centi
         FROM scm.sales_invoices si
        WHERE si.status = 'PAID' AND si.paid_centi < si.total_centi
        ORDER BY si.total_centi - si.paid_centi DESC
        LIMIT ?`,
    )
    .bind(MAX_FINDINGS_PER_KIND + 1)
    .all<Row>();
  const siRaw = siRes.results ?? [];
  capped = capped || siRaw.length > MAX_FINDINGS_PER_KIND;
  for (const r of siRaw.slice(0, MAX_FINDINGS_PER_KIND)) {
    const docNo = str(col(r, "invoiceNumber", "invoice_number")) || null;
    const totalSen = num(col(r, "totalCenti", "total_centi"));
    const paidSen = num(col(r, "paidCenti", "paid_centi"));
    const debtor = str(col(r, "debtorName", "debtor_name"));
    rows.push({
      kind: "PAYMENT_MISMATCH",
      severity: "CRIT",
      docType: "SI",
      docId: str(r.id),
      docNo,
      summary: `Invoice ${docNo ?? str(r.id)}${debtor ? ` (${debtor})` : ""} is marked paid but only ${rm(paidSen)} of ${rm(totalSen)} has been recorded.`,
      payload: {
        variant: "SI_PAID_SHORT",
        debtorName: debtor || null,
        totalSen,
        paidSen,
        diffSen: totalSen - paidSen,
      },
    });
  }
  return { rows, capped };
}

// ── Patrol: reconcile desired findings against the OPEN worklist ────────────

interface OpenFindingRow {
  id: string;
  kind: string;
  severity: string;
  summary: string;
  docType: string;
  docId: string;
}

async function loadOpenFindings(
  db: D1Database,
): Promise<Map<string, OpenFindingRow>> {
  const res = await db
    .prepare(
      `SELECT id, kind, severity, summary, doc_type, doc_id
         FROM document_agent_findings
        WHERE status = 'OPEN'`,
    )
    .all<Row>();
  const map = new Map<string, OpenFindingRow>();
  for (const r of res.results ?? []) {
    const row: OpenFindingRow = {
      id: str(r.id),
      kind: str(r.kind),
      severity: str(r.severity),
      summary: str(r.summary),
      docType: str(col(r, "docType", "doc_type")),
      docId: str(col(r, "docId", "doc_id")),
    };
    map.set(keyOf(row.kind, row.docType, row.docId), row);
  }
  return map;
}

/**
 * Sweep the document graph and persist findings in document_agent_findings.
 * Dedupe: at most one OPEN finding per (kind, doc_type, doc_id) — an already-
 * open finding is refreshed in place (severity / summary / payload /
 * last_seen_at), a new condition opens a row, and an open finding whose
 * condition no longer holds is auto-RESOLVED. Read-only over scm.* documents.
 */
export async function patrolDocuments(env: Env): Promise<DocumentPatrolResult> {
  const db = env.DB;
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();

  const detectors: Array<
    [DocumentFindingKind, (db: D1Database, nowMs: number) => Promise<DetectorResult>]
  > = [
    ["INVOICE_GAP", detectInvoiceGap],
    ["STUCK_SO", detectStuckSo],
    ["STALE_DRAFT", detectStaleDrafts],
    ["UNPAID_SI", detectUnpaidSi],
    ["GRN_NO_PI", detectGrnNoPi],
    ["PAYMENT_MISMATCH", detectPaymentMismatch],
  ];

  const desired = new Map<string, DesiredFinding>();
  const cappedKinds: DocumentFindingKind[] = [];
  const failedKinds: DocumentFindingKind[] = [];
  for (const [kind, detect] of detectors) {
    try {
      const { rows, capped } = await detect(db, nowMs);
      if (capped) cappedKinds.push(kind);
      for (const f of rows) desired.set(keyOf(f.kind, f.docType, f.docId), f);
    } catch (e) {
      // One broken query must not sink the patrol (compliance-report.ts
      // pattern). The kind's auto-close is skipped below — never mass-resolve
      // on a detector error.
      console.warn(`[document-agent] ${kind} detector failed:`, e);
      failedKinds.push(kind);
    }
  }

  const open = await loadOpenFindings(db);

  let findingsOpened = 0;
  for (const [key, f] of desired) {
    const ex = open.get(key);
    if (!ex) {
      // ON CONFLICT (partial unique index) makes a concurrent double-run a
      // no-op instead of a constraint 500.
      await db
        .prepare(
          `INSERT INTO document_agent_findings
             (id, kind, severity, doc_type, doc_id, doc_no, summary, payload,
              status, created_at, last_seen_at)
           VALUES (?,?,?,?,?,?,?,?, 'OPEN', ?, ?)
           ON CONFLICT (kind, doc_type, doc_id) WHERE status = 'OPEN' DO NOTHING`,
        )
        .bind(
          crypto.randomUUID(),
          f.kind,
          f.severity,
          f.docType,
          f.docId,
          f.docNo,
          f.summary,
          JSON.stringify(f.payload),
          nowIso,
          nowIso,
        )
        .run();
      findingsOpened++;
    } else {
      // Refresh in place — the aging detectors (UNPAID_SI bucket, WARN→CRIT
      // escalations) change severity/summary as the doc sits.
      await db
        .prepare(
          `UPDATE document_agent_findings
              SET severity = ?, summary = ?, payload = ?, last_seen_at = ?
            WHERE id = ? AND status = 'OPEN'`,
        )
        .bind(f.severity, f.summary, JSON.stringify(f.payload), nowIso, ex.id)
        .run();
    }
  }

  // Auto-close: an OPEN finding whose condition no longer holds. Skipped for
  // kinds that errored or hit their cap this run (absence isn't evidence).
  const skipClose = new Set<string>([...cappedKinds, ...failedKinds]);
  let findingsClosed = 0;
  for (const [key, ex] of open) {
    if (desired.has(key)) continue;
    if (!ALL_KINDS.includes(ex.kind as DocumentFindingKind)) continue;
    if (skipClose.has(ex.kind)) continue;
    await db
      .prepare(
        `UPDATE document_agent_findings
            SET status = 'RESOLVED', resolved_at = ?, last_seen_at = ?
          WHERE id = ? AND status = 'OPEN'`,
      )
      .bind(nowIso, nowIso, ex.id)
      .run();
    findingsClosed++;
  }

  const openByKind: Record<string, number> = {};
  for (const f of desired.values()) {
    openByKind[f.kind] = (openByKind[f.kind] ?? 0) + 1;
  }
  // Kinds that errored keep their previously-open rows — count them back in.
  for (const ex of open.values()) {
    if (failedKinds.includes(ex.kind as DocumentFindingKind)) {
      openByKind[ex.kind] = (openByKind[ex.kind] ?? 0) + 1;
    }
  }
  const openTotal = Object.values(openByKind).reduce((s, n) => s + n, 0);

  return { findingsOpened, findingsClosed, openByKind, openTotal, cappedKinds, failedKinds };
}

// ── Daily brief ──────────────────────────────────────────────────────────────

/**
 * Build the daily brief JSON from the OPEN findings plus a live (uncapped)
 * AR-aging aggregate, and persist a snapshot into document_agent_briefs.
 */
export async function collectDocumentBrief(env: Env): Promise<DocumentBrief> {
  const db = env.DB;
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();

  const res = await db
    .prepare(
      `SELECT kind, severity, doc_type, doc_no, summary, created_at
         FROM document_agent_findings
        WHERE status = 'OPEN'`,
    )
    .all<Row>();
  const openRows = res.results ?? [];

  const byKind: Record<string, number> = {};
  const bySeverity: Record<string, number> = {};
  const urgents: DocumentBriefUrgentRow[] = [];
  for (const r of openRows) {
    const kind = str(r.kind) as DocumentFindingKind;
    const severity = str(r.severity) as DocumentFindingSeverity;
    byKind[kind] = (byKind[kind] ?? 0) + 1;
    bySeverity[severity] = (bySeverity[severity] ?? 0) + 1;
    const openedAt = toIso(col(r, "createdAt", "created_at")) ?? nowIso;
    urgents.push({
      kind,
      severity,
      docType: str(col(r, "docType", "doc_type")) as DocumentDocType,
      docNo: (str(col(r, "docNo", "doc_no")) || null),
      summary: str(r.summary),
      openedAt,
      ageDays: daysSince(openedAt, nowMs),
    });
  }
  urgents.sort((a, b) => {
    const s = (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9);
    if (s !== 0) return s;
    return a.openedAt.localeCompare(b.openedAt); // oldest first
  });

  // Collection aging — ONE aggregate pass over ALL unpaid SIs (never capped;
  // the totals must be complete even when the UNPAID_SI findings list is).
  // Aging basis = invoice_date (B2C retail: invoices fall due at delivery;
  // due_date is often unset). now()::date - invoice_date is integer days.
  let collection: DocumentBrief["collection"] = {
    agingBasis: "invoice_date",
    invoices: 0,
    totalOutstandingSen: 0,
    buckets: [
      { bucket: "0-30", invoices: 0, outstandingSen: 0 },
      { bucket: "31-60", invoices: 0, outstandingSen: 0 },
      { bucket: "61-90", invoices: 0, outstandingSen: 0 },
      { bucket: "90+", invoices: 0, outstandingSen: 0 },
    ],
  };
  try {
    const aging = await db
      .prepare(
        `SELECT COUNT(*) AS invoices,
                COALESCE(SUM(si.total_centi - si.paid_centi), 0) AS total_out,
                SUM(CASE WHEN now()::date - si.invoice_date <= 30 THEN 1 ELSE 0 END) AS c1,
                COALESCE(SUM(CASE WHEN now()::date - si.invoice_date <= 30 THEN si.total_centi - si.paid_centi ELSE 0 END), 0) AS s1,
                SUM(CASE WHEN now()::date - si.invoice_date BETWEEN 31 AND 60 THEN 1 ELSE 0 END) AS c2,
                COALESCE(SUM(CASE WHEN now()::date - si.invoice_date BETWEEN 31 AND 60 THEN si.total_centi - si.paid_centi ELSE 0 END), 0) AS s2,
                SUM(CASE WHEN now()::date - si.invoice_date BETWEEN 61 AND 90 THEN 1 ELSE 0 END) AS c3,
                COALESCE(SUM(CASE WHEN now()::date - si.invoice_date BETWEEN 61 AND 90 THEN si.total_centi - si.paid_centi ELSE 0 END), 0) AS s3,
                SUM(CASE WHEN now()::date - si.invoice_date > 90 THEN 1 ELSE 0 END) AS c4,
                COALESCE(SUM(CASE WHEN now()::date - si.invoice_date > 90 THEN si.total_centi - si.paid_centi ELSE 0 END), 0) AS s4
           FROM scm.sales_invoices si
          WHERE si.status IN ('SENT', 'PARTIALLY_PAID', 'OVERDUE')
            AND (si.total_centi - si.paid_centi) > 0`,
      )
      .first<Row>();
    if (aging) {
      collection = {
        agingBasis: "invoice_date",
        invoices: num(aging.invoices),
        totalOutstandingSen: num(col(aging, "totalOut", "total_out")),
        buckets: [
          { bucket: "0-30", invoices: num(aging.c1), outstandingSen: num(aging.s1) },
          { bucket: "31-60", invoices: num(aging.c2), outstandingSen: num(aging.s2) },
          { bucket: "61-90", invoices: num(aging.c3), outstandingSen: num(aging.s3) },
          { bucket: "90+", invoices: num(aging.c4), outstandingSen: num(aging.s4) },
        ],
      };
    }
  } catch (e) {
    console.warn("[document-agent] collection aging query failed:", e);
  }

  const brief: DocumentBrief = {
    generatedAt: nowIso,
    open: { total: openRows.length, byKind, bySeverity },
    topUrgent: urgents.slice(0, 10),
    collection,
  };

  try {
    await db
      .prepare(
        "INSERT INTO document_agent_briefs (id, generated_at, brief) VALUES (?,?,?)",
      )
      .bind(crypto.randomUUID(), nowIso, JSON.stringify(brief))
      .run();
  } catch (e) {
    // A failed snapshot must not sink the run — the brief still returns.
    console.warn("[document-agent] brief snapshot insert failed:", e);
  }

  return brief;
}

// ── Orchestration ────────────────────────────────────────────────────────────

/**
 * One full Document Agent run: patrol the graph, then snapshot the brief.
 * Returns the console summary line plus the brief JSON. Deterministic — the
 * AI narrative layer (askAgentBrain over this JSON) is wired by the console
 * lead and never gates the engine.
 */
export async function runDocumentAgent(env: Env): Promise<DocumentAgentRunResult> {
  const patrol = await patrolDocuments(env);
  const brief = await collectDocumentBrief(env);
  const crit = brief.open.bySeverity["CRIT"] ?? 0;
  const parts = [
    `${brief.open.total} open finding${brief.open.total === 1 ? "" : "s"} (${patrol.findingsOpened} new, ${patrol.findingsClosed} resolved${crit ? `, ${crit} critical` : ""})`,
    `${rm(brief.collection.totalOutstandingSen)} outstanding across ${brief.collection.invoices} unpaid invoice${brief.collection.invoices === 1 ? "" : "s"}`,
  ];
  if (patrol.failedKinds.length) {
    parts.push(`${patrol.failedKinds.join("/")} check errored`);
  }
  const summary = `Document patrol: ${parts.join("; ")}.`;
  return {
    summary,
    brief,
    findingsOpened: patrol.findingsOpened,
    findingsClosed: patrol.findingsClosed,
  };
}

/** Cheap counters for the Agent Console card — two indexed queries, no scans
 *  over business documents. */
export async function documentAgentStatus(env: Env): Promise<DocumentAgentStatus> {
  const db = env.DB;
  const bySeverity: Record<string, number> = { CRIT: 0, WARN: 0, INFO: 0 };
  const byKind: Record<string, number> = {};
  let openFindings = 0;
  try {
    const res = await db
      .prepare(
        `SELECT kind, severity, COUNT(*) AS n
           FROM document_agent_findings
          WHERE status = 'OPEN'
          GROUP BY kind, severity`,
      )
      .all<Row>();
    for (const r of res.results ?? []) {
      const n = num(r.n);
      openFindings += n;
      bySeverity[str(r.severity)] = (bySeverity[str(r.severity)] ?? 0) + n;
      byKind[str(r.kind)] = (byKind[str(r.kind)] ?? 0) + n;
    }
  } catch {
    /* table not migrated yet — zeros */
  }
  let lastBriefAt: string | null = null;
  try {
    const r = await db
      .prepare("SELECT MAX(generated_at) AS last FROM document_agent_briefs")
      .first<Row>();
    lastBriefAt = r?.last == null ? null : str(r.last);
  } catch {
    /* zeros */
  }
  return { openFindings, bySeverity, byKind, lastBriefAt };
}

// ── Scheduler registration (agent-scheduler.ts REGISTRATION POINT) ──────────
// Module-load side effect by design: importing this file (routes/agent-console
// imports the engines) puts the Document Agent on the heartbeat. The run is
// the pure engine; ctx.llmKey is deliberately unused here — the AI paragraph
// over the brief is the console lead's wiring, on top of, never inside, the
// deterministic engine.

// The Document Agent's brain voice — one paragraph of judgment over the
// deterministic patrol brief, mirroring the other families' maybeAiFocus pass.
const DOCUMENT_FOCUS_SYSTEM = [
  "You are the Document Agent of Houzs, a Malaysian B2C furniture retailer. You",
  "run a daily document-flow patrol over the SO->DO->SI->payment and",
  "SO->PO->GRN->PI chains and keep a living worklist of findings (all money in",
  "sen, RM x100). Write ONE short paragraph (3-5 sentences, plain English, no",
  "markdown, no emoji) telling the owner what to chase first today: the most",
  "critical open findings (delivered DOs missing an invoice, stuck SOs, payment",
  "mismatches) and how much collection money is aging. Judgment and",
  "prioritisation only — never invent numbers not in the payload. Honour",
  "ownerInstructions when present.",
].join(" ");

/** Pre-compact the brief for the brain — counts and top rows, never tables. */
function compactDocumentBrief(b: DocumentBrief) {
  return {
    generatedAt: b.generatedAt,
    open: b.open,
    topUrgent: b.topUrgent.slice(0, 5),
    collection: {
      invoices: b.collection.invoices,
      totalOutstandingSen: b.collection.totalOutstandingSen,
      buckets: b.collection.buckets,
    },
  };
}

/** Write the brain paragraph onto the newest brief snapshot (generated_at
 *  ordered — the Document brief table's timestamp column). */
async function writeDocumentAiFocus(env: Env, focus: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE document_agent_briefs SET ai_focus = ?
      WHERE id = (SELECT id FROM document_agent_briefs ORDER BY generated_at DESC LIMIT 1)`,
  )
    .bind(focus)
    .run();
}

registerAgent({
  family: "DOCUMENT",
  task: "document-run",
  cadence: { firstRunHour: 9, minGapHours: 4, maxRunsPerDay: 3 },
  // Event-driven extra trigger: fresh deliveries mean fresh invoice-coverage
  // exposure — the money-critical detector. Pure read.
  shouldRunExtra: async (db, sinceIso) => {
    const r = await db
      .prepare(
        `SELECT COUNT(*) AS n FROM scm.delivery_orders
          WHERE delivered_at IS NOT NULL AND delivered_at > ?
            AND status <> 'CANCELLED'`,
      )
      .bind(sinceIso)
      .first<Row>();
    const n = num(r?.n);
    return n > 0
      ? { fire: true, reason: `${n} deliver${n === 1 ? "y" : "ies"} since last run — re-checking invoice coverage` }
      : { fire: false, reason: "no new deliveries since last run" };
  },
  run: async (env, ctx) => {
    const r = await runDocumentAgent(env);

    // AI focus — first run of the day only. ctx.llmKey is already budget-gated
    // (llmKeyIfBudgetAllows) and undefined otherwise. Fails open to NULL: a
    // brain failure never sinks the deterministic patrol.
    if (ctx.llmKey) {
      const sink: AgentBrainUsageSink = { tokensIn: 0, tokensOut: 0 };
      const ownerInstructions = await activeInstructions(env.DB, "DOCUMENT");
      const focus = await askAgentBrain(ctx.llmKey, {
        system: DOCUMENT_FOCUS_SYSTEM,
        payload: { brief: compactDocumentBrief(r.brief), ownerInstructions },
        maxTokens: 400,
        usageSink: sink,
      });
      ctx.addTokens(sink.tokensIn, sink.tokensOut);
      if (focus) {
        await writeDocumentAiFocus(env, focus).catch((e) =>
          console.warn("[document-agent] ai_focus write failed:", e),
        );
      }
    }

    return r.summary;
  },
});
