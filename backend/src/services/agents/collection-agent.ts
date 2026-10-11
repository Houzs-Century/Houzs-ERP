// ---------------------------------------------------------------------------
// collection-agent.ts — the Collection Agent's deterministic ENGINE: a daily
// accounts-receivable sweep that turns every unpaid sales invoice into an
// actionable per-DEBTOR chase, plus a live AR-aging brief.
//
// The owner asked for Collection as its OWN family (not folded into Document).
// Where the Document Agent's UNPAID_SI finding flags one invoice at a time,
// the Collection Agent works the way a credit-control clerk does: it groups a
// debtor's overdue invoices together, ranks debtors by how much and how long
// they owe, and proposes ONE chase per debtor with everything the office needs
// to make the call. It shares nothing but the source table with Document — the
// two never write each other's rows.
//
// The engine only:
//   1. generateCollectionProposals — writes PENDING DEBTOR_CHASE rows into
//      collection_agent_proposals (migration 0094), one per debtor with
//      outstanding AR past the chase threshold. `key` = debtor handle, so a
//      debtor already on the worklist is never duplicated.
//   2. collectCollectionBrief — today's AR picture (total outstanding, aging
//      buckets, worst debtors, DSO-style oldest-invoice age) + a snapshot row
//      in collection_agent_briefs.
//   3. runCollectionAgent — orchestrates 1-2 for the scheduler.
//   4. collectionAgentStatus — cheap counters for the console card.
//
// RED LINES (enforced structurally):
//   - PROPOSAL-ONLY: approving a chase marks it ready for the office / Mail
//     Center to send. This module NEVER contacts a customer, sends a message,
//     or edits any scm.* invoice/payment. It writes ONLY
//     collection_agent_proposals + collection_agent_briefs (public schema).
//   - Deterministic — no LLM calls. ai_focus over the brief is the lead's
//     shared-brain pass, on top of this engine's JSON, never inside it.
//   - Money is integer sen end-to-end (scm columns are *_centi = sen; the
//     engine's payloads/brief expose them as *Sen).
//
// DB handle = env.DB (the d1-compat shim over postgres.js). scm tables are
// schema-qualified (scm.sales_invoices) because the shim's search_path is
// public. Row reads are dual-keyed (r.camelCase ?? r.snake_case) per the
// house gotcha, though Houzs's pg.ts returns snake_case as-is.
// ---------------------------------------------------------------------------

import type { Env } from "../../types";
import { readAgentSetting } from "../agent-console";

// ── Tunables (app_settings['agents.collection']) ─────────────────────────────

/** An invoice younger than this many days (from invoice_date) is not chased
 *  yet — B2C retail invoices fall due at delivery, so the default chases from
 *  day one overdue. Owner-editable; bounded 0..90. */
export const DEFAULT_CHASE_THRESHOLD_DAYS = 1;

/** app_settings key for the Collection Agent's tunables. */
export const COLLECTION_AGENT_SETTING_KEY = "agents.collection";

/** A debtor owing at least this many sen across all invoices is CRIT. */
const DEBTOR_CRIT_OUTSTANDING_SEN = 500_000; // RM 5,000
/** A debtor with any invoice past this age is CRIT regardless of value. */
const DEBTOR_CRIT_AGE_DAYS = 90;

/** Bound a first run against a deep backlog. */
const MAX_DEBTORS = 500;

export type CollectionBucket = "0-30" | "31-60" | "61-90" | "90+";
export type CollectionSeverity = "INFO" | "WARN" | "CRIT";

// ── Small helpers (mirrors document-agent.ts) ────────────────────────────────

type Row = Record<string, unknown>;

function col(r: Row, camel: string, snake: string): unknown {
  return r[camel] ?? r[snake];
}
function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function str(v: unknown): string {
  return v == null ? "" : String(v);
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
function rm(sen: number): string {
  return `RM ${(sen / 100).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function bucketOf(age: number): CollectionBucket {
  return age <= 30 ? "0-30" : age <= 60 ? "31-60" : age <= 90 ? "61-90" : "90+";
}

/** Whole-day tunable from app_settings['agents.collection'], clamped 0..90. */
async function chaseThresholdDays(db: D1Database): Promise<number> {
  const cfg = await readAgentSetting<Record<string, unknown>>(
    db,
    COLLECTION_AGENT_SETTING_KEY,
  );
  const n = Number(cfg?.chaseThresholdDays);
  if (!Number.isFinite(n) || n < 0 || n > 90) return DEFAULT_CHASE_THRESHOLD_DAYS;
  return Math.floor(n);
}

// ── Source read: unpaid invoices (the one scm.* query) ───────────────────────
// sales_invoice_status: DRAFT SENT PARTIALLY_PAID PAID OVERDUE CANCELLED.
// DRAFT excluded (no AR posted), PAID/CANCELLED have nothing to collect —
// the same leak-guard the Document Agent's UNPAID_SI detector uses. Outstanding
// = total_centi - paid_centi (paid_centi is the header stamp the SI payment
// routes maintain).

interface UnpaidInvoice {
  siId: string;
  invoiceNo: string | null;
  debtorName: string;
  status: string;
  invoiceDate: string | null;
  dueDate: string | null;
  totalSen: number;
  paidSen: number;
  outstandingSen: number;
  ageDays: number;
  bucket: CollectionBucket;
}

async function loadUnpaidInvoices(
  db: D1Database,
  nowMs: number,
  thresholdDays: number,
): Promise<UnpaidInvoice[]> {
  const cutoffIso = new Date(nowMs - thresholdDays * 86_400_000).toISOString();
  const res = await db
    .prepare(
      `SELECT si.id, si.invoice_number, si.status, si.debtor_name,
              si.invoice_date, si.due_date, si.total_centi, si.paid_centi
         FROM scm.sales_invoices si
        WHERE si.status IN ('SENT', 'PARTIALLY_PAID', 'OVERDUE')
          AND (si.total_centi - si.paid_centi) > 0
          AND si.invoice_date::timestamptz <= ?
        ORDER BY si.invoice_date ASC`,
    )
    .bind(cutoffIso)
    .all<Row>();
  return (res.results ?? []).map((r): UnpaidInvoice => {
    const age = daysSince(col(r, "invoiceDate", "invoice_date"), nowMs);
    const totalSen = num(col(r, "totalCenti", "total_centi"));
    const paidSen = num(col(r, "paidCenti", "paid_centi"));
    return {
      siId: str(r.id),
      invoiceNo: str(col(r, "invoiceNumber", "invoice_number")) || null,
      debtorName: str(col(r, "debtorName", "debtor_name")) || "(unnamed debtor)",
      status: str(r.status),
      invoiceDate: toIso(col(r, "invoiceDate", "invoice_date")),
      dueDate: toIso(col(r, "dueDate", "due_date")),
      totalSen,
      paidSen,
      outstandingSen: totalSen - paidSen,
      ageDays: age,
      bucket: bucketOf(age),
    };
  });
}

// ── Debtor aggregation ───────────────────────────────────────────────────────

export interface DebtorChase {
  debtorName: string;
  invoiceCount: number;
  outstandingSen: number;
  oldestAgeDays: number;
  worstBucket: CollectionBucket;
  severity: CollectionSeverity;
  byBucket: Record<CollectionBucket, number>;
  invoices: Array<{
    invoiceNo: string | null;
    invoiceDate: string | null;
    dueDate: string | null;
    outstandingSen: number;
    ageDays: number;
    bucket: CollectionBucket;
  }>;
}

function severityOf(outstandingSen: number, oldestAgeDays: number): CollectionSeverity {
  if (outstandingSen >= DEBTOR_CRIT_OUTSTANDING_SEN || oldestAgeDays >= DEBTOR_CRIT_AGE_DAYS) {
    return "CRIT";
  }
  return oldestAgeDays > 30 ? "WARN" : "INFO";
}

function aggregateByDebtor(invoices: UnpaidInvoice[]): DebtorChase[] {
  const byDebtor = new Map<string, UnpaidInvoice[]>();
  for (const inv of invoices) {
    const arr = byDebtor.get(inv.debtorName) ?? [];
    arr.push(inv);
    byDebtor.set(inv.debtorName, arr);
  }
  const chases: DebtorChase[] = [];
  for (const [debtorName, invs] of byDebtor) {
    const outstandingSen = invs.reduce((s, x) => s + x.outstandingSen, 0);
    const oldestAgeDays = invs.reduce((m, x) => Math.max(m, x.ageDays), 0);
    const byBucket: Record<CollectionBucket, number> = {
      "0-30": 0, "31-60": 0, "61-90": 0, "90+": 0,
    };
    for (const x of invs) byBucket[x.bucket] += x.outstandingSen;
    const worstBucket: CollectionBucket =
      byBucket["90+"] > 0 ? "90+"
        : byBucket["61-90"] > 0 ? "61-90"
        : byBucket["31-60"] > 0 ? "31-60"
        : "0-30";
    chases.push({
      debtorName,
      invoiceCount: invs.length,
      outstandingSen,
      oldestAgeDays,
      worstBucket,
      severity: severityOf(outstandingSen, oldestAgeDays),
      byBucket,
      invoices: invs
        .slice()
        .sort((a, b) => b.ageDays - a.ageDays)
        .map((x) => ({
          invoiceNo: x.invoiceNo,
          invoiceDate: x.invoiceDate,
          dueDate: x.dueDate,
          outstandingSen: x.outstandingSen,
          ageDays: x.ageDays,
          bucket: x.bucket,
        })),
    });
  }
  // Worst first: most overdue, then largest balance.
  chases.sort((a, b) => b.oldestAgeDays - a.oldestAgeDays || b.outstandingSen - a.outstandingSen);
  return chases;
}

// ── 1. generateCollectionProposals ───────────────────────────────────────────

export type CollectionProposalKind = "DEBTOR_CHASE";

export interface GenerateCollectionProposalsResult {
  created: number;
  skippedOpen: number;
  debtors: number;
  capped: boolean;
}

async function openProposalKeys(db: D1Database): Promise<Set<string>> {
  const keys = new Set<string>();
  try {
    const res = await db
      .prepare("SELECT kind, key FROM collection_agent_proposals WHERE status = 'PENDING'")
      .all<{ kind: string; key: string }>();
    for (const r of res.results ?? []) keys.add(`${str(r.kind)}\0${str(r.key)}`);
  } catch (e) {
    console.warn("[collection-agent] open-proposal key read failed:", e);
  }
  return keys;
}

export async function generateCollectionProposals(
  env: Env,
  chases: DebtorChase[],
): Promise<GenerateCollectionProposalsResult> {
  const db = env.DB;
  const nowIso = new Date().toISOString();
  const openKeys = await openProposalKeys(db);
  const capped = chases.length > MAX_DEBTORS;
  const worklist = chases.slice(0, MAX_DEBTORS);

  let created = 0;
  let skippedOpen = 0;
  for (const chase of worklist) {
    const key = `DEBTOR_CHASE:${chase.debtorName}`;
    if (openKeys.has(`DEBTOR_CHASE\0${key}`)) {
      skippedOpen++;
      continue;
    }
    const summary =
      `${chase.debtorName} owes ${rm(chase.outstandingSen)} across ${chase.invoiceCount} unpaid ` +
      `invoice${chase.invoiceCount === 1 ? "" : "s"}, oldest ${chase.oldestAgeDays} day(s) ` +
      `(${chase.worstBucket} bucket). Chase for payment — proposal only, send via the office / Mail Center.`;
    await db
      .prepare(
        `INSERT INTO collection_agent_proposals (id, kind, key, status, payload, summary, created_at)
         VALUES (?, 'DEBTOR_CHASE', ?, 'PENDING', ?::jsonb, ?, ?)`,
      )
      .bind(crypto.randomUUID(), key, JSON.stringify(chase), summary, nowIso)
      .run();
    openKeys.add(`DEBTOR_CHASE\0${key}`);
    created++;
  }
  return { created, skippedOpen, debtors: worklist.length, capped };
}

// ── 2. collectCollectionBrief ────────────────────────────────────────────────

export interface CollectionBriefData {
  generatedAt: string;
  totalOutstandingSen: number;
  debtorsOwing: number;
  invoicesOutstanding: number;
  oldestInvoiceDays: number;
  buckets: Array<{ bucket: CollectionBucket; invoices: number; outstandingSen: number }>;
  /** Worst debtors (oldest then largest), top 10. */
  topDebtors: Array<{
    debtorName: string;
    invoiceCount: number;
    outstandingSen: number;
    oldestAgeDays: number;
    worstBucket: CollectionBucket;
    severity: CollectionSeverity;
  }>;
  openProposals: { total: number };
}

export async function collectCollectionBrief(
  env: Env,
  invoices: UnpaidInvoice[],
  chases: DebtorChase[],
): Promise<CollectionBriefData> {
  const db = env.DB;
  const nowIso = new Date().toISOString();

  const bucketAgg: Record<CollectionBucket, { invoices: number; outstandingSen: number }> = {
    "0-30": { invoices: 0, outstandingSen: 0 },
    "31-60": { invoices: 0, outstandingSen: 0 },
    "61-90": { invoices: 0, outstandingSen: 0 },
    "90+": { invoices: 0, outstandingSen: 0 },
  };
  for (const inv of invoices) {
    bucketAgg[inv.bucket].invoices += 1;
    bucketAgg[inv.bucket].outstandingSen += inv.outstandingSen;
  }

  const brief: CollectionBriefData = {
    generatedAt: nowIso,
    totalOutstandingSen: invoices.reduce((s, x) => s + x.outstandingSen, 0),
    debtorsOwing: chases.length,
    invoicesOutstanding: invoices.length,
    oldestInvoiceDays: invoices.reduce((m, x) => Math.max(m, x.ageDays), 0),
    buckets: (["0-30", "31-60", "61-90", "90+"] as CollectionBucket[]).map((b) => ({
      bucket: b,
      invoices: bucketAgg[b].invoices,
      outstandingSen: bucketAgg[b].outstandingSen,
    })),
    topDebtors: chases.slice(0, 10).map((d) => ({
      debtorName: d.debtorName,
      invoiceCount: d.invoiceCount,
      outstandingSen: d.outstandingSen,
      oldestAgeDays: d.oldestAgeDays,
      worstBucket: d.worstBucket,
      severity: d.severity,
    })),
    openProposals: { total: await openProposalTotal(db) },
  };

  try {
    await db
      .prepare(
        "INSERT INTO collection_agent_briefs (id, brief, ai_focus, created_at) VALUES (?, ?::jsonb, NULL, ?)",
      )
      .bind(crypto.randomUUID(), JSON.stringify(brief), nowIso)
      .run();
  } catch (e) {
    console.warn("[collection-agent] brief snapshot insert failed:", e);
  }
  return brief;
}

async function openProposalTotal(db: D1Database): Promise<number> {
  try {
    const r = await db
      .prepare("SELECT COUNT(*) AS n FROM collection_agent_proposals WHERE status = 'PENDING'")
      .first<{ n: number | string }>();
    return num(r?.n);
  } catch {
    return 0;
  }
}

// ── 3. runCollectionAgent (orchestrator) ─────────────────────────────────────

export interface RunCollectionAgentResult {
  summary: string;
  brief: CollectionBriefData;
  proposalsCreated: number;
}

export async function runCollectionAgent(env: Env): Promise<RunCollectionAgentResult> {
  const db = env.DB;
  const nowMs = Date.now();
  const threshold = await chaseThresholdDays(db);
  const invoices = await loadUnpaidInvoices(db, nowMs, threshold);
  const chases = aggregateByDebtor(invoices);

  const gen = await generateCollectionProposals(env, chases);
  const brief = await collectCollectionBrief(env, invoices, chases);

  const crit = brief.topDebtors.filter((d) => d.severity === "CRIT").length;
  const summary =
    `Collection: ${rm(brief.totalOutstandingSen)} outstanding across ${brief.invoicesOutstanding} ` +
    `invoice(s) from ${brief.debtorsOwing} debtor(s)` +
    (crit ? `, ${crit}+ critical` : "") +
    `; created ${gen.created} chase proposal(s)` +
    (gen.skippedOpen > 0 ? ` (${gen.skippedOpen} already open)` : "") +
    (gen.capped ? ` (worklist capped at ${MAX_DEBTORS})` : "") +
    `; oldest invoice ${brief.oldestInvoiceDays} day(s).`;

  return { summary, brief, proposalsCreated: gen.created };
}

// ── 4. collectionAgentStatus (console card counters) ─────────────────────────

export interface CollectionAgentStatus {
  openProposals: number;
  lastBriefAt: string | null;
  totalOutstandingSen: number;
}

export async function collectionAgentStatus(env: Env): Promise<CollectionAgentStatus> {
  const db = env.DB;
  const openProposals = await openProposalTotal(db);
  let lastBriefAt: string | null = null;
  let totalOutstandingSen = 0;
  try {
    const r = await db
      .prepare("SELECT MAX(created_at) AS last FROM collection_agent_briefs")
      .first<{ last?: string | null }>();
    lastBriefAt = r?.last ?? null;
  } catch {
    /* pre-migration — null */
  }
  try {
    const r = await db
      .prepare(
        `SELECT COALESCE(SUM(si.total_centi - si.paid_centi), 0) AS out
           FROM scm.sales_invoices si
          WHERE si.status IN ('SENT', 'PARTIALLY_PAID', 'OVERDUE')
            AND (si.total_centi - si.paid_centi) > 0`,
      )
      .first<Row>();
    totalOutstandingSen = num(col(r ?? {}, "out", "out"));
  } catch {
    /* zeros */
  }
  return { openProposals, lastBriefAt, totalOutstandingSen };
}
