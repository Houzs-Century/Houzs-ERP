// ----------------------------------------------------------------------------
// fair-report-queries.ts — typed read hooks for the Fair Report endpoint
// (GET /scm/reports/fair-report + /scm/reports/fair-report/:docNo).
//
// The exhibition-performance report with THREE document-stage views selected by
// `stage` (so | do | invoice). Every field mirrors the server output shape 1:1
// (backend/src/scm/lib/fair-report.ts + routes/reports.ts) so the two cannot
// drift. Read-only, thin: the server does all the fair-anchoring, the money
// splits and the per-stage KPI summaries; these hooks only fetch + type.
//
// Same pattern as reports-queries.ts (useQuery + the vendored authedFetch, which
// prepends /api/scm). The 7 shared filters + the stage all ride the query
// string; the page keeps them in the URL (useSearchParams) so a report view is
// shareable.
// ----------------------------------------------------------------------------

import { useQuery } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';

export type FairStage = 'so' | 'do' | 'invoice' | 'pnl';

/** The four Fair Report tender labels (mfg_sales_order_payments.method mapped:
 *  cash→Cash, merchant→Merchant, installment→Installment, transfer→Online). */
export type FairTenderLabel = 'Cash' | 'Merchant' | 'Installment' | 'Online';
export type FairTenderSplit = { Cash: number; Merchant: number; Installment: number; Online: number };

/** The 7 shared filters (all live on the SO header server-side). Empty / unset
 *  fields are omitted from the query string. */
export type FairFilters = {
  venue?: string;        // venue TEXT (venue_id is a dead scm.venues FK; filter on the name)
  state?: string;        // customer_state
  project?: number;      // project_id (int)
  branding?: string;
  salesperson?: string;  // salesperson_id (uuid)
  month?: string;        // YYYY-MM
  dateFrom?: string;     // YYYY-MM-DD (inclusive)
  dateTo?: string;       // YYYY-MM-DD (inclusive)
};

/** Fair-identity columns emitted on every stage row (fairDims). */
export type FairDims = {
  venue: string | null;
  venue_id: string | null;
  state: string | null;
  project_id: number | null;
  project: string | null;
  project_start_date: string | null;
  project_end_date: string | null;
  salesperson_id: string | null;
  salesperson: string | null;
  branding: string | null;
};

export type FairCostByCategory = {
  mattress_sofa_cost_centi: number;
  bedframe_cost_centi: number;
  accessories_cost_centi: number;
  others_cost_centi: number;
  service_cost_centi: number;
};

// ── stage=so ─────────────────────────────────────────────────────────────────
export type FairSoRow = FairDims & {
  so_date: string | null;
  so_no: string;
  order_form: string | null;      // ref (handwritten HC number)
  amount_centi: number;           // product + service
  selling_centi: number;          // product only
  service_rev_centi: number;
  cost_by_category: FairCostByCategory;
  total_so_cost_centi: number;
  margin_pct: number | null;
  balance_centi: number;
  paid_total_centi: number;
  deposit_centi: number;
  payment_methods: FairTenderLabel[];
  deposit_by_tender: FairTenderSplit;
  below_deposit: boolean;
};

export type FairSoSummary = {
  orders: number;
  total_amount_centi: number;
  total_selling_centi: number;
  total_service_rev_centi: number;
  total_so_cost_centi: number;
  total_margin_centi: number;
  margin_pct: number | null;
  total_balance_centi: number;
  below_deposit_count: number;
  tender_totals: FairTenderSplit;
};

// ── stage=do ─────────────────────────────────────────────────────────────────
export type FairDoRow = FairDims & {
  delivery_date: string | null;
  do_no: string;
  so_no: string | null;
  status: string | null;
  qty: number;
  so_amount_centi: number | null;   // linked SO's amount (matches the SO tab)
  total_so_cost_centi: number;
  total_do_cost_centi: number;
  do_cost_is_legacy: boolean;
  cost_delta_centi: number;       // do − so (positive = cost grew at delivery)
  so_margin_pct: number | null;
  do_margin_pct: number | null;
};

export type FairDoSummary = {
  deliveries: number;
  total_so_cost_centi: number;
  total_do_cost_centi: number;
  cost_delta_centi: number;
  legacy_count: number;
};

// ── stage=invoice ────────────────────────────────────────────────────────────
export type FairInvoiceRow = FairDims & {
  invoice_date: string | null;
  inv_no: string;
  so_no: string | null;
  do_id: string | null;
  status: string | null;
  invoiced_centi: number;
  so_cost_centi: number;
  do_cost_centi: number;
  si_cost_centi: number;          // landed
  margin_pct: number | null;      // invoiced vs landed
};

export type FairInvoiceSummary = {
  invoices: number;
  total_invoiced_centi: number;
  total_so_cost_centi: number;
  total_do_cost_centi: number;
  total_si_cost_centi: number;
  margin_pct: number | null;
};

// ── stage=pnl (exhibition P&L) ───────────────────────────────────────────────
export type FairPnlCostStage = 'so' | 'do' | 'invoice';

export type FairPnlRow = FairDims & {
  so_date: string | null;
  so_no: string;
  order_form: string | null;
  revenue_centi: number;             // product + service
  product_rev_centi: number;
  service_rev_centi: number;
  so_cost_centi: number;             // SO category cost
  do_cost_centi: number | null;      // null when no DO exists yet
  si_cost_centi: number | null;      // null when no SI exists yet
  effective_cost_centi: number;      // most-progressed booked cost (COGS)
  effective_cost_stage: FairPnlCostStage;
  gross_profit_centi: number;        // revenue − effective cost
  margin_pct: number | null;
};

export type FairOverheads = {
  transport_centi: number;
  merchandise_centi: number;
  commission_centi: number;
  commission_pct: number;
  commission_is_boost: boolean;
  total_overhead_centi: number;
};

export type FairPnlSummary = {
  orders: number;
  delivered_orders: number;
  invoiced_orders: number;
  total_revenue_centi: number;
  total_product_rev_centi: number;
  total_service_rev_centi: number;
  total_so_cost_centi: number;
  total_do_cost_centi: number;
  total_si_cost_centi: number;
  total_cogs_centi: number;
  gross_profit_centi: number;
  gross_margin_pct: number | null;
  overheads: FairOverheads;
  net_profit_centi: number;
  net_margin_pct: number | null;
};

export type FairFiltersEcho = {
  stage: FairStage;
  venue: string | null;
  state: string | null;
  project: number | null;
  branding: string | null;
  salesperson: string | null;
  month: string | null;
  date_from: string | null;
  date_to: string | null;
};

export type FairSoResponse = {
  stage: 'so';
  rows: FairSoRow[];
  summary: FairSoSummary;
  filters: FairFiltersEcho;
  meta: { access_tier: 'management' | 'sales_director' | 'none' };
};
export type FairDoResponse = {
  stage: 'do';
  rows: FairDoRow[];
  summary: FairDoSummary;
  filters: FairFiltersEcho;
  meta: { access_tier: 'management' | 'sales_director' | 'none' };
};
export type FairInvoiceResponse = {
  stage: 'invoice';
  rows: FairInvoiceRow[];
  summary: FairInvoiceSummary;
  filters: FairFiltersEcho;
  meta: { access_tier: 'management' | 'sales_director' | 'none' };
};
export type FairPnlResponse = {
  stage: 'pnl';
  rows: FairPnlRow[];
  summary: FairPnlSummary;
  filters: FairFiltersEcho;
  meta: {
    access_tier: 'management' | 'sales_director' | 'none';
    needs_project: boolean;   // true when no fair (project) is selected yet
    brand: string | null;     // the fair's brand (drives the rate card)
    rate_present: boolean;    // false when the brand has no project_cost_rates card
  };
};
export type FairReportResponse = FairSoResponse | FairDoResponse | FairInvoiceResponse | FairPnlResponse;

function buildFairQs(stage: FairStage, f: FairFilters): string {
  const params = new URLSearchParams();
  params.set('stage', stage);
  if (f.venue)       params.set('venue', f.venue);
  if (f.state)       params.set('state', f.state);
  if (f.project != null) params.set('project', String(f.project));
  if (f.branding)    params.set('branding', f.branding);
  if (f.salesperson) params.set('salesperson', f.salesperson);
  if (f.month)       params.set('month', f.month);
  if (f.dateFrom)    params.set('date_from', f.dateFrom);
  if (f.dateTo)      params.set('date_to', f.dateTo);
  return params.toString();
}

/**
 * The per-stage list read. `enabled` lets the page hold a stage's query until
 * its tab is actually selected AND the caller is allowed to see it (a Sales
 * Director must never fire the do/invoice queries the backend would 403).
 */
export const useFairReport = (stage: FairStage, filters: FairFilters, enabled = true) => {
  const qs = buildFairQs(stage, filters);
  return useQuery({
    queryKey: ['reports', 'fair-report', qs],
    queryFn: () => authedFetch<FairReportResponse>(`/reports/fair-report?${qs}`),
    enabled,
    placeholderData: (prev) => prev,  // TanStack v5 equivalent of keepPreviousData
    staleTime: 30_000,
  });
};

/**
 * Interpret a useFairReport / useFairReportDetail failure for display. A 403 is a
 * PERMISSION denial — the caller is not in the report's cohort (management + Sales
 * Director), so retrying can never succeed and the operator must be told they lack
 * access, NOT that a transient load failed. Every other failure (5xx, network,
 * timeout) IS retryable and keeps the "please retry" wording + a Retry control.
 *
 * The HTTP status rides the thrown error as `.status` (authed-fetch stamps it on
 * every non-OK response). ONE source for both the desktop (FairReport.tsx) and the
 * mobile (MobileFairReport.tsx) banners so their copy cannot drift.
 */
export function fairReportErrorInfo(error: unknown): { denied: boolean; message: string } {
  const status = (error as { status?: number } | null | undefined)?.status;
  if (status === 403) {
    return {
      denied: true,
      message: 'You do not have access to the Sales Report. Ask an administrator if you need it.',
    };
  }
  return { denied: false, message: 'Could not load the Sales Report. Please retry.' };
}

// ── per-order detail (quick-view drawer) ─────────────────────────────────────
export type FairDetailLine = {
  item_group: string | null;
  item_code: string | null;
  description: string | null;
  /* description2 + variants carry the variant summary so this line shows the
     same "code / SEAT / LEG / fabric" subtitle as every other order-line surface
     (owner 2026-07-24). variants also carries the READ-stamped fabricSupplierCode
     → the fabric renders "BF-01 (PC151-01)". */
  description2: string | null;
  variants: Record<string, unknown> | null;
  qty: number | null;
  unit_price_centi: number | null;
  amount_centi: number | null;
  unit_cost_centi: number | null;
  line_cost_centi: number | null;
  cancelled: boolean | null;
};

export type FairDetailPayment = {
  tender: string | null;
  amount_centi: number | null;
  merchant_provider: string | null;
  installment_months: number | null;
  approval_code: string | null;
  paid_at: string | null;
  is_deposit: boolean | null;
};

export type FairDetailResponse = FairDims & {
  so_no: string;
  order_form: string | null;
  so_date: string | null;
  amount_centi: number;
  selling_centi: number;
  service_rev_centi: number;
  cost_by_category: FairCostByCategory;
  total_so_cost_centi: number;
  margin_pct: number | null;
  balance_centi: number;
  deposit_centi: number;
  paid_total_centi: number;
  below_deposit: boolean;
  payment_methods: FairTenderLabel[];
  deposit_by_tender: FairTenderSplit;
  payments: FairDetailPayment[];
  lines: FairDetailLine[];
  linkage: { so_no: string; do_nos: string[]; invoice_nos: string[] };
  meta: { access_tier: 'management' | 'sales_director' | 'none' };
};

/** Per-order detail for the quick-view drawer, keyed by SO doc_no. `docNo` null
 *  (drawer closed) keeps the query idle. */
export const useFairReportDetail = (docNo: string | null) => {
  return useQuery({
    queryKey: ['reports', 'fair-report-detail', docNo],
    queryFn: () => authedFetch<FairDetailResponse>(`/reports/fair-report/${encodeURIComponent(docNo ?? '')}`),
    enabled: !!docNo,
    staleTime: 30_000,
  });
};
