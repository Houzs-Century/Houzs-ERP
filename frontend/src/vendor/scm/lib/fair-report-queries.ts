
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
  venue?: string;
  state?: string;
  project?: number;
  branding?: string;
  salesperson?: string;
  month?: string;
  dateFrom?: string;
  dateTo?: string;
  dateBasis?: FairDateBasis;
};

/** 'so': every stage's rows from the orders whose SO date is in the window (the
 *  default); 'stage': Delivery Orders by the date their rows show, Invoices by
 *  invoice date — Sales Orders and the P&L keep the SO date (owner 2026-11-03). */
export type FairDateBasis = 'so' | 'stage';

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
  mattress_sofa_cost_sen: number;
  bedframe_cost_sen: number;
  accessories_cost_sen: number;
  others_cost_sen: number;
  service_cost_sen: number;
};

export type FairSoRow = FairDims & {
  so_date: string | null;
  so_no: string;
  order_form: string | null;
  amount_sen: number;
  selling_sen: number;
  service_rev_sen: number;
  cost_by_category: FairCostByCategory;
  total_so_cost_sen: number;
  goods_cost_sen: number;
  margin_pct: number | null;
  balance_sen: number;
  paid_total_sen: number;
  deposit_sen: number;
  payment_methods: FairTenderLabel[];
  deposit_by_tender: FairTenderSplit;
  below_deposit: boolean;
};

export type FairSoSummary = {
  orders: number;
  total_amount_sen: number;
  total_selling_sen: number;
  total_service_rev_sen: number;
  total_so_cost_sen: number;
  total_goods_cost_sen: number;
  total_margin_sen: number;
  margin_pct: number | null;
  total_balance_sen: number;
  below_deposit_count: number;
  tender_totals: FairTenderSplit;
};

export type FairDoRow = FairDims & {
  delivery_date: string | null;
  do_no: string;
  so_no: string | null;
  status: string | null;
  location: string | null;
  delivery_location: string | null;
  delivery_address: string | null;
  qty: number;
  so_amount_sen: number | null;
  total_so_cost_sen: number;
  total_do_cost_sen: number;
  do_cost_is_legacy: boolean;
  cost_delta_sen: number;
  so_margin_pct: number | null;
  do_margin_pct: number | null;
};

export type FairDoSummary = {
  deliveries: number;
  total_so_cost_sen: number;
  total_do_cost_sen: number;
  cost_delta_sen: number;
  legacy_count: number;
};

export type FairInvoiceRow = FairDims & {
  invoice_date: string | null;
  inv_no: string;
  so_no: string | null;
  do_id: string | null;
  status: string | null;
  invoiced_sen: number;
  so_cost_sen: number;
  do_cost_sen: number;
  si_cost_sen: number;
  goods_invoiced_sen: number;
  goods_si_cost_sen: number;
  margin_pct: number | null;
};

export type FairInvoiceSummary = {
  invoices: number;
  total_invoiced_sen: number;
  total_so_cost_sen: number;
  total_do_cost_sen: number;
  total_si_cost_sen: number;
  total_goods_invoiced_sen: number;
  total_goods_si_cost_sen: number;
  margin_pct: number | null;
};

export type FairPnlCostStage = 'so' | 'do' | 'invoice';

export type FairPnlRow = FairDims & {
  so_date: string | null;
  so_no: string;
  order_form: string | null;
  revenue_sen: number;
  product_rev_sen: number;
  service_rev_sen: number;
  so_cost_sen: number;
  do_cost_sen: number | null;
  si_cost_sen: number | null;
  effective_cost_sen: number;
  effective_cost_stage: FairPnlCostStage;
  gross_profit_sen: number;
  margin_pct: number | null;
};

export type FairOverheads = {
  transport_sen: number;
  merchandise_sen: number;
  commission_sen: number;
  commission_pct: number;
  commission_is_boost: boolean;
  total_overhead_sen: number;
};

export type FairPnlSummary = {
  orders: number;
  delivered_orders: number;
  invoiced_orders: number;
  total_revenue_sen: number;
  total_product_rev_sen: number;
  total_service_rev_sen: number;
  total_so_cost_sen: number;
  total_do_cost_sen: number;
  total_si_cost_sen: number;
  total_cogs_sen: number;
  gross_profit_sen: number;
  gross_margin_pct: number | null;
  overheads: FairOverheads;
  net_profit_sen: number;
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
  date_basis?: FairDateBasis;
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
/** A brand's cost-rate card (project_cost_rates): plain percentages (5 == 5%). */
export type FairCostRate = {
  transport_pct: number;
  merchandise_pct: number;
  commission_normal_pct: number;
  commission_boost_pct: number | null;
  boost_min_gp_pct: number | null;
  boost_min_sales: number | null;
};

/** One fair's line in the every-fair P&L (no fair picked): its summary is the
 *  one its own P&L shows once picked, priced on its own card. */
export type FairPnlFairRow = {
  project_id: number;
  project: string | null;
  project_start_date: string | null;
  project_end_date: string | null;
  venue: string | null;
  brand: string | null;
  rate_present: boolean;
  summary: FairPnlSummary;
};

export type FairPnlResponse = {
  stage: 'pnl';
  rows: FairPnlRow[];
  summary: FairPnlSummary;
  fairs?: FairPnlFairRow[];
  no_fair?: { orders: number; revenue_sen: number };
  filters: FairFiltersEcho;
  meta: {
    access_tier: 'management' | 'sales_director' | 'none';
    needs_project: boolean;
    brand: string | null;
    rate_present: boolean;
    rate?: FairCostRate | null;
    fair?: { project_id: number; project: string | null; project_start_date: string | null; project_end_date: string | null } | null;
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
  if (f.dateBasis === 'stage') params.set('date_basis', 'stage');
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
    placeholderData: (prev) => prev,
    staleTime: 30_000,
  });
};

// ── stage=gaps ───────────────────────────────────────────────────────────────
// The costing-gap listing (owner 2026-09-26): SO lines with NO cost whose PRODUCT
// also has no cost — the products to fill in Product Maintenance. Its own endpoint
// (/reports/costing-gap-listing), not the fair-report stage machinery, so it has a
// dedicated hook and is not filtered by the fair filter bar (it is a global "what
// is incomplete" list). Finance-gated on the server.
export type FairCostingGapRow = {
  doc_no: string;
  so_date: string | null;
  item_code: string;
  description: string | null;
  item_group: string | null;
  qty: number | null;
  debtor_name: string | null;
  venue: string | null;
  branding: string | null;
  status: string | null;
};

export const useCostingGapListing = (enabled = true) =>
  useQuery({
    queryKey: ['reports', 'costing-gap-listing'],
    queryFn: () => authedFetch<{ rows: FairCostingGapRow[] }>('/reports/costing-gap-listing'),
    enabled,
    placeholderData: (prev) => prev,
    staleTime: 30_000,
  });

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
  unit_price_sen: number | null;
  amount_sen: number | null;
  unit_cost_sen: number | null;
  line_cost_sen: number | null;
  cancelled: boolean | null;
};

export type FairDetailPayment = {
  tender: string | null;
  amount_sen: number | null;
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
  amount_sen: number;
  selling_sen: number;
  service_rev_sen: number;
  cost_by_category: FairCostByCategory;
  total_so_cost_sen: number;
  margin_pct: number | null;
  balance_sen: number;
  deposit_sen: number;
  paid_total_sen: number;
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
