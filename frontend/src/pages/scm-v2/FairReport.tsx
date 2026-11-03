// ----------------------------------------------------------------------------
// FairReport — the Sales report: exhibition sales by document stage (Sales
// Orders / Delivery Orders / Invoices / P&L, and Costing Gaps for management),
// each anchored on the fair — the exhibition PROJECT hard-linked to every SO.
//
// In the owner's Claude Design (batch 6 §5.8, step 14), inside the Finance
// report shell: the shared range (the orders' SO date) and Venue / State /
// Project / Fair / Branding / Salesperson in the toolbar; the stage tabs; four
// tiles from the stage's own summary; the bar (title, count, Clear filters,
// the optional column groups as chips, Table / Cards); the stage's line of
// description; the Finance-Table. The P&L shows WITHOUT a fair picked: every
// fair with orders in the period (read c7), a click opening that fair's P&L
// with "All fairs" to go back; a fair with no order in the dates offers its
// own dates. Excel / PDF / Print draw the stage as shown; the CSV is under ⋯.
//
// Wired to GET /scm/reports/fair-report (per-stage rows + KPI summary; on the
// P&L with no fair, `fairs`) and /scm/reports/fair-report/:docNo (the order
// quick view: an SO number opens it, a double-click opens the order itself).
// The server does the fair-anchoring, the money splits and every summary —
// this page renders and filters.
//
// PERMISSION mirrors the backend fairReportAccess exactly (auth/salesAccess):
//   * ordinary salespeople → no access (nav absent + FairReportGuard 403s)
//   * Sales Director        → Sales Orders only
//   * management            → every stage, and Costing Gaps
// The backend still 403s every refused stage; the page never shows a tab whose
// read the backend would refuse.
//
// URL IS STATE: the stage, the five filters, the view, the hidden column
// groups and the open order ride the address beside the shared range — and
// how the dates pick the rows (owner 2026-11-03: 「都要」): by the orders' SO
// date (the default) or, with dates=stage, each stage by its own date.
// ----------------------------------------------------------------------------

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ArrowLeft, Check, Plus, X } from 'lucide-react';
import { ReportShell } from './reports/ReportShell';
import { DataTable, type Column } from '../../components/DataTable';
import { buildVariantSummary, fmtQty, orderLineIdentity } from '@2990s/shared';
import { fmtDate, fmtDateOrDash, fmtSenPlain } from '../../vendor/shared/format';
import { useAuth } from '../../auth/AuthContext';
import { fairAllowedStages, isFairManagementUser } from '../../auth/salesAccess';
import { useOpenDocInTab } from '../../lib/openDocInTab';
import { monthEnd } from '../../lib/dateRangePresets';
import {
  useFairReport,
  useFairReportDetail,
  useCostingGapListing,
  fairReportErrorInfo,
  type FairStage,
  type FairCostingGapRow,
  type FairFilters,
  type FairDims,
  type FairSoRow,
  type FairDoRow,
  type FairInvoiceRow,
  type FairPnlRow,
  type FairPnlFairRow,
  type FairPnlResponse,
  type FairReportResponse,
  type FairCostByCategory,
} from '../../vendor/scm/lib/fair-report-queries';
import type { ReportSheet, SheetColumn, SheetRow, SheetValue } from '../../vendor/scm/lib/report-sheet';
import { FinanceDateRange } from './reports/FinanceDateRange';
import {
  ReportExports, ReportHeaderActions, ReportMessage, ReportMore, ReportTiles, ReportTool, ReportToolbar, Segmented, useReportSubtitle,
  type ReportTile,
} from './reports/reportParts';
import { periodLabel } from './reports/statementColumns';
import { useReportRange } from './reports/useReportRange';
import sr from './reports/SalesReport.module.css';

// ── money / number formatting ────────────────────────────────────────────────
/** A grid cell: nothing reads as a dash, so a wide grid reads cleanly. */
const cell = (sen: number | null | undefined): string => (sen ? fmtSenPlain(sen) : '—');
/** A tile or the quick view: 0.00 is a figure. */
const money = (sen: number | null | undefined): string => fmtSenPlain(sen ?? 0);
const pct = (p: number | null | undefined): string => (p == null ? '—' : `${p.toFixed(1)}%`);
const pctOf = (part: number, whole: number): number | null => (whole === 0 ? null : (part / whole) * 100);
/** Signed points for a margin drift (DO vs SO). */
const pts = (a: number | null | undefined, b: number | null | undefined): string => {
  if (a == null || b == null) return '—';
  const d = a - b;
  return `${d > 0 ? '+' : ''}${d.toFixed(1)} pts`;
};
const signedMoney = (sen: number | null | undefined): string => {
  const v = Number(sen ?? 0);
  if (!v) return '—';
  return `${v > 0 ? '+' : '−'}${fmtSenPlain(Math.abs(v))}`;
};
/** A rate card's figure: 5 → "5%", 2.5 → "2.5%". */
const ratePct = (v: number | null | undefined): string => `${Number(v ?? 0)}%`;
const plural = (n: number, one: string, many = `${one}s`): string => `${n.toLocaleString('en-MY')} ${n === 1 ? one : many}`;

// 'gaps' is a FRONTEND-ONLY tab (its own /reports/costing-gap-listing endpoint),
// NOT a fair-report stage — so it is kept out of FairStage (which mirrors the
// backend FAIR_STAGES) and lives only as a tab key here.
type TabKey = FairStage | 'gaps';
const STAGE_LABELS: Record<TabKey, string> = { so: 'Sales Orders', do: 'Delivery Orders', invoice: 'Invoices', pnl: 'P&L', gaps: 'Costing Gaps' };

// Optional column groups per stage — the chips in the bar turn these off and on.
const OPTIONAL_GROUPS: Record<TabKey, { key: string; label: string }[]> = {
  so: [
    { key: 'catcost', label: 'Cost by category' },
    { key: 'tender', label: 'Deposit by tender' },
  ],
  do: [{ key: 'drift', label: 'Margin drift' }],
  invoice: [{ key: 'progression', label: 'Cost progression (SO / DO)' }],
  pnl: [{ key: 'threeway', label: 'Three-way cost (SO / DO / SI)' }],
  gaps: [],
};

/* The line under the bar: what the stage shows. By default every stage picks
   its orders by their SO date (the server's one window), so no line claims
   another; with each stage by its own date the Delivery Orders and Invoices
   lines say which date picks them. */
const DESCRIPTIONS = {
  so: 'Orders taken at the fair, by SO date: the amount, the cost estimated when the order was taken, the deposit paid and the balance left.',
  do: 'The same orders once delivered: the cost frozen when the goods left the warehouse (FIFO) against the cost estimated at order. Cost Δ is what the wait changed.',
  doOwn: 'Deliveries dated in the period — the day delivered, else the DO’s own date: the cost frozen when the goods left the warehouse (FIFO) against the cost estimated at order. Cost Δ is what the wait changed.',
  invoice: 'The same orders once invoiced: the invoiced amount against the landed cost, the supplier’s actual cost once its purchase invoice is in. A fair’s orders can be delivered and invoiced in a later month than the fair.',
  invoiceOwn: 'Invoices dated in the period, whatever their order’s date: the invoiced amount against the landed cost, the supplier’s actual cost once its purchase invoice is in.',
  pnlFair: 'Each order of the fair, with COGS from the latest stage it has reached: the invoice (SI) when invoiced, else the delivery (DO), else the order (SO).',
  pnlEvery: 'Every fair with orders in the period: revenue, COGS at the latest stage each order has reached, overhead and net profit.',
  gaps: 'Order lines with no cost whose product has no cost either — the products to fill in Product Maintenance. Every order, whatever the dates and filters.',
} as const;

/** How the dates pick the rows (owner 2026-11-03: 「都要」): the address keeps it as `dates=stage`. */
type DateBasis = 'so' | 'stage';
const DATE_BASES: ReadonlyArray<{ value: DateBasis; label: string }> = [
  { value: 'so', label: 'SO date' },
  { value: 'stage', label: 'Each stage’s own date' },
];
/** What the grey line says picks the rows on this stage. */
export function datesLine(basis: DateBasis, stage: FairStage): string {
  if (basis === 'so') return 'the dates pick orders by SO date';
  if (stage === 'do') return 'each stage by its own date: deliveries by DO date';
  if (stage === 'invoice') return 'each stage by its own date: invoices by invoice date';
  return `each stage by its own date: ${stage === 'pnl' ? 'the P&L' : 'orders'} by SO date`;
}

const PICK_KEYS = ['venue', 'state', 'project', 'branding', 'salesperson'] as const;
const LEGACY_DATE_KEYS = ['month', 'date_from', 'date_to'] as const;

/** An address from before the shared range — `month`, `date_from`, `date_to` —
 *  as the range it meant (the month and the dates AND-ed, as the server did). */
export function legacyRange(sp: URLSearchParams): { from: string; to: string } | null {
  if (sp.has('from') || sp.has('to')) return null;
  const month = sp.get('month') ?? '';
  let from = sp.get('date_from') ?? '';
  let to = sp.get('date_to') ?? '';
  if (/^\d{4}-\d{2}$/.test(month)) {
    const first = `${month}-01`;
    const last = monthEnd(first);
    from = from && from > first ? from : first;
    to = to && to < last ? to : last;
  }
  return from && to ? { from, to } : null;
}

// ── filter options ───────────────────────────────────────────────────────────
type OptionMaps = {
  venues: string[];
  projects: Record<string, string>;
  states: string[];
  brandings: string[];
  salespersons: Record<string, string>;
};
const EMPTY_OPTS: OptionMaps = { venues: [], projects: {}, states: [], brandings: [], salespersons: {} };
type FairOf = Pick<FairDims, 'project_id' | 'project' | 'project_start_date' | 'project_end_date'>;

const fairDates = (f: Pick<FairOf, 'project_start_date' | 'project_end_date'>): string =>
  (f.project_start_date ? `${fmtDate(f.project_start_date)}${f.project_end_date ? ` – ${fmtDate(f.project_end_date)}` : ''}` : '');

/** Merge the distinct filter values carried on a batch of rows (and fairs) into
 *  the running option set. Accumulated (never shrinks) so a dropdown stays
 *  usable after a filter narrows the result. Returns `prev` unchanged when
 *  nothing is new. */
function accumulate(prev: OptionMaps, rows: readonly FairDims[], fairs: readonly FairOf[]): OptionMaps {
  const venues = new Set(prev.venues);
  const projects = { ...prev.projects };
  const states = new Set(prev.states);
  const brandings = new Set(prev.brandings);
  const salespersons = { ...prev.salespersons };
  let changed = false;
  for (const f of [...rows, ...fairs]) {
    if (f.project_id != null && f.project) {
      const when = fairDates(f);
      const label = when ? `${f.project} · ${when}` : f.project;
      if (projects[String(f.project_id)] !== label) { projects[String(f.project_id)] = label; changed = true; }
    }
  }
  for (const r of rows) {
    // Venue keys on the TEXT (venue_id is a dead scm.venues FK, NULL on modern SOs).
    if (r.venue && !venues.has(r.venue)) { venues.add(r.venue); changed = true; }
    if (r.state && !states.has(r.state)) { states.add(r.state); changed = true; }
    if (r.branding && !brandings.has(r.branding)) { brandings.add(r.branding); changed = true; }
    if (r.salesperson_id && r.salesperson && salespersons[r.salesperson_id] !== r.salesperson) { salespersons[r.salesperson_id] = r.salesperson; changed = true; }
  }
  if (!changed) return prev;
  return {
    projects, salespersons,
    venues: [...venues].sort((a, b) => a.localeCompare(b)),
    states: [...states].sort((a, b) => a.localeCompare(b)),
    brandings: [...brandings].sort((a, b) => a.localeCompare(b)),
  };
}

const catRows = (c: FairCostByCategory): [string, number][] => [
  ['Mattress / Sofa', c.mattress_sofa_cost_sen],
  ['Bedframe', c.bedframe_cost_sen],
  ['Accessories', c.accessories_cost_sen],
  ['Others', c.others_cost_sen],
  ['Service', c.service_cost_sen],
];

// ── tiles ────────────────────────────────────────────────────────────────────
const TILE_LABELS = {
  so: ['Total orders', 'Revenue', 'Outstanding', 'Paid'],
  do: ['Delivered orders', 'SO-time cost', 'DO cost (ship-time)', 'Cost drift'],
  invoice: ['Invoices', 'Invoiced amount', 'Landed (SI) cost', 'Invoiced margin'],
  pnlFair: ['Fair revenue', 'Gross profit', 'Overhead', 'Net profit'],
  pnlEvery: ['Fairs', 'Fair revenue', 'Gross profit', 'Net profit'],
} as const;
const sumOf = <R,>(rows: readonly R[], f: (r: R) => number | null | undefined): number =>
  rows.reduce((acc, r) => acc + Number(f(r) ?? 0), 0);

/** The every-fair totals: the fairs' own figures added up, the margins of the sums. */
export function everyFairTotals(fairs: readonly FairPnlFairRow[]) {
  const t = {
    fairs: fairs.length,
    orders: sumOf(fairs, (f) => f.summary.orders),
    revenue: sumOf(fairs, (f) => f.summary.total_revenue_sen),
    cogs: sumOf(fairs, (f) => f.summary.total_cogs_sen),
    gross: sumOf(fairs, (f) => f.summary.gross_profit_sen),
    overhead: sumOf(fairs, (f) => f.summary.overheads.total_overhead_sen),
    net: sumOf(fairs, (f) => f.summary.net_profit_sen),
  };
  return { ...t, grossPct: pctOf(t.gross, t.revenue), netPct: pctOf(t.net, t.revenue) };
}

/** What the picked fair's overhead is made of, from its card. */
function overheadMakeup(d: FairPnlResponse): string {
  if (!d.meta.rate_present) return `No cost-rate card${d.meta.brand ? ` for ${d.meta.brand}` : ' for this fair’s brand'}`;
  const o = d.summary.overheads;
  const rate = d.meta.rate;
  const boost = o.commission_is_boost ? ' · boost' : '';
  if (!rate) return `Transport + merchandise + commission ${ratePct(o.commission_pct)}${boost}`;
  return `Transport ${ratePct(rate.transport_pct)} + merchandise ${ratePct(rate.merchandise_pct)} + commission ${ratePct(o.commission_pct)}${boost}`;
}

/** The four figures over the stage, from its own summary (the server's). */
export function salesTiles(d: FairReportResponse, period: string): ReportTile[] {
  if (d.stage === 'so') {
    const s = d.summary;
    return [
      { key: 'orders', label: 'Total orders', value: s.orders.toLocaleString('en-MY'), sub: 'Confirmed, matching the filters' },
      { key: 'revenue', label: 'Revenue', value: money(s.total_amount_sen), sub: `${pct(s.margin_pct)} margin · goods only` },
      { key: 'outstanding', label: 'Outstanding', value: money(s.total_balance_sen), sub: `${s.below_deposit_count} below deposit`, tone: s.total_balance_sen > 0 ? 'late' : 'plain' },
      { key: 'paid', label: 'Paid', value: money(sumOf(d.rows, (r) => r.paid_total_sen)), sub: 'Deposits collected', tone: 'good' },
    ];
  }
  if (d.stage === 'do') {
    const s = d.summary;
    return [
      { key: 'delivered', label: 'Delivered orders', value: s.deliveries.toLocaleString('en-MY'), sub: 'DOs in these filters' },
      { key: 'soCost', label: 'SO-time cost', value: money(s.total_so_cost_sen), sub: 'Cost estimated at order' },
      { key: 'doCost', label: 'DO cost (ship-time)', value: money(s.total_do_cost_sen), sub: 'Frozen FIFO at delivery' },
      {
        key: 'drift', label: 'Cost drift', value: signedMoney(s.cost_delta_sen),
        sub: s.legacy_count ? `${s.legacy_count} legacy (before FIFO)` : 'Delivery delay impact',
        tone: s.cost_delta_sen > 0 ? 'late' : s.cost_delta_sen < 0 ? 'good' : 'plain',
      },
    ];
  }
  if (d.stage === 'invoice') {
    const s = d.summary;
    return [
      { key: 'invoice_count', label: 'Invoices', value: s.invoices.toLocaleString('en-MY'), sub: 'SIs in these filters' },
      { key: 'invoiced', label: 'Invoiced amount', value: money(s.total_invoiced_sen), sub: 'Billed to date' },
      { key: 'landed', label: 'Landed (SI) cost', value: money(s.total_si_cost_sen), sub: 'Store card after the PI lands' },
      { key: 'margin', label: 'Invoiced margin', value: pct(s.margin_pct), sub: 'Goods only · invoiced − landed', tone: (s.margin_pct ?? 0) < 0 ? 'late' : 'good' },
    ];
  }
  if (d.meta.needs_project) {
    const t = everyFairTotals(d.fairs ?? []);
    return [
      { key: 'project_count', label: 'Fairs', value: t.fairs.toLocaleString('en-MY'), sub: `With orders in ${period}` },
      { key: 'revenue', label: 'Fair revenue', value: money(t.revenue), sub: plural(t.orders, 'confirmed order') },
      { key: 'gross', label: 'Gross profit', value: money(t.gross), sub: `${pct(t.grossPct)} · COGS ${money(t.cogs)}`, tone: t.gross < 0 ? 'late' : 'good' },
      { key: 'net', label: 'Net profit', value: money(t.net), sub: `${pct(t.netPct)} net margin · after ${money(t.overhead)} overhead`, tone: t.net < 0 ? 'late' : 'plain' },
    ];
  }
  const p = d.summary;
  return [
    { key: 'revenue', label: 'Fair revenue', value: money(p.total_revenue_sen), sub: plural(p.orders, 'confirmed order') },
    { key: 'gross', label: 'Gross profit', value: money(p.gross_profit_sen), sub: `${pct(p.gross_margin_pct)} · COGS ${money(p.total_cogs_sen)}`, tone: p.gross_profit_sen < 0 ? 'late' : 'good' },
    { key: 'overhead_cost', label: 'Overhead', value: money(p.overheads.total_overhead_sen), sub: overheadMakeup(d) },
    { key: 'net', label: 'Net profit', value: money(p.net_profit_sen), sub: `${pct(p.net_margin_pct)} net margin`, tone: p.net_profit_sen < 0 ? 'late' : 'plain' },
  ];
}

// ── columns (one list draws the table AND the sheet) ─────────────────────────
type SheetSpec<R> = { kind: SheetColumn['kind']; value: (r: R) => SheetValue; total?: (rows: readonly R[]) => SheetValue };
/** A table column that also says what it prints: `sheet` for a figure column,
 *  `sheetLabel` for the one that names the row on paper. */
type SalesCol<R> = Column<R> & { sheet?: SheetSpec<R>; sheetLabel?: (r: R) => string };

const marginOf = (revenue: number, cost: number): number | null => pctOf(revenue - cost, revenue);
const toneCls = (v: number | null | undefined): string => ((v ?? 0) >= 0 ? sr.good : sr.late);

const moneyCol = <R,>(key: string, label: string, f: (r: R) => number | null | undefined, extra?: Partial<SalesCol<R>>): SalesCol<R> => ({
  key, label, align: 'right',
  getValue: (r) => Number(f(r) ?? 0),
  exportValue: (r) => Number(f(r) ?? 0) / 100, exportFormat: 'money',
  render: (r) => cell(f(r)),
  total: (rows) => cell(sumOf(rows, f)),
  sheet: { kind: 'amount', value: (r) => { const v = f(r); return v ? Number(v) : null; }, total: (rows) => sumOf(rows, f) },
  ...extra,
});
const toneMoneyCol = <R,>(key: string, label: string, f: (r: R) => number | null | undefined): SalesCol<R> => moneyCol(key, label, f, {
  render: (r) => <span className={toneCls(f(r))}>{cell(f(r))}</span>,
  total: (rows) => { const g = sumOf(rows, f); return <span className={toneCls(g)}>{cell(g)}</span>; },
});
const textCol = <R,>(key: string, label: string, f: (r: R) => string | null | undefined): SalesCol<R> => ({
  key, label, getValue: (r) => f(r) ?? '', render: (r) => f(r) ?? '—',
  sheet: { kind: 'text', value: (r) => f(r) ?? null },
});
const dateCol = <R,>(key: string, label: string, f: (r: R) => string | null | undefined): SalesCol<R> => ({
  key, label, filterType: 'date', dateValue: f, getValue: (r) => f(r) ?? '',
  render: (r) => <span className="tabular-nums">{fmtDateOrDash(f(r))}</span>,
  sheet: { kind: 'text', value: (r) => { const d = f(r); return d ? fmtDate(d) : null; } },
});
/** An SO number: it opens the order's quick view. */
const soCol = <R,>(key: string, label: string, f: (r: R) => string | null | undefined, open: (so: string) => void, names = false): SalesCol<R> => ({
  key, label, getValue: (r) => f(r) ?? '',
  render: (r) => {
    const so = f(r);
    return so
      ? <button type="button" className={sr.docLink} onClick={(e) => { e.stopPropagation(); open(so); }}>{so}</button>
      : '—';
  },
  ...(names ? { sheetLabel: (r: R) => f(r) ?? '' } : { sheet: { kind: 'text' as const, value: (r: R) => f(r) ?? null } }),
});
const docCol = <R,>(key: string, label: string, f: (r: R) => string | null | undefined, names = false): SalesCol<R> => ({
  key, label, getValue: (r) => f(r) ?? '', render: (r) => <span className={sr.plainNo}>{f(r) ?? '—'}</span>,
  ...(names ? { sheetLabel: (r: R) => f(r) ?? '' } : { sheet: { kind: 'text' as const, value: (r: R) => f(r) ?? null } }),
});
const marginCol = <R,>(key: string, label: string, f: (r: R) => number | null | undefined, revenue: (r: R) => number, cost: (r: R) => number): SalesCol<R> => ({
  key, label, align: 'right', getValue: (r) => f(r) ?? 0,
  render: (r) => <span className={toneCls(f(r))}>{pct(f(r))}</span>,
  total: (rs) => {
    const m = marginOf(sumOf(rs, revenue), sumOf(rs, cost));
    return <span className={toneCls(m)}>{pct(m)}</span>;
  },
  sheet: { kind: 'pct', value: (r) => f(r) ?? null, total: (rs) => marginOf(sumOf(rs, revenue), sumOf(rs, cost)) },
});
const STAGE_TAG: Record<FairPnlRow['effective_cost_stage'], string> = { so: 'SO', do: 'DO', invoice: 'SI' };

export function soColumns(hidden: ReadonlySet<string>, open: (so: string) => void): SalesCol<FairSoRow>[] {
  return [
    dateCol('date', 'Date', (r) => r.so_date),
    textCol('venue', 'Venue', (r) => r.venue),
    textCol('project', 'Project', (r) => r.project),
    soCol('so', 'SO No', (r) => r.so_no, open, true),
    docCol('form', 'Order Form', (r) => r.order_form),
    textCol('salesperson', 'Salesperson', (r) => r.salesperson),
    textCol('branding', 'Branding', (r) => r.branding),
    moneyCol('amount', 'Amount', (r) => r.amount_sen),
    moneyCol('selling', 'Selling', (r) => r.selling_sen),
    moneyCol('serviceRev', 'Service Rev.', (r) => r.service_rev_sen),
    ...(hidden.has('catcost') ? [] : [
      moneyCol<FairSoRow>('catMattress', 'Mattress / Sofa', (r) => r.cost_by_category.mattress_sofa_cost_sen),
      moneyCol<FairSoRow>('catBedframe', 'Bedframe', (r) => r.cost_by_category.bedframe_cost_sen),
      moneyCol<FairSoRow>('catAccessories', 'Accessories', (r) => r.cost_by_category.accessories_cost_sen),
      moneyCol<FairSoRow>('catOthers', 'Others', (r) => r.cost_by_category.others_cost_sen),
      moneyCol<FairSoRow>('catService', 'Service', (r) => r.cost_by_category.service_cost_sen),
    ]),
    moneyCol('soCost', 'Total SO Cost', (r) => r.total_so_cost_sen),
    marginCol('margin', 'Margin %', (r) => r.margin_pct, (r) => r.selling_sen, (r) => r.goods_cost_sen),
    moneyCol('balance', 'Balance', (r) => r.balance_sen),
    {
      key: 'payment', label: 'Payment', getValue: (r) => r.payment_methods.join(' + '),
      render: (r) => r.payment_methods.join(' + ') || '—',
      sheet: { kind: 'text', value: (r) => r.payment_methods.join(' + ') || null },
    },
    ...(hidden.has('tender') ? [] : [
      moneyCol<FairSoRow>('cash', 'Cash', (r) => r.deposit_by_tender.Cash),
      moneyCol<FairSoRow>('merchant', 'Merchant', (r) => r.deposit_by_tender.Merchant),
      moneyCol<FairSoRow>('installment', 'Installment', (r) => r.deposit_by_tender.Installment),
      moneyCol<FairSoRow>('online', 'Online', (r) => r.deposit_by_tender.Online),
    ]),
    {
      key: 'pending', label: 'Pending', getValue: (r) => (r.below_deposit ? 'Below deposit' : ''),
      render: (r) => (r.below_deposit ? <span className={`${sr.tag} ${sr.tagWarn}`}>Below deposit</span> : '—'),
      total: (rs) => rs.filter((r) => r.below_deposit).length || '—',
      sheet: {
        kind: 'text', value: (r) => (r.below_deposit ? 'Below deposit' : null),
        total: (rs) => { const k = rs.filter((r) => r.below_deposit).length; return k ? String(k) : null; },
      },
    },
  ];
}

export function doColumns(hidden: ReadonlySet<string>, open: (so: string) => void): SalesCol<FairDoRow>[] {
  return [
    dateCol('date', 'Date', (r) => r.delivery_date),
    textCol('venue', 'Venue', (r) => r.venue),
    textCol('project', 'Project', (r) => r.project),
    {
      key: 'do', label: 'DO No', getValue: (r) => r.do_no,
      render: (r) => (
        <>
          <span className={sr.plainNo}>{r.do_no}</span>
          {r.do_cost_is_legacy && <> <span className={sr.tag} title="Delivered before FIFO costing">Legacy</span></>}
        </>
      ),
      sheetLabel: (r) => r.do_no,
    },
    soCol('so', 'SO No', (r) => r.so_no, open),
    textCol('salesperson', 'Salesperson', (r) => r.salesperson),
    {
      key: 'deliveryLocation', label: 'Delivery Location', getValue: (r) => r.delivery_location ?? '',
      render: (r) => <span title={r.delivery_address ?? undefined}>{r.delivery_location ?? '—'}</span>,
      sheet: { kind: 'text', value: (r) => r.delivery_location },
    },
    textCol('location', 'Location', (r) => r.location),
    textCol('branding', 'Branding', (r) => r.branding),
    {
      key: 'qty', label: 'Qty', align: 'right', getValue: (r) => r.qty, render: (r) => fmtQty(r.qty),
      total: (rs) => fmtQty(sumOf(rs, (r) => r.qty)),
      sheet: { kind: 'text', value: (r) => fmtQty(r.qty), total: (rs) => fmtQty(sumOf(rs, (r) => r.qty)) },
    },
    moneyCol('soAmount', 'SO Amount', (r) => r.so_amount_sen),
    moneyCol('soCost', 'SO Cost', (r) => r.total_so_cost_sen),
    moneyCol('doCost', 'DO Cost', (r) => r.total_do_cost_sen),
    moneyCol('delta', 'Cost Δ', (r) => r.cost_delta_sen, {
      render: (r) => <span className={r.cost_delta_sen > 0 ? sr.late : r.cost_delta_sen < 0 ? sr.good : ''}>{signedMoney(r.cost_delta_sen)}</span>,
      total: (rs) => {
        const d = sumOf(rs, (r) => r.total_do_cost_sen) - sumOf(rs, (r) => r.total_so_cost_sen);
        return <span className={d > 0 ? sr.late : d < 0 ? sr.good : ''}>{signedMoney(d)}</span>;
      },
    }),
    {
      key: 'doMargin', label: 'DO Margin %', align: 'right', getValue: (r) => r.do_margin_pct ?? 0, render: (r) => pct(r.do_margin_pct),
      sheet: { kind: 'pct', value: (r) => r.do_margin_pct },
    },
    ...(hidden.has('drift') ? [] : [{
      key: 'drift', label: 'Margin drift', align: 'right' as const,
      getValue: (r: FairDoRow) => (r.do_margin_pct ?? 0) - (r.so_margin_pct ?? 0),
      render: (r: FairDoRow) => (
        <span className={(r.do_margin_pct ?? 0) < (r.so_margin_pct ?? 0) ? sr.late : sr.good}>{pts(r.do_margin_pct, r.so_margin_pct)}</span>
      ),
      sheet: { kind: 'text' as const, value: (r: FairDoRow) => pts(r.do_margin_pct, r.so_margin_pct) },
    }]),
  ];
}

export function invoiceColumns(hidden: ReadonlySet<string>, open: (so: string) => void): SalesCol<FairInvoiceRow>[] {
  return [
    dateCol('date', 'Date', (r) => r.invoice_date),
    textCol('venue', 'Venue', (r) => r.venue),
    textCol('project', 'Project', (r) => r.project),
    docCol('inv', 'Invoice No', (r) => r.inv_no, true),
    soCol('so', 'SO No', (r) => r.so_no, open),
    textCol('salesperson', 'Salesperson', (r) => r.salesperson),
    textCol('branding', 'Branding', (r) => r.branding),
    moneyCol('invoiced', 'Invoiced', (r) => r.invoiced_sen),
    ...(hidden.has('progression') ? [] : [
      moneyCol<FairInvoiceRow>('soCost', 'SO Cost', (r) => r.so_cost_sen),
      moneyCol<FairInvoiceRow>('doCost', 'DO Cost', (r) => r.do_cost_sen),
    ]),
    moneyCol('siCost', 'Landed (SI) Cost', (r) => r.si_cost_sen),
    marginCol('margin', 'Margin %', (r) => r.margin_pct, (r) => r.goods_invoiced_sen, (r) => r.goods_si_cost_sen),
  ];
}

export function pnlColumns(hidden: ReadonlySet<string>, open: (so: string) => void): SalesCol<FairPnlRow>[] {
  return [
    dateCol('date', 'Date', (r) => r.so_date),
    textCol('venue', 'Venue', (r) => r.venue),
    textCol('project', 'Project', (r) => r.project),
    soCol('so', 'SO No', (r) => r.so_no, open, true),
    textCol('salesperson', 'Salesperson', (r) => r.salesperson),
    textCol('branding', 'Branding', (r) => r.branding),
    moneyCol('revenue', 'Revenue', (r) => r.revenue_sen),
    ...(hidden.has('threeway') ? [] : [
      moneyCol<FairPnlRow>('soCost', 'SO Cost', (r) => r.so_cost_sen),
      moneyCol<FairPnlRow>('doCost', 'DO Cost', (r) => r.do_cost_sen),
      moneyCol<FairPnlRow>('siCost', 'SI Cost', (r) => r.si_cost_sen),
    ]),
    moneyCol('cogs', 'COGS', (r) => r.effective_cost_sen),
    {
      key: 'stage', label: 'Cost Stage', getValue: (r) => STAGE_TAG[r.effective_cost_stage],
      render: (r) => <span className={`${sr.tag} ${r.effective_cost_stage === 'so' ? '' : sr.tagInfo}`}>{STAGE_TAG[r.effective_cost_stage]}</span>,
      sheet: { kind: 'text', value: (r) => STAGE_TAG[r.effective_cost_stage] },
    },
    toneMoneyCol('gross', 'Gross Profit', (r) => r.gross_profit_sen),
    marginCol('margin', 'Margin %', (r) => r.margin_pct, (r) => r.revenue_sen, (r) => r.effective_cost_sen),
  ];
}

export function fairColumns(openFair: (id: number) => void): SalesCol<FairPnlFairRow>[] {
  const name = (r: FairPnlFairRow): string => r.project ?? `Fair ${r.project_id}`;
  return [
    {
      key: 'project', label: 'Fair', getValue: name,
      render: (r) => (
        <button type="button" className={sr.docLink} onClick={(e) => { e.stopPropagation(); openFair(r.project_id); }}>{name(r)}</button>
      ),
      sheetLabel: name,
    },
    textCol('venue', 'Venue', (r) => r.venue),
    {
      key: 'dates', label: 'Dates', getValue: (r) => r.project_start_date ?? '',
      render: (r) => <span className="tabular-nums">{fairDates(r) || '—'}</span>,
      sheet: { kind: 'text', value: (r) => fairDates(r) || null },
    },
    textCol('branding', 'Branding', (r) => r.brand),
    {
      key: 'order_qty', label: 'Orders', align: 'right', getValue: (r) => r.summary.orders, render: (r) => r.summary.orders.toLocaleString('en-MY'),
      total: (rs) => sumOf(rs, (r) => r.summary.orders).toLocaleString('en-MY'),
      sheet: { kind: 'text', value: (r) => String(r.summary.orders), total: (rs) => String(sumOf(rs, (r) => r.summary.orders)) },
    },
    moneyCol('revenue', 'Revenue', (r) => r.summary.total_revenue_sen),
    moneyCol('cogs', 'COGS', (r) => r.summary.total_cogs_sen),
    toneMoneyCol('gross', 'Gross profit', (r) => r.summary.gross_profit_sen),
    marginCol('gpPct', 'GP %', (r) => r.summary.gross_margin_pct, (r) => r.summary.total_revenue_sen, (r) => r.summary.total_cogs_sen),
    moneyCol('overhead', 'Overhead', (r) => r.summary.overheads.total_overhead_sen, {
      render: (r) => (r.rate_present ? cell(r.summary.overheads.total_overhead_sen) : <span title="No cost-rate card for this fair’s brand">—</span>),
    }),
    toneMoneyCol('net', 'Net profit', (r) => r.summary.net_profit_sen),
    marginCol('netMargin', 'Net margin', (r) => r.summary.net_margin_pct, (r) => r.summary.total_revenue_sen,
      (r) => r.summary.total_revenue_sen - r.summary.net_profit_sen),
  ];
}

export function gapColumns(open: (so: string) => void): SalesCol<FairCostingGapRow>[] {
  return [
    soCol('so', 'SO No', (r) => r.doc_no, open, true),
    dateCol('date', 'Date', (r) => r.so_date),
    { ...textCol<FairCostingGapRow>('item', 'Item code', (r) => r.item_code), render: (r) => <span className={sr.plainNo}>{r.item_code}</span> },
    textCol('description', 'Description', (r) => r.description),
    textCol('group', 'Group', (r) => r.item_group),
    {
      key: 'qty', label: 'Qty', align: 'right', getValue: (r) => r.qty ?? 0, render: (r) => (r.qty == null ? '—' : fmtQty(r.qty)),
      sheet: { kind: 'text', value: (r) => (r.qty == null ? null : fmtQty(r.qty)) },
    },
    textCol('customer', 'Customer', (r) => r.debtor_name),
    textCol('venue', 'Venue', (r) => r.venue),
    textCol('branding', 'Brand', (r) => r.branding),
  ];
}

// ── the sheet: the stage as shown, for Excel / PDF / Print ──────────────────
export function salesSheet<R>(o: {
  title: string; subtitle: string; meta: ReportSheet['meta'];
  cols: readonly SalesCol<R>[]; rows: readonly R[]; total: string | null; notes?: string[];
}): ReportSheet {
  const label = o.cols.find((c) => c.sheetLabel)?.sheetLabel ?? (() => '');
  const figs = o.cols.flatMap((c) => (c.sheet ? [{ label: c.label, spec: c.sheet }] : []));
  const rows: SheetRow[] = o.rows.map((r) => ({ kind: 'row', depth: 0, label: label(r), cells: figs.map((f) => f.spec.value(r)) }));
  if (o.total != null) {
    rows.push({ kind: 'total', depth: 0, label: o.total, cells: figs.map((f) => (f.spec.total ? f.spec.total(o.rows) : null)) });
  }
  return {
    title: o.title,
    subtitle: o.subtitle,
    meta: o.meta,
    tables: [{ columns: figs.map((f): SheetColumn => ({ label: f.label, kind: f.spec.kind })), rows }],
    notes: o.notes,
  };
}

// ── CSV export (the report's own, under ⋯) ──────────────────────────────────
function toCsv(headers: string[], rows: (string | number | null | undefined)[][]): string {
  const esc = (v: string | number | null | undefined) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers, ...rows].map((r) => r.map(esc).join(',')).join('\r\n');
}
function download(name: string, csv: string) {
  const blob = new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}
/** Plain 2-decimal number for CSV (no dash, no separators that would break CSV). */
const c = (sen: number | null | undefined): string => (Number(sen ?? 0) / 100).toFixed(2);
const csvDate = (d: string | null | undefined): string => (d ? fmtDate(d) : '');

export function buildExport(data: FairReportResponse): { headers: string[]; body: (string | number | null)[][]; name: string } {
  if (data.stage === 'so') {
    return {
      name: 'fair-report-sales-orders.csv',
      headers: ['Date', 'Venue', 'Project', 'SO No', 'Order Form', 'Salesperson', 'Branding', 'Amount', 'Selling', 'Service Rev', 'Mattress/Sofa Cost', 'Bedframe Cost', 'Accessories Cost', 'Others Cost', 'Service Cost', 'Total SO Cost', 'Margin %', 'Balance', 'Payment', 'Cash', 'Merchant', 'Installment', 'Online', 'Below Deposit'],
      body: data.rows.map((r) => [
        csvDate(r.so_date), r.venue, r.project, r.so_no, r.order_form, r.salesperson, r.branding,
        c(r.amount_sen), c(r.selling_sen), c(r.service_rev_sen),
        c(r.cost_by_category.mattress_sofa_cost_sen), c(r.cost_by_category.bedframe_cost_sen), c(r.cost_by_category.accessories_cost_sen), c(r.cost_by_category.others_cost_sen), c(r.cost_by_category.service_cost_sen),
        c(r.total_so_cost_sen), r.margin_pct == null ? '' : r.margin_pct.toFixed(1), c(r.balance_sen), r.payment_methods.join(' + '),
        c(r.deposit_by_tender.Cash), c(r.deposit_by_tender.Merchant), c(r.deposit_by_tender.Installment), c(r.deposit_by_tender.Online), r.below_deposit ? 'Yes' : '',
      ]),
    };
  }
  if (data.stage === 'do') {
    return {
      name: 'fair-report-delivery-orders.csv',
      headers: ['Delivery Date', 'Venue', 'Delivery Location', 'Delivery Address', 'Location', 'Project', 'Branding', 'DO No', 'Linked SO', 'Qty', 'SO Amount', 'Total SO Cost', 'Total DO Cost', 'Cost Delta', 'SO Margin %', 'DO Margin %', 'Legacy'],
      body: data.rows.map((r) => [
        csvDate(r.delivery_date), r.venue, r.delivery_location, r.delivery_address, r.location, r.project, r.branding, r.do_no, r.so_no, r.qty,
        r.so_amount_sen == null ? '' : c(r.so_amount_sen),
        c(r.total_so_cost_sen), c(r.total_do_cost_sen), c(r.cost_delta_sen),
        r.so_margin_pct == null ? '' : r.so_margin_pct.toFixed(1), r.do_margin_pct == null ? '' : r.do_margin_pct.toFixed(1), r.do_cost_is_legacy ? 'Yes' : '',
      ]),
    };
  }
  if (data.stage === 'pnl' && data.meta.needs_project) {
    return {
      name: 'fair-report-pnl-every-fair.csv',
      headers: ['Fair', 'Venue', 'Start', 'End', 'Branding', 'Orders', 'Revenue', 'COGS', 'Gross Profit', 'GP %', 'Overhead', 'Net Profit', 'Net Margin %'],
      body: (data.fairs ?? []).map((f) => [
        f.project, f.venue, csvDate(f.project_start_date), csvDate(f.project_end_date), f.brand, f.summary.orders,
        c(f.summary.total_revenue_sen), c(f.summary.total_cogs_sen), c(f.summary.gross_profit_sen),
        f.summary.gross_margin_pct == null ? '' : f.summary.gross_margin_pct.toFixed(1),
        c(f.summary.overheads.total_overhead_sen), c(f.summary.net_profit_sen),
        f.summary.net_margin_pct == null ? '' : f.summary.net_margin_pct.toFixed(1),
      ]),
    };
  }
  if (data.stage === 'pnl') {
    return {
      name: 'fair-report-pnl.csv',
      headers: ['Date', 'Venue', 'Project', 'SO No', 'Salesperson', 'Branding', 'Revenue', 'SO Cost', 'DO Cost', 'SI Cost', 'COGS', 'Cost Stage', 'Gross Profit', 'Margin %'],
      body: data.rows.map((r) => [
        csvDate(r.so_date), r.venue, r.project, r.so_no, r.salesperson, r.branding,
        c(r.revenue_sen), c(r.so_cost_sen), r.do_cost_sen == null ? '' : c(r.do_cost_sen), r.si_cost_sen == null ? '' : c(r.si_cost_sen),
        c(r.effective_cost_sen), r.effective_cost_stage, c(r.gross_profit_sen), r.margin_pct == null ? '' : r.margin_pct.toFixed(1),
      ]),
    };
  }
  return {
    name: 'fair-report-invoices.csv',
    headers: ['Invoice Date', 'Venue', 'Project', 'Branding', 'Invoice No', 'Linked SO', 'Invoiced', 'SO Cost', 'DO Cost', 'Landed (SI) Cost', 'Margin %'],
    body: data.rows.map((r) => [
      csvDate(r.invoice_date), r.venue, r.project, r.branding, r.inv_no, r.so_no,
      c(r.invoiced_sen), c(r.so_cost_sen), c(r.do_cost_sen), c(r.si_cost_sen), r.margin_pct == null ? '' : r.margin_pct.toFixed(1),
    ]),
  };
}

// ── the page ─────────────────────────────────────────────────────────────────
export const FairReport = () => (
  <ReportShell report="fair">
    <SalesReport />
  </ReportShell>
);

/** The report inside the shell (exported for its tests, which draw it bare). */
export function SalesReport() {
  const { user } = useAuth();
  const allowed = useMemo(() => fairAllowedStages(user), [user]);
  const showGaps = isFairManagementUser(user);
  const tabKeys = useMemo<TabKey[]>(() => (showGaps ? [...allowed, 'gaps'] : allowed), [allowed, showGaps]);
  const [sp, setSp] = useSearchParams();
  const range = useReportRange();
  const openDoc = useOpenDocInTab();

  /* An address from before the shared range opens on the range it meant. */
  useEffect(() => {
    if (!LEGACY_DATE_KEYS.some((k) => sp.has(k))) return;
    const legacy = legacyRange(sp);
    setSp((prev) => {
      const next = new URLSearchParams(prev);
      for (const k of LEGACY_DATE_KEYS) next.delete(k);
      if (legacy) { next.set('from', legacy.from); next.set('to', legacy.to); }
      return next;
    }, { replace: true });
  }, [sp, setSp]);

  // ── stage (clamped to what this user may see) ──────────────────────────────
  const rawStage = sp.get('stage') as TabKey | null;
  const firstTab = tabKeys.at(0);
  const stage: TabKey = rawStage && tabKeys.includes(rawStage) ? rawStage : (firstTab ?? 'so');
  const reportStage: FairStage = stage === 'gaps' ? 'so' : stage;

  // ── the five filters (URL) + the shared range and how it picks ─────────────
  const projectRaw = sp.get('project');
  const project = projectRaw && Number.isFinite(Number(projectRaw)) ? Number(projectRaw) : undefined;
  const dateBasis: DateBasis = sp.get('dates') === 'stage' ? 'stage' : 'so';
  const filters: FairFilters = useMemo(() => ({
    venue: sp.get('venue') || undefined,
    state: sp.get('state') || undefined,
    project,
    branding: sp.get('branding') || undefined,
    salesperson: sp.get('salesperson') || undefined,
    dateFrom: range.usable ? range.from : undefined,
    dateTo: range.usable ? range.to : undefined,
    dateBasis,
  }), [sp, project, range.usable, range.from, range.to, dateBasis]);

  const view = sp.get('view') === 'cards' ? 'cards' : 'table';
  const hidden = useMemo(() => new Set((sp.get('hide') || '').split(',').filter(Boolean)), [sp]);
  const selectedSo = sp.get('so');

  // setter that preserves the rest of the query string.
  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(sp);
    if (value == null || value === '') next.delete(key);
    else next.set(key, value);
    setSp(next);
  };
  const openSo = (so: string) => setParam('so', so);
  const openOrder = (so: string | null | undefined) => { if (so) openDoc(`/scm/sales-orders/${encodeURIComponent(so)}`); };
  const openFair = (id: number) => setParam('project', String(id));

  const enabled = stage !== 'gaps' && allowed.includes(reportStage) && range.usable;
  const q = useFairReport(reportStage, filters, enabled);
  /* The answer for what is asked now — not the one still on screen from before
     (the read keeps the previous answer while the next one loads). */
  const cur = q.data && q.data.stage === reportStage
    && (q.data.stage !== 'pnl' || (q.data.filters.project ?? null) === (project ?? null)) ? q.data : undefined;
  const pnl = cur?.stage === 'pnl' ? cur : undefined;
  const everyFair = reportStage === 'pnl' && project == null;
  const fairs = useMemo(() => pnl?.fairs ?? [], [pnl]);
  // The costing-gap tab has its own endpoint (not the fair-report stage machinery).
  const gapQ = useCostingGapListing(stage === 'gaps' && showGaps);
  // A 403 (not in the report's cohort) must not read as a transient "please retry".
  const errorInfo = (stage === 'gaps' ? gapQ.isError : enabled && q.isError)
    ? fairReportErrorInfo(stage === 'gaps' ? gapQ.error : q.error)
    : null;

  // ── accumulate filter options from whatever rows and fairs have loaded ──────
  const [opts, setOpts] = useState<OptionMaps>(EMPTY_OPTS);
  useEffect(() => {
    if (!cur) return;
    const seen: FairOf[] = cur.stage === 'pnl' ? [...(cur.fairs ?? []), ...(cur.meta.fair ? [cur.meta.fair] : [])] : [];
    setOpts((prev) => accumulate(prev, cur.rows as FairDims[], seen));
  }, [cur]);

  const period = range.usable ? periodLabel(range.from, range.to) : '';
  useReportSubtitle(range.usable
    ? `${period} · exhibition sales by document stage · confirmed orders only · ${datesLine(dateBasis, reportStage)}`
    : 'Pick dates');

  const anyPick = PICK_KEYS.some((k) => Boolean(sp.get(k)));
  const clearFilters = () => {
    const next = new URLSearchParams(sp);
    for (const k of PICK_KEYS) next.delete(k);
    setSp(next);
  };
  const toggleGroup = (key: string) => {
    const next = new Set(hidden);
    if (next.has(key)) next.delete(key); else next.add(key);
    setParam('hide', [...next].join(','));
  };

  // ── what the bar says ──────────────────────────────────────────────────────
  const pickedFair = pnl?.meta.fair ?? null;
  const projLabel: string | undefined = project != null ? opts.projects[String(project)] : undefined;
  const fairName = pickedFair?.project ?? projLabel?.split(' · ')[0] ?? 'this fair';
  const rowsNow = cur ? cur.rows.length : 0;
  const gapRows = gapQ.data?.rows ?? [];
  const title = stage === 'gaps' ? STAGE_LABELS.gaps
    : reportStage === 'pnl' ? (everyFair ? 'P&L · every fair' : `P&L · ${fairName}`)
      : STAGE_LABELS[stage];
  const count = stage === 'gaps' ? (gapQ.data ? plural(gapRows.length, 'row') : '')
    : !cur ? ''
      : everyFair ? (fairs.length ? `${plural(fairs.length, 'fair')} · click a fair to open its P&L` : '')
        : reportStage === 'pnl' ? [pickedFair ? fairDates(pickedFair) : '', plural(rowsNow, 'order')].filter(Boolean).join(' · ')
          : plural(rowsNow, 'row');
  const groups = stage === 'gaps' || everyFair ? [] : OPTIONAL_GROUPS[stage];
  const desc = stage === 'gaps' ? DESCRIPTIONS.gaps
    : reportStage === 'pnl' ? (everyFair ? DESCRIPTIONS.pnlEvery : DESCRIPTIONS.pnlFair)
      : dateBasis === 'stage' && reportStage === 'do' ? DESCRIPTIONS.doOwn
        : dateBasis === 'stage' && reportStage === 'invoice' ? DESCRIPTIONS.invoiceOwn
          : DESCRIPTIONS[reportStage];

  // ── tiles ──────────────────────────────────────────────────────────────────
  const tileKey = reportStage === 'pnl' ? (everyFair ? 'pnlEvery' : 'pnlFair') : reportStage;
  /* A P&L with nothing in the dates says so in a sentence instead. */
  const emptyPnl = pnl != null && (everyFair ? fairs.length === 0 : pnl.rows.length === 0);
  const tiles: ReportTile[] | null = stage === 'gaps' || !range.usable ? null
    : cur ? (emptyPnl ? null : salesTiles(cur, period))
      : TILE_LABELS[tileKey].map((label) => ({ key: label, label, value: '' }));

  // ── a message in place of the table ────────────────────────────────────────
  const applyFairDates = () => {
    if (!pickedFair?.project_start_date) return;
    const start = pickedFair.project_start_date;
    const end = pickedFair.project_end_date ?? start;
    range.setRange(start, end > range.today && start <= range.today ? range.today : end);
  };
  let message: ReactNode = null;
  if (stage !== 'gaps' && !range.usable) message = 'Pick dates to see the report.';
  else if (everyFair && pnl && fairs.length === 0) message = `No fair has an order in ${period}. Widen the dates to see more fairs.`;
  else if (reportStage === 'pnl' && !everyFair && pnl && pnl.rows.length === 0) {
    message = (
      <>
        No order of {fairName} falls in {period}.
        {pickedFair?.project_start_date && <> The fair ran {fairDates(pickedFair)}.</>}
        {pickedFair?.project_start_date && (
          <div><button type="button" className={sr.msgAct} onClick={applyFairDates}>Use the fair’s dates</button></div>
        )}
      </>
    );
  }

  // ── exports ────────────────────────────────────────────────────────────────
  const noOpen = () => undefined;
  const spId = sp.get('salesperson');
  const spName: string | undefined = spId ? opts.salespersons[spId] : undefined;
  const pickText = [
    sp.get('venue'), sp.get('state'), project != null ? (pickedFair?.project ?? projLabel ?? null) : null,
    sp.get('branding'), spId ? (spName ?? spId) : null,
  ].filter(Boolean).join(' · ') || 'Every fair';
  const sheet = (): ReportSheet | null => {
    const head = {
      title: `Sales report · ${stage === 'pnl' ? 'P&L' : STAGE_LABELS[stage]}`,
      subtitle: stage === 'gaps' ? DESCRIPTIONS.gaps : `${title} · ${period} · ${datesLine(dateBasis, reportStage)}`,
      meta: stage === 'gaps' ? [] : [{ label: 'Period', value: period }, { label: 'Filters', value: pickText }],
    };
    if (stage === 'gaps') return gapQ.data ? salesSheet({ ...head, cols: gapColumns(noOpen), rows: gapRows, total: null }) : null;
    if (!cur) return null;
    if (cur.stage === 'so') return salesSheet({ ...head, cols: soColumns(hidden, noOpen), rows: cur.rows, total: `Total · ${plural(cur.rows.length, 'order')}` });
    if (cur.stage === 'do') return salesSheet({ ...head, cols: doColumns(hidden, noOpen), rows: cur.rows, total: `Total · ${plural(cur.rows.length, 'delivery', 'deliveries')}` });
    if (cur.stage === 'invoice') return salesSheet({ ...head, cols: invoiceColumns(hidden, noOpen), rows: cur.rows, total: `Total · ${plural(cur.rows.length, 'invoice')}` });
    if (cur.meta.needs_project) {
      return salesSheet({ ...head, cols: fairColumns(noOpen), rows: cur.fairs ?? [], total: `Total · ${plural(fairs.length, 'fair')}`, notes: [DESCRIPTIONS.pnlEvery] });
    }
    return salesSheet({
      ...head, cols: pnlColumns(hidden, noOpen), rows: cur.rows, total: `Total · ${plural(cur.rows.length, 'order')}`,
      notes: [`Overhead ${money(cur.summary.overheads.total_overhead_sen)}: ${overheadMakeup(cur)}. Net profit ${money(cur.summary.net_profit_sen)} (${pct(cur.summary.net_margin_pct)}).`],
    });
  };
  const fileBase = `sales-report-${stage}-${range.from}-to-${range.to}`;
  const csv = () => {
    if (!cur) return;
    const { headers, body, name } = buildExport(cur);
    download(name, toCsv(headers, body));
  };

  // ── the body ───────────────────────────────────────────────────────────────
  let body: ReactNode;
  if (message) body = <div className={sr.msg} role="status">{message}</div>;
  else if (stage === 'gaps') {
    body = (
      <DataTable<FairCostingGapRow>
        tableId="fair-report-gaps" columns={gapColumns(openSo)} rows={gapQ.isLoading ? null : gapRows} loading={gapQ.isLoading}
        emptyLabel="No costing gaps: no ordered product is missing its cost." getRowKey={(r) => `${r.doc_no}-${r.item_code}-${r.so_date ?? ''}-${r.description ?? ''}`}
        onRowDoubleClick={(r) => openOrder(r.doc_no)}
      />
    );
  } else if (everyFair) {
    body = view === 'cards'
      ? <FairCards fairs={fairs} loading={!pnl} onOpenFair={openFair} />
      : (
        <DataTable<FairPnlFairRow>
          tableId="fair-report-fairs" columns={fairColumns(openFair)} rows={pnl ? fairs : null} loading={!pnl}
          emptyLabel="No fair has an order in these dates." getRowKey={(r) => String(r.project_id)}
          onRowClick={(r) => openFair(r.project_id)}
        />
      );
  } else if (view === 'cards') {
    body = <StageCards data={cur} loading={!cur} onOpen={openSo} />;
  } else {
    body = <StageTable data={cur} stage={reportStage} hidden={hidden} loading={!cur} onOpen={openSo} onOpenOrder={openOrder} />;
  }

  const unpriced = fairs.filter((f) => !f.rate_present);
  const noFair = pnl?.no_fair;

  return (
    <>
      <ReportHeaderActions>
        <ReportExports sheet={sheet} fileBase={fileBase} />
        <ReportMore items={[{ label: 'CSV', onClick: csv, disabled: !cur || stage === 'gaps' }]} />
      </ReportHeaderActions>
      <ReportToolbar>
        <FinanceDateRange />
        <ReportTool label="Dates by">
          <Segmented label="Dates by" options={DATE_BASES} value={dateBasis} onChange={(v) => setParam('dates', v === 'so' ? null : v)} />
        </ReportTool>
        <PickFilter label="Venue" value={sp.get('venue') ?? ''} onChange={(v) => setParam('venue', v)}
          options={opts.venues.map((v) => ({ value: v, label: v }))} allLabel="All venues" />
        <PickFilter label="State" value={sp.get('state') ?? ''} onChange={(v) => setParam('state', v)}
          options={opts.states.map((s) => ({ value: s, label: s }))} allLabel="All states" />
        <PickFilter label="Project / Fair" value={project != null ? String(project) : ''} onChange={(v) => setParam('project', v)}
          options={Object.entries(opts.projects).map(([id, label]) => ({ value: id, label }))} allLabel="All projects" />
        <PickFilter label="Branding" value={sp.get('branding') ?? ''} onChange={(v) => setParam('branding', v)}
          options={opts.brandings.map((b) => ({ value: b, label: b }))} allLabel="All brands" />
        <PickFilter label="Salesperson" value={sp.get('salesperson') ?? ''} onChange={(v) => setParam('salesperson', v)}
          options={Object.entries(opts.salespersons).map(([id, label]) => ({ value: id, label }))} allLabel="All salespersons" />
      </ReportToolbar>

      <div className={sr.tabs} role="tablist" aria-label="Stages">
        {tabKeys.map((k) => (
          <button key={k} type="button" role="tab" aria-selected={k === stage} className={`${sr.tab} ${k === stage ? sr.tabOn : ''}`}
            onClick={() => setParam('stage', k)}>
            {STAGE_LABELS[k]}
          </button>
        ))}
      </div>

      {errorInfo && <ReportMessage tone="error">{errorInfo.message}</ReportMessage>}
      {!errorInfo && tiles && <ReportTiles label="Sales report figures" tiles={tiles} pending={!cur} />}

      <div className={sr.bar}>
        {reportStage === 'pnl' && !everyFair && stage !== 'gaps' && (
          <button type="button" className={sr.back} onClick={() => setParam('project', null)}><ArrowLeft size={13} aria-hidden />All fairs</button>
        )}
        <h2 className={sr.title}>{title}</h2>
        {count && <span className={sr.count}>{count}</span>}
        {anyPick && <button type="button" className={sr.link} onClick={clearFilters}>Clear filters</button>}
        <span className={sr.grow} />
        {groups.length > 0 && <span className={sr.groupsLabel}>Columns</span>}
        {groups.map((g) => {
          const on = !hidden.has(g.key);
          return (
            <button key={g.key} type="button" className={`${sr.chip} ${on ? sr.chipOn : ''}`} aria-pressed={on} onClick={() => toggleGroup(g.key)}>
              {on ? <Check size={12} strokeWidth={2.5} aria-hidden /> : <Plus size={12} strokeWidth={2.5} aria-hidden />}{g.label}
            </button>
          );
        })}
        {stage !== 'gaps' && (
          <Segmented label="Show as" value={view} onChange={(v) => setParam('view', v === 'table' ? null : v)}
            options={[{ value: 'table', label: 'Table' }, { value: 'cards', label: 'Cards' }]} />
        )}
      </div>
      <p className={sr.desc}>{desc}</p>

      {pnl && !everyFair && !pnl.meta.rate_present && pnl.rows.length > 0 && (
        <ReportMessage>
          No cost-rate card for this fair’s brand{pnl.meta.brand ? ` (${pnl.meta.brand})` : ''} — overhead shows as zero, so net profit equals gross profit until a rate card is set.
        </ReportMessage>
      )}

      {body}

      {everyFair && pnl && fairs.length > 0 && (unpriced.length > 0 || (noFair?.orders ?? 0) > 0) && (
        <div className={sr.notes}>
          {unpriced.length > 0 && (
            <p className={sr.notes}>
              No cost-rate card for {unpriced.length === 1 ? 'this fair’s brand' : 'these fairs’ brands'}, so the overhead is a dash and net profit equals gross profit: {unpriced.map((f) => f.project ?? `Fair ${f.project_id}`).join(', ')}.
            </p>
          )}
          {noFair && noFair.orders > 0 && (
            <p className={sr.notes}>
              {plural(noFair.orders, 'order')} in the period {noFair.orders === 1 ? 'carries' : 'carry'} no fair ({money(noFair.revenue_sen)}) — on the Sales Orders tab, not in this table.
            </p>
          )}
        </div>
      )}

      <FairDrawer docNo={selectedSo} onClose={() => setParam('so', null)} onOpenOrder={openOrder} />
    </>
  );
}

// ── a filter in the toolbar ──────────────────────────────────────────────────
function PickFilter({ label, value, onChange, options, allLabel }: {
  label: string; value: string; onChange: (v: string) => void;
  options: { value: string; label: string }[]; allLabel: string;
}) {
  return (
    <ReportTool label={label}>
      <select className={sr.select} value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}>
        <option value="">{allLabel}</option>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </ReportTool>
  );
}

// ── table ─────────────────────────────────────────────────────────────────────
/* The footer sums what is on screen: the stage's rows after the table's own
   search / filters, or only the ticked rows (owner 2026-09-25). The route pages
   through every match, so with no table filter the footer equals the tiles. */
function StageTable({ data, stage, hidden, loading, onOpen, onOpenOrder }: {
  data: FairReportResponse | undefined; stage: FairStage; hidden: ReadonlySet<string>; loading: boolean;
  onOpen: (so: string) => void; onOpenOrder: (so: string | null | undefined) => void;
}) {
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  // Another stage or filter is another set of rows: the ticks do not carry.
  useEffect(() => setPicked(new Set()), [data]);
  const common = {
    loading,
    emptyLabel: 'No records match the current filters.',
    selection: {
      selectedIds: picked,
      onToggle: (id: string) => setPicked((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id); else next.add(id);
        return next;
      }),
      onToggleAll: (keys: string[], all: boolean) => setPicked(all ? new Set() : new Set(keys)),
    },
  };

  if (stage === 'so') {
    return (
      <DataTable<FairSoRow> tableId="fair-report-so" columns={soColumns(hidden, onOpen)} rows={data?.stage === 'so' ? data.rows : null}
        getRowKey={(r) => r.so_no} onRowDoubleClick={(r) => onOpenOrder(r.so_no)} {...common} />
    );
  }
  if (stage === 'do') {
    return (
      <DataTable<FairDoRow> tableId="fair-report-do" columns={doColumns(hidden, onOpen)} rows={data?.stage === 'do' ? data.rows : null}
        getRowKey={(r) => r.do_no} onRowDoubleClick={(r) => onOpenOrder(r.so_no)} {...common} />
    );
  }
  if (stage === 'pnl') {
    return (
      <DataTable<FairPnlRow> tableId="fair-report-pnl" columns={pnlColumns(hidden, onOpen)} rows={data?.stage === 'pnl' ? data.rows : null}
        getRowKey={(r) => r.so_no} onRowDoubleClick={(r) => onOpenOrder(r.so_no)} {...common} />
    );
  }
  return (
    <DataTable<FairInvoiceRow> tableId="fair-report-invoice" columns={invoiceColumns(hidden, onOpen)} rows={data?.stage === 'invoice' ? data.rows : null}
      getRowKey={(r) => r.inv_no} onRowDoubleClick={(r) => onOpenOrder(r.so_no)} {...common} />
  );
}

// ── cards view ────────────────────────────────────────────────────────────────
type Fig = { k: string; v: string; tone?: 'good' | 'late' };
type CardOf = { key: string; no: string; open: () => void; sub: string; figs: Fig[] };

function Cards({ cards, loading }: { cards: CardOf[]; loading: boolean }) {
  if (cards.length === 0) return <div className={sr.none}>{loading ? 'Loading…' : 'No records match the current filters.'}</div>;
  return (
    <div className={sr.cards}>
      {cards.map((cd) => (
        <div key={cd.key} className={sr.card}>
          <div className={sr.cardHead}>
            <button type="button" className={sr.docLink} onClick={cd.open}>{cd.no}</button>
            <span className={sr.cardSub}>{cd.sub}</span>
          </div>
          <div className={sr.figs}>
            {cd.figs.map((f) => (
              <div key={f.k}>
                <div className={sr.figK}>{f.k}</div>
                <div className={`${sr.figV} ${f.tone === 'good' ? sr.good : f.tone === 'late' ? sr.late : ''}`}>{f.v}</div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

const subOf = (...parts: Array<string | null | undefined>): string => parts.filter(Boolean).join(' · ');

function StageCards({ data, loading, onOpen }: { data: FairReportResponse | undefined; loading: boolean; onOpen: (so: string) => void }) {
  let cards: CardOf[] = [];
  if (data?.stage === 'so') {
    cards = data.rows.map((r) => ({
      key: r.so_no, no: r.so_no, open: () => onOpen(r.so_no), sub: subOf(fmtDate(r.so_date), r.project ?? r.venue, r.salesperson),
      figs: [{ k: 'Amount', v: money(r.amount_sen) }, { k: 'Margin', v: pct(r.margin_pct) }, { k: 'Balance', v: money(r.balance_sen), tone: r.balance_sen > 0 ? 'late' : undefined }],
    }));
  } else if (data?.stage === 'do') {
    cards = data.rows.map((r) => ({
      key: r.do_no, no: r.so_no ?? r.do_no, open: () => { if (r.so_no) onOpen(r.so_no); }, sub: subOf(r.do_no, fmtDate(r.delivery_date), r.project ?? r.venue),
      figs: [
        { k: 'SO cost', v: money(r.total_so_cost_sen) }, { k: 'DO cost', v: money(r.total_do_cost_sen) },
        { k: 'Cost Δ', v: signedMoney(r.cost_delta_sen), tone: r.cost_delta_sen > 0 ? 'late' : r.cost_delta_sen < 0 ? 'good' : undefined },
      ],
    }));
  } else if (data?.stage === 'invoice') {
    cards = data.rows.map((r) => ({
      key: r.inv_no, no: r.so_no ?? r.inv_no, open: () => { if (r.so_no) onOpen(r.so_no); }, sub: subOf(r.inv_no, fmtDate(r.invoice_date), r.project ?? r.venue),
      figs: [{ k: 'Invoiced', v: money(r.invoiced_sen) }, { k: 'Landed cost', v: money(r.si_cost_sen) }, { k: 'Margin', v: pct(r.margin_pct) }],
    }));
  } else if (data?.stage === 'pnl') {
    cards = data.rows.map((r) => ({
      key: r.so_no, no: r.so_no, open: () => onOpen(r.so_no), sub: subOf(fmtDate(r.so_date), r.salesperson),
      figs: [
        { k: 'Revenue', v: money(r.revenue_sen) }, { k: `COGS (${STAGE_TAG[r.effective_cost_stage]})`, v: money(r.effective_cost_sen) },
        { k: 'Gross', v: money(r.gross_profit_sen), tone: r.gross_profit_sen < 0 ? 'late' : 'good' },
      ],
    }));
  }
  return <Cards cards={cards} loading={loading} />;
}

function FairCards({ fairs, loading, onOpenFair }: { fairs: readonly FairPnlFairRow[]; loading: boolean; onOpenFair: (id: number) => void }) {
  const cards: CardOf[] = fairs.map((f) => ({
    key: String(f.project_id), no: f.project ?? `Fair ${f.project_id}`, open: () => onOpenFair(f.project_id), sub: subOf(f.venue, fairDates(f)),
    figs: [
      { k: 'Revenue', v: money(f.summary.total_revenue_sen) }, { k: 'GP %', v: pct(f.summary.gross_margin_pct) },
      { k: 'Net profit', v: money(f.summary.net_profit_sen), tone: f.summary.net_profit_sen < 0 ? 'late' : undefined },
    ],
  }));
  return <Cards cards={cards} loading={loading} />;
}

// ── quick-view drawer ─────────────────────────────────────────────────────────
const th = 'px-3 py-2 text-left text-[10.5px] font-semibold uppercase tracking-brand text-ink-muted whitespace-nowrap';
const thR = 'px-3 py-2 text-right text-[10.5px] font-semibold uppercase tracking-brand text-ink-muted whitespace-nowrap';
const td = 'px-3 py-2.5 text-[12.5px] text-ink whitespace-nowrap';
const tdR = 'px-3 py-2.5 text-right text-[12.5px] text-ink tabular-nums whitespace-nowrap';
const docNoCls = 'text-[12.5px] font-semibold';

function FairDrawer({ docNo, onClose, onOpenOrder }: { docNo: string | null; onClose: () => void; onOpenOrder: (so: string | null | undefined) => void }) {
  const q = useFairReportDetail(docNo);
  const d = q.data;

  useEffect(() => {
    if (!docNo) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [docNo, onClose]);

  const merchantLine = (p: { merchant_provider: string | null; installment_months: number | null }): string => {
    const parts: string[] = [];
    if (p.merchant_provider) parts.push(p.merchant_provider);
    if (p.installment_months) parts.push(`${p.installment_months}-mo plan`);
    return parts.join(' · ') || '—';
  };

  return (
    <>
      <div
        className={`fixed inset-0 z-40 bg-ink/30 transition-opacity duration-200 ${docNo ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
        onClick={onClose}
        aria-hidden
      />
      <aside
        role="dialog"
        aria-label="Order quick view"
        className={`fixed right-0 top-0 z-50 flex h-full w-full max-w-[520px] flex-col border-l border-border bg-surface shadow-slab transition-transform duration-200 ${docNo ? 'translate-x-0' : 'translate-x-full'}`}
      >
        <div className="flex h-14 shrink-0 items-center gap-3 bg-sidebar px-4 text-sidebar-ink">
          <button onClick={onClose} className="text-sidebar-ink-muted hover:text-sidebar-ink" aria-label="Close"><X size={18} /></button>
          <div className="min-w-0 flex-1">
            <div className="text-[14px] font-semibold">{d?.so_no ?? docNo ?? ''}</div>
            <div className="text-[10.5px] text-sidebar-ink-muted">Sales Order · Confirmed</div>
          </div>
          {docNo && (
            <button type="button" className="text-[12px] font-semibold text-sidebar-ink hover:underline" onClick={() => onOpenOrder(docNo)}>
              Open the order
            </button>
          )}
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {q.isLoading && <div className="text-[13px] text-ink-muted">Loading…</div>}
          {q.isError && <div className="rounded-md border border-err/40 bg-err/5 px-3 py-2 text-[13px] text-err">Could not load this order.</div>}
          {d && (
            <>
              <div className="flex items-center gap-2">
                {d.branding && <span className="rounded bg-accent-soft px-1.5 py-0.5 text-[9.5px] font-bold uppercase text-accent">{d.branding}</span>}
                <span className="text-[12px] text-ink-muted">
                  Ordered {fmtDateOrDash(d.so_date)}{d.venue ? ` · ${d.venue}` : ''}
                </span>
              </div>

              {/* meta grid */}
              <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 rounded-lg border border-border bg-surface-2 px-4 py-3.5">
                <Meta k="SO No" v={<span className={docNoCls}>{d.so_no}</span>} />
                <Meta k="Order Form" v={<span className={docNoCls}>{d.order_form ?? '—'}</span>} />
                <Meta k="Salesperson" v={d.salesperson ?? '—'} />
                <Meta k="Project / Fair" v={d.project ?? '—'} />
                <Meta k="State" v={d.state ?? '—'} />
                <Meta k="Payment" v={d.payment_methods.join(' + ') || '—'} />
              </dl>

              {/* linkage chain */}
              <SectionH>Document linkage · SO → DO → Invoice</SectionH>
              <div className="flex flex-wrap items-stretch gap-1.5">
                <ChainLink label="Sales Order" nos={[d.linkage.so_no]} sub={`Confirmed ${fmtDateOrDash(d.so_date)}`} done />
                <ChainArrow />
                <ChainLink label="Delivery Order" nos={d.linkage.do_nos} sub={d.linkage.do_nos.length ? 'Delivered' : 'Not yet delivered'} done={!!d.linkage.do_nos.length} />
                <ChainArrow />
                <ChainLink label="Invoice" nos={d.linkage.invoice_nos} sub={d.linkage.invoice_nos.length ? 'Invoiced' : 'Not invoiced'} done={!!d.linkage.invoice_nos.length} />
              </div>

              {/* order lines */}
              <SectionH>Order lines · selling &amp; cost</SectionH>
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-[12px]">
                  <thead><tr>
                    <th className={th}>Item</th><th className={thR}>Qty</th><th className={thR}>Unit sell</th><th className={thR}>Amount</th><th className={thR}>Unit cost</th><th className={thR}>Line cost</th>
                  </tr></thead>
                  <tbody>
                    {d.lines.map((l, i) => {
                      /* Item CODE + variant, exactly like every other order-line
                         surface (owner 2026-07-24, shared order-line rule):
                         orderLineIdentity leads with the code and keeps the
                         variant summary (supplier code folded in) as the
                         subtitle; the description is dropped. */
                      const { primary, secondary } = orderLineIdentity({
                        code: l.item_code,
                        description: l.description,
                        variant:
                          buildVariantSummary(l.item_group ?? '', l.variants ?? null) ||
                          (l.description2 ?? ''),
                      });
                      return (
                      <tr key={i} className={`border-t border-border/60 ${l.cancelled ? 'opacity-50 line-through' : ''}`}>
                        <td className={`${td} whitespace-normal`}>
                          <div>{primary || '—'}</div>
                          {secondary && <div className="text-ink-muted">{secondary}</div>}
                        </td>
                        <td className={tdR}>{l.qty ?? '—'}</td>
                        <td className={tdR}>{cell(l.unit_price_sen)}</td>
                        <td className={tdR}>{cell(l.amount_sen)}</td>
                        <td className={`${tdR} text-ink-muted`}>{cell(l.unit_cost_sen)}</td>
                        <td className={`${tdR} text-ink-muted`}>{cell(l.line_cost_sen)}</td>
                      </tr>
                      );
                    })}
                    {d.lines.length === 0 && <tr><td className={`${td} text-ink-muted`} colSpan={6}>No lines.</td></tr>}
                  </tbody>
                </table>
              </div>

              {/* summary grid */}
              <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
                <MiniStat k="Amount" v={money(d.amount_sen)} />
                <MiniStat k="Selling" v={money(d.selling_sen)} />
                <MiniStat k="Service Rev." v={money(d.service_rev_sen)} />
                <MiniStat k="Total Cost" v={money(d.total_so_cost_sen)} />
                <MiniStat k="Margin" v={pct(d.margin_pct)} tone={(d.margin_pct ?? 0) >= 0 ? 'good' : 'bad'} />
                <MiniStat k="Balance" v={money(d.balance_sen)} />
              </div>

              {/* cost by category */}
              <SectionH>Cost by category</SectionH>
              <div className="overflow-hidden rounded-lg border border-border">
                {catRows(d.cost_by_category).map(([label, v]) => (
                  <div key={label} className="flex items-center justify-between border-b border-border/60 px-3 py-2 text-[12.5px] last:border-b-0">
                    <span className="text-ink-secondary">{label}</span><span className="tabular-nums">{cell(v)}</span>
                  </div>
                ))}
                <div className="flex items-center justify-between bg-surface-2 px-3 py-2 text-[12.5px] font-semibold">
                  <span>Total SO Cost</span><span className="tabular-nums">{money(d.total_so_cost_sen)}</span>
                </div>
              </div>

              {/* deposit by tender */}
              <SectionH>Deposit by tender</SectionH>
              <div className="space-y-2">
                {d.payments.length === 0 && <div className="text-[12px] text-ink-muted">No payments recorded.</div>}
                {d.payments.map((p, i) => (
                  <div key={i} className="flex items-center gap-3 rounded-lg border border-border px-3 py-2.5">
                    <span className="min-w-[74px] text-[12.5px] font-semibold text-ink">{p.tender ?? '—'}</span>
                    <span className="flex-1 text-[11px] text-ink-muted">{merchantLine(p)}</span>
                    <span className="text-[12.5px] font-semibold tabular-nums">{cell(p.amount_sen)}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </aside>
    </>
  );
}

function Meta({ k, v }: { k: string; v: ReactNode }) {
  return <div><dt className="text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">{k}</dt><dd className="mt-0.5 text-[13px] text-ink">{v}</dd></div>;
}
function SectionH({ children }: { children: ReactNode }) {
  return <div className="mb-2 mt-5 text-[10.5px] font-bold uppercase tracking-brand text-ink-muted">{children}</div>;
}
function MiniStat({ k, v, tone }: { k: string; v: string; tone?: 'good' | 'bad' }) {
  return (
    <div className="rounded-lg border border-border bg-surface-2 px-2.5 py-2">
      <div className="text-[8.5px] font-semibold uppercase tracking-brand text-ink-muted">{k}</div>
      <div className={`mt-0.5 text-[13px] font-semibold tabular-nums ${tone === 'good' ? 'text-synced' : tone === 'bad' ? 'text-err' : 'text-ink'}`}>{v}</div>
    </div>
  );
}
/* `nos` is an ARRAY because a Sales Order routinely ships on more than one DO
   and invoices on more than one SI. Every number renders, one per line, and
   `sub` states the stage's status only (owner 2026-08-01: 需要应用到所有列表). */
function ChainLink({ label, nos, sub, done }: { label: string; nos: string[]; sub: string; done: boolean }) {
  return (
    <div className={`min-w-[118px] flex-1 rounded-lg border px-3 py-2.5 ${done ? 'border-primary/30 bg-primary/5' : 'border-dashed border-border bg-surface-2'}`}>
      <div className="text-[9.5px] font-bold uppercase tracking-brand text-ink-muted">{label}</div>
      <div className={`${docNoCls} mt-0.5 flex flex-col gap-0.5 ${done ? 'text-primary-ink' : 'text-ink-muted'}`}>
        {nos.length === 0 ? <span>—</span> : nos.map((n) => <span key={n}>{n}</span>)}
      </div>
      <div className="mt-0.5 text-[10.5px] text-ink-muted">{sub}</div>
    </div>
  );
}
function ChainArrow() {
  return <div className="flex items-center px-0.5 text-ink-muted">→</div>;
}

export default FairReport;
