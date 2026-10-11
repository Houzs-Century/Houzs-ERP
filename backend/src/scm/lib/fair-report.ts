// ----------------------------------------------------------------------------
// fair-report.ts — the PURE gate + shaping math for the Fair Report
// (GET /scm/reports/fair-report), an exhibition-performance report with three
// document-stage views (SO / DO / Invoice).
//
// WHY A SEPARATE PURE MODULE: the whole correctness surface here is (1) WHO may
// read WHICH stage — an owner-ruled matrix that must be exactly right — and
// (2) the money splits (product-vs-service revenue, deposit-by-tender, margin,
// below-deposit). The codebase tests both by extracting PURE functions and
// pinning them (lib/fulfillment-costing.ts is the model), NOT by mocking
// Supabase. Every decision that could be wrong lives here as a plain function
// the route calls and the tests exercise; the route only fetches + assembles.
//
// UNITS: every *_centi value is an integer number of cents (1/100 of MYR).
// Percentages are plain numbers (e.g. 12.5 == 12.5%).
// ----------------------------------------------------------------------------

import { isFinanceViewer, isSalesDirectorUser } from '../../services/pmsAccess';
import type { AuthUser } from '../../services/auth';

// ── Stage ────────────────────────────────────────────────────────────────────
// 'pnl' is the exhibition P&L view (revenue - three-way fulfillment cost -
// project_cost_rates overhead = net profit). It is management-only, like do /
// invoice, and additionally REQUIRES a fair (project) so the per-brand rate card
// resolves to exactly one row.
export type FairStage = 'so' | 'do' | 'invoice' | 'pnl';
export const FAIR_STAGES: readonly FairStage[] = ['so', 'do', 'invoice', 'pnl'];

/** Parse the `stage` query param; null when absent/unknown (route → 400). */
export function parseStage(raw: string | null | undefined): FairStage | null {
  const s = (raw ?? '').trim().toLowerCase();
  return (FAIR_STAGES as readonly string[]).includes(s) ? (s as FairStage) : null;
}

// ── PERMISSION (owner-ruled 2026-07-19) ──────────────────────────────────────
//
// Three tiers, enforced PER STAGE:
//   * Ordinary salespeople  → NO access (403 on every stage).
//   * Sales Director        → stage=so ONLY (403 on do + invoice).
//   * Management ("we")     → ALL stages.
//
// MANAGEMENT is deliberately NOT `canViewScmFinance` / isFinanceViewer as-is:
// isFinanceViewer's DIRECTOR cohort is {`*` owner/IT, Super Admin, Sales
// Director, Finance Manager} — it COUNTS a Sales Director. Using it raw for the
// DO/Invoice gate would hand a Sales Director the two stages the owner reserved
// for management. So management = "a finance-viewer who is NOT a Sales Director"
// = {`*` owner/IT, Super Admin, Finance Manager} — exactly owner / Super Admin /
// Finance. Sales Director is identified by the shared EXACT-name
// isSalesDirectorUser (pmsAccess), never a \b substring regex — a free-text
// rename must not slide into the director tier (see pmsAccess docblock).
//
// Both predicates FAIL CLOSED: isFinanceViewer(null)/isSalesDirectorUser(null)
// are false, so a caller with no resolved identity is refused, never admitted.

/** MANAGEMENT tier = finance-viewer AND NOT a Sales Director. Resolves to
 *  {`*` owner/IT, Super Admin, Finance Manager}. */
export function isFairManagement(user: AuthUser | null | undefined): boolean {
  return isFinanceViewer(user) && !isSalesDirectorUser(user);
}

export interface FairAccessResult {
  allowed: boolean;
  /** Plain-language reason (humanApiError style) when denied; undefined when allowed. */
  error?: string;
  /** Which tier the caller resolved to — echoed in the 403 log / response meta. */
  tier: 'management' | 'sales_director' | 'none';
}

const DENY_ORDINARY =
  'The Sales Report is limited to management and the Sales Director. Ask an administrator if you need access.';
const DENY_SD_BEYOND_SO =
  'As Sales Director you can view the Sales Order stage of the Sales Report only. The Delivery, Invoice and P&L stages are limited to management.';

/**
 * The whole gate. `stage=so` is allowed for management OR the Sales Director;
 * `stage=do` / `stage=invoice` are allowed for management ONLY. Everyone else
 * is refused on every stage.
 */
export function fairReportAccess(stage: FairStage, user: AuthUser | null | undefined): FairAccessResult {
  const management = isFairManagement(user);
  const salesDirector = isSalesDirectorUser(user);
  const tier: FairAccessResult['tier'] = management ? 'management' : salesDirector ? 'sales_director' : 'none';

  if (stage === 'so') {
    if (management || salesDirector) return { allowed: true, tier };
    return { allowed: false, error: DENY_ORDINARY, tier };
  }
  // stage === 'do' || 'invoice' || 'pnl' — management only.
  if (management) return { allowed: true, tier };
  if (salesDirector) return { allowed: false, error: DENY_SD_BEYOND_SO, tier };
  return { allowed: false, error: DENY_ORDINARY, tier };
}

// ── Tender / payment-method mapping ──────────────────────────────────────────
//
// The mfg_sales_order_payments.method vocabulary is a CLOSED enum
// (merchant | transfer | cash | installment — routes/mfg-sales-orders.ts). The
// owner's Fair Report labels map it: cash→Cash, merchant→Merchant,
// installment→Installment, transfer→Online. An unknown method returns null
// (dropped from the tender split rather than shown under a made-up label).
export type TenderLabel = 'Cash' | 'Merchant' | 'Installment' | 'Online';
export const TENDER_LABELS: readonly TenderLabel[] = ['Cash', 'Merchant', 'Installment', 'Online'];

export function tenderLabel(method: string | null | undefined): TenderLabel | null {
  switch ((method ?? '').trim().toLowerCase()) {
    case 'cash':        return 'Cash';
    case 'merchant':    return 'Merchant';
    case 'installment': return 'Installment';
    case 'transfer':    return 'Online';
    default:            return null;
  }
}

export type PaymentRow = { method: string | null; amount_centi: number | null };

/** Per-tender totals (in centi) across a doc's payment ledger, keyed by the
 *  four Fair Report labels. Unknown methods are excluded. */
export type TenderSplit = { Cash: number; Merchant: number; Installment: number; Online: number };

export function emptyTenderSplit(): TenderSplit {
  return { Cash: 0, Merchant: 0, Installment: 0, Online: 0 };
}

export function depositByTender(payments: readonly PaymentRow[]): TenderSplit {
  const out = emptyTenderSplit();
  for (const p of payments) {
    const label = tenderLabel(p.method);
    if (!label) continue;
    out[label] += Number(p.amount_centi ?? 0);
  }
  return out;
}

/** The distinct tender labels used on a doc, in canonical order — the
 *  "payment method(s) used" cell (e.g. "Cash + Online"). */
export function paymentMethodsUsed(payments: readonly PaymentRow[]): TenderLabel[] {
  const seen = new Set<TenderLabel>();
  for (const p of payments) {
    const label = tenderLabel(p.method);
    if (label) seen.add(label);
  }
  return TENDER_LABELS.filter((t) => seen.has(t));
}

// ── Money helpers ────────────────────────────────────────────────────────────
const n = (v: number | null | undefined): number => Number(v ?? 0);

/** margin% = (revenue − cost) / revenue × 100. null when revenue is 0 (a
 *  percentage off a zero base is a lie, not a 0%). */
export function marginPct(revenueCenti: number | null | undefined, costCenti: number | null | undefined): number | null {
  const rev = n(revenueCenti);
  if (rev === 0) return null;
  return ((rev - n(costCenti)) / rev) * 100;
}

/**
 * below_deposit — the SO has taken (at most) its deposit and still has money
 * outstanding. No pre-existing "below deposit" helper exists in the codebase
 * (verified), so this is the definition of record: balance still owing AND the
 * ledger has collected no more than the agreed deposit. `paidCenti` is the LIVE
 * ledger total (sum of mfg_sales_order_payments.amount_centi), not the possibly
 * stale mfg_sales_orders.paid_centi column.
 */
export function belowDeposit(o: {
  balanceCenti: number | null | undefined;
  depositCenti: number | null | undefined;
  paidCenti: number | null | undefined;
}): boolean {
  return n(o.balanceCenti) > 0 && n(o.paidCenti) <= n(o.depositCenti);
}

// ── stage=so row ─────────────────────────────────────────────────────────────
export interface FairSoInputs {
  // header money
  local_total_centi: number | null;               // amount = product + service
  mattress_sofa_centi: number | null;
  bedframe_centi: number | null;
  accessories_centi: number | null;
  others_centi: number | null;
  service_centi: number | null;                    // service revenue
  mattress_sofa_cost_centi: number | null;
  bedframe_cost_centi: number | null;
  accessories_cost_centi: number | null;
  others_cost_centi: number | null;
  service_cost_centi: number | null;
  total_cost_centi: number | null;
  balance_centi: number | null;
  deposit_centi: number | null;
}

export interface FairSoMoney {
  amount_centi: number;          // total = product + service
  selling_centi: number;         // PRODUCT only (mattress_sofa+bedframe+accessories+others), EXCLUDING service
  service_rev_centi: number;     // service revenue
  cost_by_category: {
    mattress_sofa_cost_centi: number;
    bedframe_cost_centi: number;
    accessories_cost_centi: number;
    others_cost_centi: number;
    service_cost_centi: number;
  };
  total_so_cost_centi: number;   // total_cost_centi
  margin_pct: number | null;
  balance_centi: number;
}

/** Assemble the money half of a stage=so row from the SO header columns. */
export function fairSoMoney(h: FairSoInputs): FairSoMoney {
  const selling =
    n(h.mattress_sofa_centi) + n(h.bedframe_centi) + n(h.accessories_centi) + n(h.others_centi);
  const serviceRev = n(h.service_centi);
  // amount = product + service. Prefer the persisted order total; fall back to
  // the reconstructed sum when local_total_centi is 0/absent.
  const amount = n(h.local_total_centi) || selling + serviceRev;
  const totalCost = n(h.total_cost_centi);
  return {
    amount_centi: amount,
    selling_centi: selling,
    service_rev_centi: serviceRev,
    cost_by_category: {
      mattress_sofa_cost_centi: n(h.mattress_sofa_cost_centi),
      bedframe_cost_centi: n(h.bedframe_cost_centi),
      accessories_cost_centi: n(h.accessories_cost_centi),
      others_cost_centi: n(h.others_cost_centi),
      service_cost_centi: n(h.service_cost_centi),
    },
    total_so_cost_centi: totalCost,
    margin_pct: marginPct(amount, totalCost),
    balance_centi: n(h.balance_centi),
  };
}

// ── stage=do cost comparison ─────────────────────────────────────────────────
export type DoCostLine = {
  qty: number | null;
  unit_cost_centi: number | null;
  ship_cost_centi: number | null;   // frozen ship-time FIFO (mig 0143); NULL on legacy DOs
};

/** total_do_cost = Σ COALESCE(ship_cost_centi, unit_cost_centi) × qty over the
 *  DO's lines (reuse of the Fulfillment Costing ② rule, #800). Also reports the
 *  delivered qty and whether any line fell back to the live unit cost. */
export function doCostTotal(lines: readonly DoCostLine[]): { total_do_cost_centi: number; qty: number; is_legacy: boolean } {
  let total = 0;
  let qty = 0;
  let legacy = false;
  for (const l of lines) {
    const q = n(l.qty);
    qty += q;
    const unit = l.ship_cost_centi != null ? n(l.ship_cost_centi) : n(l.unit_cost_centi);
    if (l.ship_cost_centi == null) legacy = true;
    total += unit * q;
  }
  return { total_do_cost_centi: total, qty, is_legacy: legacy };
}

// ── stage=invoice cost progression ───────────────────────────────────────────
export type SiCostLine = { qty: number | null; unit_cost_centi: number | null; line_cost_centi: number | null };

/** landed (SI) cost = Σ line_cost_centi (fall back unit×qty) over the SI lines. */
export function siCostTotal(lines: readonly SiCostLine[]): number {
  let total = 0;
  for (const l of lines) {
    total += l.line_cost_centi != null ? n(l.line_cost_centi) : n(l.unit_cost_centi) * n(l.qty);
  }
  return total;
}

// ── Summaries (per-stage KPI header cards) ───────────────────────────────────
export interface FairSoSummary {
  orders: number;
  total_amount_centi: number;
  total_selling_centi: number;
  total_service_rev_centi: number;
  total_so_cost_centi: number;
  total_margin_centi: number;
  margin_pct: number | null;
  total_balance_centi: number;
  below_deposit_count: number;
  tender_totals: TenderSplit;
}

export function summarizeSo(
  rows: ReadonlyArray<{
    amount_centi: number;
    selling_centi: number;
    service_rev_centi: number;
    total_so_cost_centi: number;
    balance_centi: number;
    below_deposit: boolean;
    deposit_by_tender: TenderSplit;
  }>,
): FairSoSummary {
  const s: FairSoSummary = {
    orders: rows.length,
    total_amount_centi: 0,
    total_selling_centi: 0,
    total_service_rev_centi: 0,
    total_so_cost_centi: 0,
    total_margin_centi: 0,
    margin_pct: null,
    total_balance_centi: 0,
    below_deposit_count: 0,
    tender_totals: emptyTenderSplit(),
  };
  for (const r of rows) {
    s.total_amount_centi += r.amount_centi;
    s.total_selling_centi += r.selling_centi;
    s.total_service_rev_centi += r.service_rev_centi;
    s.total_so_cost_centi += r.total_so_cost_centi;
    s.total_balance_centi += r.balance_centi;
    if (r.below_deposit) s.below_deposit_count += 1;
    for (const t of TENDER_LABELS) s.tender_totals[t] += r.deposit_by_tender[t];
  }
  s.total_margin_centi = s.total_amount_centi - s.total_so_cost_centi;
  s.margin_pct = marginPct(s.total_amount_centi, s.total_so_cost_centi);
  return s;
}

export interface FairDoSummary {
  deliveries: number;
  total_so_cost_centi: number;
  total_do_cost_centi: number;
  cost_delta_centi: number;   // do − so (positive = cost grew at delivery)
  legacy_count: number;
}

export function summarizeDo(
  rows: ReadonlyArray<{ total_so_cost_centi: number; total_do_cost_centi: number; do_cost_is_legacy: boolean }>,
): FairDoSummary {
  const s: FairDoSummary = { deliveries: rows.length, total_so_cost_centi: 0, total_do_cost_centi: 0, cost_delta_centi: 0, legacy_count: 0 };
  for (const r of rows) {
    s.total_so_cost_centi += r.total_so_cost_centi;
    s.total_do_cost_centi += r.total_do_cost_centi;
    if (r.do_cost_is_legacy) s.legacy_count += 1;
  }
  s.cost_delta_centi = s.total_do_cost_centi - s.total_so_cost_centi;
  return s;
}

export interface FairInvoiceSummary {
  invoices: number;
  total_invoiced_centi: number;
  total_so_cost_centi: number;
  total_do_cost_centi: number;
  total_si_cost_centi: number;   // landed
  margin_pct: number | null;     // invoiced vs landed
}

export function summarizeInvoice(
  rows: ReadonlyArray<{ invoiced_centi: number; so_cost_centi: number; do_cost_centi: number; si_cost_centi: number }>,
): FairInvoiceSummary {
  const s: FairInvoiceSummary = { invoices: rows.length, total_invoiced_centi: 0, total_so_cost_centi: 0, total_do_cost_centi: 0, total_si_cost_centi: 0, margin_pct: null };
  for (const r of rows) {
    s.total_invoiced_centi += r.invoiced_centi;
    s.total_so_cost_centi += r.so_cost_centi;
    s.total_do_cost_centi += r.do_cost_centi;
    s.total_si_cost_centi += r.si_cost_centi;
  }
  s.margin_pct = marginPct(s.total_invoiced_centi, s.total_si_cost_centi);
  return s;
}

// ── stage=pnl — the exhibition P&L ───────────────────────────────────────────
//
// Per fair (one PROJECT): revenue = confirmed-SO amount; COGS = the three-way
// fulfillment cost per order (the most-progressed booked stage wins — landed SI
// cost if invoiced, else DO ship-time cost if delivered, else the SO category
// cost); overhead = the project_cost_rates card applied to the fair's revenue.
// net_profit = revenue − COGS − overhead. Nothing here reads the DB — the route
// fetches, these functions decide.

/** The per-brand cost-rate card (project_cost_rates, mig 063). Percentages are
 *  plain integers (14 == 14%). `boost_min_sales` is a RINGGIT threshold — the
 *  project_finance_lines.amount unit — NOT centi; convert before comparing. */
export interface FairCostRate {
  transport_pct: number;
  merchandise_pct: number;
  commission_normal_pct: number;
  commission_boost_pct: number | null;
  boost_min_gp_pct: number | null;
  boost_min_sales: number | null;
}

export interface FairOverheads {
  transport_centi: number;
  merchandise_centi: number;
  commission_centi: number;
  commission_pct: number;       // the % actually applied (normal or boost)
  commission_is_boost: boolean;
  total_overhead_centi: number;
}

export function emptyOverheads(): FairOverheads {
  return { transport_centi: 0, merchandise_centi: 0, commission_centi: 0, commission_pct: 0, commission_is_boost: false, total_overhead_centi: 0 };
}

/**
 * Apply the per-brand rate card to a fair's revenue. MIRRORS the formula in
 * services/projectCostRates.ts (transport / merchandise / commission = % of
 * sales, and commission jumps to the boost rate only when the GP% gate AND the
 * sales gate both pass) — but operates in CENTI on the fair's own confirmed-SO
 * revenue rather than on the project_finance_lines ledger. The single source of
 * the RULE is the rate row; the two callers apply it in different units.
 *
 * `cogsCenti` is the fair's fulfillment cost, used only for the GP gate. A null
 * rate (no card for the brand) or non-positive revenue yields all-zero overhead.
 */
export function computeFairOverheads(input: { revenueCenti: number; cogsCenti: number; rate: FairCostRate | null }): FairOverheads {
  const rev = n(input.revenueCenti);
  const rate = input.rate;
  if (!rate || rev <= 0) return emptyOverheads();

  const cogs = n(input.cogsCenti);
  const gpPct = ((rev - cogs) / rev) * 100;
  // boost_min_sales is a whole-ringgit threshold; compare it to revenue in RM.
  const revenueRm = rev / 100;
  const gpGate = rate.boost_min_gp_pct == null || gpPct >= Number(rate.boost_min_gp_pct);
  const salesGate = rate.boost_min_sales == null || revenueRm >= Number(rate.boost_min_sales);
  const useBoost = rate.commission_boost_pct != null && gpGate && salesGate;
  const commissionPct = useBoost ? Number(rate.commission_boost_pct) : Number(rate.commission_normal_pct);

  const transport = Math.round((rev * Number(rate.transport_pct)) / 100);
  const merchandise = Math.round((rev * Number(rate.merchandise_pct)) / 100);
  const commission = Math.round((rev * commissionPct) / 100);
  return {
    transport_centi: transport,
    merchandise_centi: merchandise,
    commission_centi: commission,
    commission_pct: commissionPct,
    commission_is_boost: useBoost,
    total_overhead_centi: transport + merchandise + commission,
  };
}

export type PnlCostStage = 'so' | 'do' | 'invoice';

export interface FairPnlLineInput {
  amount_centi: number | null;       // revenue = product + service
  so_cost_centi: number | null;      // SO category cost (header total_cost)
  do_cost_centi: number | null;      // Σ linked DO cost, or null when no DO exists
  si_cost_centi: number | null;      // Σ linked SI cost, or null when no SI exists
}

export interface FairPnlLineCost {
  effective_cost_centi: number;
  effective_cost_stage: PnlCostStage;   // which arm the COGS came from
  gross_profit_centi: number;           // revenue − effective cost
  margin_pct: number | null;
}

/**
 * The COGS of one order: the most-PROGRESSED booked cost wins. A landed SI cost
 * is the truest figure, then the DO ship-time cost, then the SO category cost as
 * the always-present committed estimate. `null` do/si means that stage has not
 * happened for this order — NOT a zero cost — so it is skipped, never treated as
 * 0 (a 0 COGS would read as pure profit).
 */
export function fairPnlLineCost(i: FairPnlLineInput): FairPnlLineCost {
  const chosen =
    i.si_cost_centi != null ? { c: n(i.si_cost_centi), s: 'invoice' as const } :
    i.do_cost_centi != null ? { c: n(i.do_cost_centi), s: 'do' as const } :
                              { c: n(i.so_cost_centi), s: 'so' as const };
  const revenue = n(i.amount_centi);
  return {
    effective_cost_centi: chosen.c,
    effective_cost_stage: chosen.s,
    gross_profit_centi: revenue - chosen.c,
    margin_pct: marginPct(revenue, chosen.c),
  };
}

export interface FairPnlSummaryRow {
  amount_centi: number;
  selling_centi: number;
  service_rev_centi: number;
  so_cost_centi: number;
  do_cost_centi: number | null;
  si_cost_centi: number | null;
  effective_cost_centi: number;
}

export interface FairPnlSummary {
  orders: number;
  delivered_orders: number;    // orders that have at least one DO
  invoiced_orders: number;     // orders that have at least one SI
  total_revenue_centi: number;
  total_product_rev_centi: number;
  total_service_rev_centi: number;
  total_so_cost_centi: number;
  total_do_cost_centi: number;         // Σ over orders that have a DO
  total_si_cost_centi: number;         // Σ over orders that have an SI
  total_cogs_centi: number;            // Σ effective (most-progressed) cost
  gross_profit_centi: number;          // revenue − COGS
  gross_margin_pct: number | null;
  overheads: FairOverheads;
  net_profit_centi: number;            // gross − overhead
  net_margin_pct: number | null;
}

/** Fold the per-order P&L rows into fair totals, then subtract the rate-card
 *  overhead (computed on the fair's own revenue + COGS) to reach net profit. */
export function summarizeFairPnl(rows: readonly FairPnlSummaryRow[], rate: FairCostRate | null): FairPnlSummary {
  const s: FairPnlSummary = {
    orders: rows.length,
    delivered_orders: 0,
    invoiced_orders: 0,
    total_revenue_centi: 0,
    total_product_rev_centi: 0,
    total_service_rev_centi: 0,
    total_so_cost_centi: 0,
    total_do_cost_centi: 0,
    total_si_cost_centi: 0,
    total_cogs_centi: 0,
    gross_profit_centi: 0,
    gross_margin_pct: null,
    overheads: emptyOverheads(),
    net_profit_centi: 0,
    net_margin_pct: null,
  };
  for (const r of rows) {
    s.total_revenue_centi += n(r.amount_centi);
    s.total_product_rev_centi += n(r.selling_centi);
    s.total_service_rev_centi += n(r.service_rev_centi);
    s.total_so_cost_centi += n(r.so_cost_centi);
    if (r.do_cost_centi != null) { s.total_do_cost_centi += n(r.do_cost_centi); s.delivered_orders += 1; }
    if (r.si_cost_centi != null) { s.total_si_cost_centi += n(r.si_cost_centi); s.invoiced_orders += 1; }
    s.total_cogs_centi += n(r.effective_cost_centi);
  }
  s.gross_profit_centi = s.total_revenue_centi - s.total_cogs_centi;
  s.gross_margin_pct = marginPct(s.total_revenue_centi, s.total_cogs_centi);
  s.overheads = computeFairOverheads({ revenueCenti: s.total_revenue_centi, cogsCenti: s.total_cogs_centi, rate });
  s.net_profit_centi = s.gross_profit_centi - s.overheads.total_overhead_centi;
  s.net_margin_pct = s.total_revenue_centi === 0 ? null : (s.net_profit_centi / s.total_revenue_centi) * 100;
  return s;
}

// ── Filter helpers ───────────────────────────────────────────────────────────
export interface FairFilters {
  venue?: string | null;        // venue TEXT (venue_id is a dead scm.venues FK)
  state?: string | null;        // customer_state
  project?: number | null;      // project_id (int)
  branding?: string | null;
  salesperson?: string | null;  // salesperson_id (uuid)
  dateFrom?: string | null;     // YYYY-MM-DD (inclusive)
  dateTo?: string | null;       // YYYY-MM-DD (inclusive)
  month?: string | null;        // YYYY-MM
}

/**
 * Collapse `month` + `date_from`/`date_to` into one inclusive [from,to] window
 * on so_date. `month=YYYY-MM` expands to that calendar month; when it is
 * combined with an explicit from/to the two are AND-ed (the tighter bound wins
 * on each side). Returns nulls when unconstrained.
 */
export function resolveDateWindow(f: Pick<FairFilters, 'month' | 'dateFrom' | 'dateTo'>): { from: string | null; to: string | null } {
  let from = f.dateFrom && f.dateFrom.trim() ? f.dateFrom.trim() : null;
  let to = f.dateTo && f.dateTo.trim() ? f.dateTo.trim() : null;
  const m = (f.month ?? '').trim();
  if (/^\d{4}-\d{2}$/.test(m)) {
    const [y, mo] = m.split('-').map(Number);
    const first = `${m}-01`;
    // last day of month: day 0 of next month
    const lastDate = new Date(Date.UTC(y, mo, 0));
    const last = `${m}-${String(lastDate.getUTCDate()).padStart(2, '0')}`;
    from = from && from > first ? from : first;
    to = to && to < last ? to : last;
  }
  return { from, to };
}
