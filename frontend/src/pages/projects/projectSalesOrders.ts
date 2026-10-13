/* The Sales Orders written at one exhibition, as the project page shows them —
 * the wire shape of GET /api/project-sales-orders/:projectId and the one
 * arithmetic the page does on it (owner 2026-10-13): the lump-sum Total Sales
 * typed into the project against the orders actually opened in the SO module,
 * so the gap between them is what is still sitting on paper slips.
 *
 * Shared by the desktop block and the mobile panel so the two cannot disagree
 * on what "not yet opened" means. Pure; no fetching here.
 */
import { statusLabel } from "../../vendor/scm/lib/status-pill";

export type ProjectSalesOrderRow = {
  doc_no: string;
  so_date: string | null;
  ref: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  salesperson_name: string | null;
  status: string;
  amount_sen: number;
  paid_sen: number;
  balance_sen: number;
  fair_match: string | null;
  linked_ac_docno: string | null;
  created_at: string | null;
};

export type ProjectSalesOrderTotals = {
  count: number;
  draft_count: number;
  amount_sen: number;
  paid_sen: number;
  balance_sen: number;
};

export type ProjectSalesOrdersResponse = {
  data: ProjectSalesOrderRow[];
  totals: ProjectSalesOrderTotals;
  /** True when the caller sees their own + downline orders only, so the
   *  totals are a partial view of the fair and the gap must not be read as
   *  the fair's. */
  scoped: boolean;
};

const ZERO_TOTALS: ProjectSalesOrderTotals = { count: 0, draft_count: 0, amount_sen: 0, paid_sen: 0, balance_sen: 0 };

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** The read as the page may rely on it. A response that is not the shape
 *  above — a proxy answering for another route, a stub, an older worker —
 *  becomes an empty, unscoped read rather than a crash of the whole project
 *  page; the rows are kept only when they are an array. */
export function normalizeProjectSalesOrders(raw: unknown): ProjectSalesOrdersResponse {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<ProjectSalesOrdersResponse>;
  const data = Array.isArray(r.data) ? r.data : [];
  const t = r.totals && typeof r.totals === "object" ? r.totals : ZERO_TOTALS;
  return {
    data,
    totals: {
      count: num(t.count),
      draft_count: num(t.draft_count),
      amount_sen: num(t.amount_sen),
      paid_sen: num(t.paid_sen),
      balance_sen: num(t.balance_sen),
    },
    scoped: r.scoped === true,
  };
}

export type ProjectSalesOrdersSummary = {
  count: number;
  draftCount: number;
  /** Sum of the orders' totals, in RM. */
  openedRm: number;
  paidRm: number;
  balanceRm: number;
  /** The project's lump-sum Total Sales, in RM; null when none was typed. */
  finalTotalRm: number | null;
  /** finalTotal − opened, SIGNED, in RM. Null without a final total. Negative
   *  means the orders already exceed the typed total (it was typed low, or
   *  typed before the floor finished). */
  notOpenedRm: number | null;
  /** notOpened as a percentage of the final total; null when there is no
   *  final total or it is zero. */
  notOpenedPct: number | null;
};

const rm = (sen: number): number => Math.round(sen) / 100;

/** The numbers the Sales section's header shows. `finalTotalRm` is
 *  `project_finance.total_sales` as the project detail carries it (RM). */
export function summarizeProjectSalesOrders(
  totals: ProjectSalesOrderTotals,
  finalTotalRm: number | null,
): ProjectSalesOrdersSummary {
  const openedRm = rm(totals.amount_sen);
  const hasFinal = finalTotalRm != null && Number.isFinite(finalTotalRm);
  const notOpenedRm = hasFinal ? Math.round((finalTotalRm - openedRm) * 100) / 100 : null;
  const notOpenedPct =
    hasFinal && finalTotalRm > 0 && notOpenedRm != null
      ? Math.round((notOpenedRm / finalTotalRm) * 1000) / 10
      : null;
  return {
    count: totals.count,
    draftCount: totals.draft_count,
    openedRm,
    paidRm: rm(totals.paid_sen),
    balanceRm: rm(totals.balance_sen),
    finalTotalRm: hasFinal ? finalTotalRm : null,
    notOpenedRm,
    notOpenedPct,
  };
}

/** A sales order's status as the SO list spells it — status-pill.ts is the
 *  one vocabulary (the confirm rung reads "Submitted", owner 2026-09-12), so
 *  this must not carry a map of its own. A blank status reads as a dash. */
export function soStatusLabel(status: string | null | undefined): string {
  const key = (status ?? "").trim();
  return statusLabel("so", key || null);
}
