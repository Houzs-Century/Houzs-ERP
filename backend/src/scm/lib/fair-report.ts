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
// UNITS: every *_sen value is an integer number of cents (1/100 of MYR).
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

export type PaymentRow = { method: string | null; amount_sen: number | null };

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
    out[label] += Number(p.amount_sen ?? 0);
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
export function marginPct(revenueSen: number | null | undefined, costSen: number | null | undefined): number | null {
  const rev = n(revenueSen);
  if (rev === 0) return null;
  return ((rev - n(costSen)) / rev) * 100;
}

/**
 * below_deposit — the SO has taken (at most) its deposit and still has money
 * outstanding. No pre-existing "below deposit" helper exists in the codebase
 * (verified), so this is the definition of record: balance still owing AND the
 * ledger has collected no more than the agreed deposit. `paidSen` is the LIVE
 * ledger total (sum of mfg_sales_order_payments.amount_sen), not the possibly
 * stale mfg_sales_orders.paid_sen column.
 */
export function belowDeposit(o: {
  balanceSen: number | null | undefined;
  depositSen: number | null | undefined;
  paidSen: number | null | undefined;
}): boolean {
  return n(o.balanceSen) > 0 && n(o.paidSen) <= n(o.depositSen);
}

// ── stage=so row ─────────────────────────────────────────────────────────────
export interface FairSoInputs {
  // header money
  local_total_sen: number | null;               // amount = product + service
  mattress_sofa_sen: number | null;
  bedframe_sen: number | null;
  accessories_sen: number | null;
  others_sen: number | null;
  service_sen: number | null;                    // service revenue
  mattress_sofa_cost_sen: number | null;
  bedframe_cost_sen: number | null;
  accessories_cost_sen: number | null;
  others_cost_sen: number | null;
  service_cost_sen: number | null;
  total_cost_sen: number | null;
  deposit_sen: number | null;
}

export interface FairSoMoney {
  amount_sen: number;          // total = product + service
  selling_sen: number;         // PRODUCT only (mattress_sofa+bedframe+accessories+others), EXCLUDING service
  service_rev_sen: number;     // service revenue
  cost_by_category: {
    mattress_sofa_cost_sen: number;
    bedframe_cost_sen: number;
    accessories_cost_sen: number;
    others_cost_sen: number;
    service_cost_sen: number;
  };
  total_so_cost_sen: number;   // total_cost_sen
  margin_pct: number | null;
}

/**
 * WHAT THE ORDER STILL OWES, for the Fair Report's Balance column.
 *
 * NOT `mfg_sales_orders.balance_sen`. That column is not a balance:
 * `recomputeTotals` writes `balance_sen = local_total_sen = total_revenue_sen =
 * grandTotal` on every edit, so it never reflects a payment — the reasoning is
 * written out in full in `scm/shared/so-outstanding.ts`, which exists because
 * this exact column keeps being read as the balance. Measured on production
 * 2026-08-21 (`backend/scripts/check-report-money.mjs`, run 32466500870): 85 of
 * 103 live orders carried a `balance_sen` equal to their full order value while
 * the ledger held RM 238,652.50 of payments — RM 132,869.50 of it on the 51
 * CONFIRMED orders that ARE this report's row set.
 *
 * `paidSen` must come from `soPaidSen` (so-outstanding.ts), which owns the
 * legacy-deposit rule: the header `deposit_sen` counts only when the ledger has
 * no `is_deposit` row, or every modern order double-counts its deposit.
 *
 * It is subtracted from the SAME `amount_sen` this report prints, not from
 * `total_revenue_sen`, so the Balance column always reconciles with the Amount
 * column beside it. That is why this is not `soBalanceSen`: that function
 * deliberately answers 0 when `total_revenue_sen` is 0, to keep a negative out
 * of AutoCount's `UDF_BALANCE`, and a report that printed a large Amount next
 * to a 0 Balance would just be inconsistent in a different place.
 *
 * Signed on purpose — an over-collected order reads negative, which the owner
 * asked to see rather than have clamped away.
 */
export function fairBalanceSen(amountSen: number | null | undefined, paidSen: number | null | undefined): number {
  return n(amountSen) - n(paidSen);
}

/** Assemble the money half of a stage=so row from the SO header columns. */
export function fairSoMoney(h: FairSoInputs): FairSoMoney {
  const selling =
    n(h.mattress_sofa_sen) + n(h.bedframe_sen) + n(h.accessories_sen) + n(h.others_sen);
  const serviceRev = n(h.service_sen);
  // amount = product + service. Prefer the persisted order total; fall back to
  // the reconstructed sum when local_total_sen is 0/absent.
  const amount = n(h.local_total_sen) || selling + serviceRev;
  const totalCost = n(h.total_cost_sen);
  return {
    amount_sen: amount,
    selling_sen: selling,
    service_rev_sen: serviceRev,
    cost_by_category: {
      mattress_sofa_cost_sen: n(h.mattress_sofa_cost_sen),
      bedframe_cost_sen: n(h.bedframe_cost_sen),
      accessories_cost_sen: n(h.accessories_cost_sen),
      others_cost_sen: n(h.others_cost_sen),
      service_cost_sen: n(h.service_cost_sen),
    },
    total_so_cost_sen: totalCost,
    margin_pct: marginPct(amount, totalCost),
  };
}

// ── stage=do cost comparison ─────────────────────────────────────────────────
export type DoCostLine = {
  qty: number | null;
  unit_cost_sen: number | null;
  ship_cost_sen: number | null;   // frozen ship-time FIFO (mig 0143); NULL on legacy DOs
  /** The line's category. SERVICE lines (delivery fee, installation) are not
   *  stock and never carry a frozen cost, so they must not decide the LEGACY
   *  verdict — see the note on `is_legacy`. Absent/unknown counts as stock. */
  item_group?: string | null;
};

const isServiceGroup = (g: string | null | undefined): boolean => (g ?? '').trim().toLowerCase() === 'service';

/** total_do_cost = Σ COALESCE(ship_cost_sen, unit_cost_sen) × qty over the
 *  DO's lines (reuse of the Fulfillment Costing ② rule, #800). Also reports the
 *  delivered qty and two flags the report shows as chips:
 *
 *  `is_legacy` — a STOCK line fell back to the order-time estimate because it
 *  carries no frozen ship cost (a DO written before mig 0143). Owner's Sales
 *  Report review 2026-08-31: this used to be set by ANY null, and the delivery
 *  fee line is null by nature, so 11 of 14 rows on screen wore the chip and the
 *  "pre-FIFO" KPI counted service lines. Service lines are now excluded from
 *  the verdict; their cost still sums exactly as before.
 *
 *  `has_zero_frozen` — a stock line froze at ZERO while its order-time estimate
 *  was non-zero: the ship-anyway fingerprint (goods left before any lot existed,
 *  so FIFO had nothing to consume — 2990-DO-2607-021). The zero is the truth and
 *  is NOT patched over; the flag exists so a naked 100% margin does not read as
 *  a free sale. A line that is genuinely free (no estimate either) is not
 *  flagged. */
export function doCostTotal(lines: readonly DoCostLine[]): {
  total_do_cost_sen: number; qty: number; is_legacy: boolean; has_zero_frozen: boolean;
} {
  let total = 0;
  let qty = 0;
  let legacy = false;
  let zeroFrozen = false;
  for (const l of lines) {
    const q = n(l.qty);
    qty += q;
    const service = isServiceGroup(l.item_group);
    const unit = l.ship_cost_sen != null ? n(l.ship_cost_sen) : n(l.unit_cost_sen);
    if (l.ship_cost_sen == null && !service) legacy = true;
    if (!service && l.ship_cost_sen != null && n(l.ship_cost_sen) === 0 && n(l.unit_cost_sen) > 0) zeroFrozen = true;
    total += unit * q;
  }
  return { total_do_cost_sen: total, qty, is_legacy: legacy, has_zero_frozen: zeroFrozen };
}

// ── stage=invoice cost progression ───────────────────────────────────────────
export type SiCostLine = { qty: number | null; unit_cost_sen: number | null; line_cost_sen: number | null };

/** landed (SI) cost = Σ line_cost_sen (fall back unit×qty) over the SI lines. */
export function siCostTotal(lines: readonly SiCostLine[]): number {
  let total = 0;
  for (const l of lines) {
    total += l.line_cost_sen != null ? n(l.line_cost_sen) : n(l.unit_cost_sen) * n(l.qty);
  }
  return total;
}

// ── Summaries (per-stage KPI header cards) ───────────────────────────────────
export interface FairSoSummary {
  orders: number;
  total_amount_sen: number;
  total_selling_sen: number;
  total_service_rev_sen: number;
  total_so_cost_sen: number;
  total_margin_sen: number;
  margin_pct: number | null;
  total_balance_sen: number;
  below_deposit_count: number;
  tender_totals: TenderSplit;
}

export function summarizeSo(
  rows: ReadonlyArray<{
    amount_sen: number;
    selling_sen: number;
    service_rev_sen: number;
    total_so_cost_sen: number;
    balance_sen: number;
    below_deposit: boolean;
    deposit_by_tender: TenderSplit;
  }>,
): FairSoSummary {
  const s: FairSoSummary = {
    orders: rows.length,
    total_amount_sen: 0,
    total_selling_sen: 0,
    total_service_rev_sen: 0,
    total_so_cost_sen: 0,
    total_margin_sen: 0,
    margin_pct: null,
    total_balance_sen: 0,
    below_deposit_count: 0,
    tender_totals: emptyTenderSplit(),
  };
  for (const r of rows) {
    s.total_amount_sen += r.amount_sen;
    s.total_selling_sen += r.selling_sen;
    s.total_service_rev_sen += r.service_rev_sen;
    s.total_so_cost_sen += r.total_so_cost_sen;
    s.total_balance_sen += r.balance_sen;
    if (r.below_deposit) s.below_deposit_count += 1;
    for (const t of TENDER_LABELS) s.tender_totals[t] += r.deposit_by_tender[t];
  }
  s.total_margin_sen = s.total_amount_sen - s.total_so_cost_sen;
  s.margin_pct = marginPct(s.total_amount_sen, s.total_so_cost_sen);
  return s;
}

export interface FairDoSummary {
  deliveries: number;
  total_so_cost_sen: number;
  total_do_cost_sen: number;
  cost_delta_sen: number;   // do − so (positive = cost grew at delivery)
  legacy_count: number;
}

export function summarizeDo(
  rows: ReadonlyArray<{ total_so_cost_sen: number; total_do_cost_sen: number; do_cost_is_legacy: boolean }>,
): FairDoSummary {
  const s: FairDoSummary = { deliveries: rows.length, total_so_cost_sen: 0, total_do_cost_sen: 0, cost_delta_sen: 0, legacy_count: 0 };
  for (const r of rows) {
    s.total_so_cost_sen += r.total_so_cost_sen;
    s.total_do_cost_sen += r.total_do_cost_sen;
    if (r.do_cost_is_legacy) s.legacy_count += 1;
  }
  s.cost_delta_sen = s.total_do_cost_sen - s.total_so_cost_sen;
  return s;
}

export interface FairInvoiceSummary {
  invoices: number;
  total_invoiced_sen: number;
  total_so_cost_sen: number;
  total_do_cost_sen: number;
  total_si_cost_sen: number;   // landed
  margin_pct: number | null;     // invoiced vs landed
}

export function summarizeInvoice(
  rows: ReadonlyArray<{ invoiced_sen: number; so_cost_sen: number; do_cost_sen: number; si_cost_sen: number }>,
): FairInvoiceSummary {
  const s: FairInvoiceSummary = { invoices: rows.length, total_invoiced_sen: 0, total_so_cost_sen: 0, total_do_cost_sen: 0, total_si_cost_sen: 0, margin_pct: null };
  for (const r of rows) {
    s.total_invoiced_sen += r.invoiced_sen;
    s.total_so_cost_sen += r.so_cost_sen;
    s.total_do_cost_sen += r.do_cost_sen;
    s.total_si_cost_sen += r.si_cost_sen;
  }
  s.margin_pct = marginPct(s.total_invoiced_sen, s.total_si_cost_sen);
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
  transport_sen: number;
  merchandise_sen: number;
  commission_sen: number;
  commission_pct: number;       // the % actually applied (normal or boost)
  commission_is_boost: boolean;
  total_overhead_sen: number;
}

export function emptyOverheads(): FairOverheads {
  return { transport_sen: 0, merchandise_sen: 0, commission_sen: 0, commission_pct: 0, commission_is_boost: false, total_overhead_sen: 0 };
}

/**
 * Apply the per-brand rate card to a fair's revenue. MIRRORS the formula in
 * services/projectCostRates.ts (transport / merchandise / commission = % of
 * sales, and commission jumps to the boost rate only when the GP% gate AND the
 * sales gate both pass) — but operates in SEN on the fair's own confirmed-SO
 * revenue rather than on the project_finance_lines ledger. The single source of
 * the RULE is the rate row; the two callers apply it in different units.
 *
 * `cogsSen` is the fair's fulfillment cost, used only for the GP gate. A null
 * rate (no card for the brand) or non-positive revenue yields all-zero overhead.
 */
export function computeFairOverheads(input: { revenueSen: number; cogsSen: number; rate: FairCostRate | null }): FairOverheads {
  const rev = n(input.revenueSen);
  const rate = input.rate;
  if (!rate || rev <= 0) return emptyOverheads();

  const cogs = n(input.cogsSen);
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
    transport_sen: transport,
    merchandise_sen: merchandise,
    commission_sen: commission,
    commission_pct: commissionPct,
    commission_is_boost: useBoost,
    total_overhead_sen: transport + merchandise + commission,
  };
}

export type PnlCostStage = 'so' | 'do' | 'invoice';

export interface FairPnlLineInput {
  amount_sen: number | null;       // revenue = product + service
  so_cost_sen: number | null;      // SO category cost (header total_cost)
  do_cost_sen: number | null;      // Σ linked DO cost, or null when no DO exists
  si_cost_sen: number | null;      // Σ linked SI cost, or null when no SI exists
}

export interface FairPnlLineCost {
  effective_cost_sen: number;
  effective_cost_stage: PnlCostStage;   // which arm the COGS came from
  gross_profit_sen: number;           // revenue − effective cost
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
    i.si_cost_sen != null ? { c: n(i.si_cost_sen), s: 'invoice' as const } :
    i.do_cost_sen != null ? { c: n(i.do_cost_sen), s: 'do' as const } :
                              { c: n(i.so_cost_sen), s: 'so' as const };
  const revenue = n(i.amount_sen);
  return {
    effective_cost_sen: chosen.c,
    effective_cost_stage: chosen.s,
    gross_profit_sen: revenue - chosen.c,
    margin_pct: marginPct(revenue, chosen.c),
  };
}

export interface FairPnlSummaryRow {
  amount_sen: number;
  selling_sen: number;
  service_rev_sen: number;
  so_cost_sen: number;
  do_cost_sen: number | null;
  si_cost_sen: number | null;
  effective_cost_sen: number;
}

export interface FairPnlSummary {
  orders: number;
  delivered_orders: number;    // orders that have at least one DO
  invoiced_orders: number;     // orders that have at least one SI
  total_revenue_sen: number;
  total_product_rev_sen: number;
  total_service_rev_sen: number;
  total_so_cost_sen: number;
  total_do_cost_sen: number;         // Σ over orders that have a DO
  total_si_cost_sen: number;         // Σ over orders that have an SI
  total_cogs_sen: number;            // Σ effective (most-progressed) cost
  gross_profit_sen: number;          // revenue − COGS
  gross_margin_pct: number | null;
  overheads: FairOverheads;
  net_profit_sen: number;            // gross − overhead
  net_margin_pct: number | null;
}

/** Fold the per-order P&L rows into fair totals, then subtract the rate-card
 *  overhead (computed on the fair's own revenue + COGS) to reach net profit. */
export function summarizeFairPnl(rows: readonly FairPnlSummaryRow[], rate: FairCostRate | null): FairPnlSummary {
  const s: FairPnlSummary = {
    orders: rows.length,
    delivered_orders: 0,
    invoiced_orders: 0,
    total_revenue_sen: 0,
    total_product_rev_sen: 0,
    total_service_rev_sen: 0,
    total_so_cost_sen: 0,
    total_do_cost_sen: 0,
    total_si_cost_sen: 0,
    total_cogs_sen: 0,
    gross_profit_sen: 0,
    gross_margin_pct: null,
    overheads: emptyOverheads(),
    net_profit_sen: 0,
    net_margin_pct: null,
  };
  for (const r of rows) {
    s.total_revenue_sen += n(r.amount_sen);
    s.total_product_rev_sen += n(r.selling_sen);
    s.total_service_rev_sen += n(r.service_rev_sen);
    s.total_so_cost_sen += n(r.so_cost_sen);
    if (r.do_cost_sen != null) { s.total_do_cost_sen += n(r.do_cost_sen); s.delivered_orders += 1; }
    if (r.si_cost_sen != null) { s.total_si_cost_sen += n(r.si_cost_sen); s.invoiced_orders += 1; }
    s.total_cogs_sen += n(r.effective_cost_sen);
  }
  s.gross_profit_sen = s.total_revenue_sen - s.total_cogs_sen;
  s.gross_margin_pct = marginPct(s.total_revenue_sen, s.total_cogs_sen);
  s.overheads = computeFairOverheads({ revenueSen: s.total_revenue_sen, cogsSen: s.total_cogs_sen, rate });
  s.net_profit_sen = s.gross_profit_sen - s.overheads.total_overhead_sen;
  s.net_margin_pct = s.total_revenue_sen === 0 ? null : (s.net_profit_sen / s.total_revenue_sen) * 100;
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
