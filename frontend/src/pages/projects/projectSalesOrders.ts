/* The Sales Orders written at one exhibition, as the project page shows them —
 * the wire shape of GET /api/project-sales-orders/:projectId and the one
 * arithmetic the page does on it (owner 2026-10-13): the lump-sum Total Sales
 * typed into the project against the orders actually opened in the SO module,
 * so the gap between them is what is still sitting on paper slips.
 *
 * Shared by the desktop block and the mobile panel so the two cannot disagree
 * on what "not yet opened" means. Pure; no fetching here.
 */

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

/** A sales order's status as a person reads it: the SO list's own spellings
 *  for the few that have one, else the key with its underscores opened up. */
export function soStatusLabel(status: string | null | undefined): string {
  const key = (status ?? "").trim().toUpperCase();
  if (!key) return "—";
  const known: Record<string, string> = {
    DRAFT: "Draft",
    CONFIRMED: "Confirmed",
    IN_PRODUCTION: "In production",
    READY_TO_SHIP: "Ready to ship",
    SHIPPED: "Delivered",
    DELIVERED: "Delivered",
    INVOICED: "Invoiced",
    CLOSED: "Closed",
    ON_HOLD: "On hold",
  };
  if (known[key]) return known[key];
  const words = key.toLowerCase().replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}
