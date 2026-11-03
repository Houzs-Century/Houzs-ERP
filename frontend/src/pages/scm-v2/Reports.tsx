// ----------------------------------------------------------------------------
// Reports — the P&L and the Balance sheet (GL redesign item 6), in the owner's
// Claude Design (batch 6, step 2): the report shell's header and toolbar, the
// statement table, the views Single / Compare / By month (the balance sheet:
// Single / By month), levels, "% beside". One source: /accounting/reports/*
// over v_gl_entries — a column IS the report for its period, so these can
// never argue with the Journal / GL / TB beside them, nor a month with itself.
//
// SIGNS (owner 2026-09-14, docs/bugs/0910: expense 可以不用（）吗？因为本身就是费用
// 除非他当月是 ct 大过 debit 才（）): every figure is the positive amount it is —
// an expense is a cost, not a negative — and only a line whose credits beat
// its debits in the period (a reversal, a closing-stock credit) prints in
// parentheses; a loss is a negative net and reads the same way. The four
// Finance reports share this rule through fmtSenPlain — 1,234.56, no RM, as the
// Cash Flow reads (owner 2026-09-19: P&L 的 RM 前缀拿掉，和 cash flow 一样).
//
// LAYOUT (owner 2026-09-14, docs/bugs/0911: 我想要有 level，父子 account 分层 …
// 我要能自己调动排版 … P&L 那边不是每个 expense 都有 percentage): each block is
// drawn on the report's layout — the server lays the period's figures on the
// owner's tree of categories (one tree, shared by every company, ticked per
// company) — with a subtotal on every category, % of sales on every row, and
// L1..Ln to open the tree to a depth. Layout opens the editor for whoever may
// read the statements. The Balance Sheet draws the same way on its own tree
// (docs/bugs/0912), every line's % of TOTAL ASSETS, both sides.
//
// BY MONTH (docs/bugs/0916, owner: 能看每个月的): the same endpoint asked once per
// column, Total leftmost then newest → oldest; the balance sheet's columns are
// month-end balances and it has no Total. The range's last month anchors it.
//
// LINES (owner 2026-09-14: 点开看明细其实就是看 general ledger; 2026-09-18: 那笔费用
// 挂在那个月份的下面): an account's name opens its lines for the whole period
// under its row, a figure that column's; the lines carry "Open in General
// ledger ›". A category's figure opens the ledger on every account under it.
//
// EXPORTS (owner 2026-09-19: 我这页显示什么就要 export 什么): Excel, PDF and Print
// carry the statement as shown — these columns, the lines at this level, the %
// beside or not — through the shared report sheet.
// ----------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useQueries } from '@tanstack/react-query';
import { fmtDate, fmtSen, fmtSenPlain } from '../../vendor/shared/format';
import { authedFetch } from '../../vendor/scm/lib/authed-fetch';
import { DateField } from '../../vendor/scm/components/DateField';
import { useAuth } from '../../auth/AuthContext';
import { ledgerHref, linesVisible, pctOf, type LaidNode } from '../../vendor/scm/lib/report-layout';
import { useReportTree, type Level } from './ReportLayoutTree';
import { ReportLayoutEditor } from './ReportLayoutEditor';
import { balanceSheetLines, monthlyDepth, pnlLines, type FlatLine } from '../../vendor/scm/lib/report-monthly';
import { statementColumnsTable, statementTable, type ReportSheet } from '../../vendor/scm/lib/report-sheet';
import { FinanceDateRange } from './reports/FinanceDateRange';
import { useReportRange } from './reports/useReportRange';
import {
  ReportExports, ReportHeaderActions, ReportMessage, ReportSwitch, ReportTiles, ReportTool, ReportToolbar, Segmented, useReportSubtitle,
  type ReportTile,
} from './reports/reportParts';
import { StatementSkeleton, StatementTable } from './reports/StatementTable';
import {
  COMPARE_WITH, MONTH_COUNTS, balanceColumns, columnsSpan, monthName, pnlColumns, statementLines,
  type CompareWith, type StatementColumn, type StatementLine, type StatementView,
} from './reports/statementColumns';
import {
  REPORT_CHART_COLORS, ReportBarChart, chartMonths, thousands, useChartMonths, useChartPeriods,
  type ChartBarSeries, type ChartMonth,
} from './reports/ReportBarChart';
import type { ChartWindow } from './reports/chartWindow';
import type { DashboardPeriod } from '../../vendor/scm/lib/dashboard-queries';
import s from './reports/Statement.module.css';

type Line = { code: string; name: string; amountSen: number };

/* ── The P&L chart (batch 6 §4.1): three bars a month — revenue, cost of
   sales, operating expenses — and net profit under each, from the
   Dashboard's one read of the P&L builder's figures. ── */
const PNL_SERIES: ChartBarSeries[] = [
  { key: 'revenue', label: 'Revenue', color: REPORT_CHART_COLORS.petrol },
  { key: 'cost', label: 'Cost of sales', color: REPORT_CHART_COLORS.gold },
  { key: 'opex', label: 'Operating expenses', color: REPORT_CHART_COLORS.grey },
];

/** A month of the P&L chart — the builder's figures; the margin worked here, once. */
export function pnlChartMonth(p: DashboardPeriod): Omit<ChartMonth, 'month'> | null {
  const a = p.actual;
  if (!a) return null;
  const loss = a.netProfitSen < 0;
  return {
    values: { revenue: a.salesSen, cost: a.costOfSalesSen, opex: a.expensesSen },
    bottom: [
      { label: 'Net profit', value: fmtSenPlain(a.netProfitSen), loss },
      { label: 'Net margin', value: a.salesSen ? `${((a.netProfitSen / a.salesSen) * 100).toFixed(1)}%` : '—', loss },
    ],
    under: { text: thousands(a.netProfitSen), loss },
  };
}

function PnlChart({ win }: { win: ChartWindow }) {
  const periods = useChartPeriods(win);
  return (
    <ReportBarChart
      title="Revenue, cost and expenses"
      series={PNL_SERIES}
      months={chartMonths(win, periods.byMonth, pnlChartMonth)}
      win={win}
      loading={periods.isLoading}
      failed={periods.isError}
      note="Under each month: net profit, RM thousand — red is a loss. Shaded months are in the period; click a month to open it."
    />
  );
}

/** The views a statement offers, in the design's words. */
const PNL_VIEWS: ReadonlyArray<{ value: StatementView; label: string }> = [
  { value: 'single', label: 'Single' },
  { value: 'compare', label: 'Compare' },
  { value: 'month', label: 'By month' },
];
const BS_VIEWS = PNL_VIEWS.filter((v) => v.value !== 'compare');
const MONTH_OPTIONS = MONTH_COUNTS.map((n) => ({ value: n, label: String(n) }));

/** L1 … Ln + All, from the tree's own depth; nothing to choose when it is one level. */
function LevelTool({ depth, level, onLevel }: { depth: number; level: Level; onLevel: (l: Level) => void }) {
  if (depth < 2) return null;
  const options = [...Array.from({ length: depth }, (_, i) => ({ value: (i + 1) as Level, label: `L${i + 1}` })), { value: 'all' as Level, label: 'All' }];
  return (
    <ReportTool label="Levels">
      <Segmented options={options} value={level} onChange={onLevel} label="Levels" />
    </ReportTool>
  );
}

/** Where the General ledger opens for a category's accounts — Back returns here. */
function useOpenLedger(backLabel: string) {
  const navigate = useNavigate();
  const location = useLocation();
  return (codes: string[], col: StatementColumn) => {
    if (codes.length === 0) return;
    navigate(`${ledgerHref(codes, col.from, col.to)}&in=reports`, {
      state: { back: { to: `${location.pathname}${location.search}`, label: backLabel } },
    });
  };
}

/** The sheet the exports draw: the single period as today's statement sheet, the
 *  other views their columns, each amount with its % beside when shown. */
function sheetTable(view: StatementView, columns: StatementColumn[], shown: StatementLine[], showPct: boolean, pctTitle: string) {
  if (view === 'single' && showPct) {
    const col = columns[0]!;
    return statementTable(shown.map((l): FlatLine => ({ ...l, amountSen: l.cells[col.key]?.amountSen ?? 0, pct: l.cells[col.key]?.pct ?? null })), pctTitle);
  }
  return statementColumnsTable(columns.map((c) => ({ key: c.key, label: c.kind === 'period' && view === 'single' ? 'Amount' : c.label, pct: c.pct && showPct, edge: c.kind === 'total' })), shown);
}

const layoutWord = (stored: boolean | undefined): string =>
  stored === undefined ? '' : stored ? ' · on the saved layout' : " · on the chart's own tree";

/* ── P&L ──────────────────────────────────────────────────────────────────── */
type PnlLayout = {
  stored: boolean;
  /** Sales of the period — what every % is of; null when nothing sold. */
  baseSen: number | null;
  tradingIncome: LaidNode[]; costOfSales: LaidNode[]; otherIncome: LaidNode[]; expenses: LaidNode[]; taxation: LaidNode[];
};
type PnlResponse = {
  tradingIncome: Line[]; costOfSales: Line[]; otherIncome: Line[]; expenses: Line[];
  /** TAXATION section rows — a profit-before-tax line appears when any posted. */
  taxation?: Line[];
  /** The closing stock is the stock engine's as of the last day (2026-09-21); provisional until the month-end close books it. */
  stock?: { closingProvisional: boolean; asOf: string };
  /** The same figures on the report's layout. */
  layout: PnlLayout;
  totals: {
    tradingIncomeSen: number; costOfSalesSen: number; grossProfitSen: number; otherIncomeSen: number; expensesSen: number;
    profitBeforeTaxSen?: number; taxationSen?: number; netProfitSen: number;
  };
};
const fetchPnl = (from: string, to: string) => authedFetch<PnlResponse>(`/accounting/reports/pnl?from=${from}&to=${to}`);

/** The columns' reads: one request per column, each the report for its period. */
function useColumnReads<T>(columns: StatementColumn[], key: (c: StatementColumn) => unknown[], fetchOne: (c: StatementColumn) => Promise<T>) {
  const read = columns.filter((c) => c.kind !== 'change');
  const results = useQueries({
    queries: read.map((c) => ({ queryKey: key(c), queryFn: () => fetchOne(c), staleTime: 30_000 })),
  });
  const byKey: Partial<Record<string, T>> = {};
  read.forEach((c, i) => { const d = results[i]?.data; if (d !== undefined) byKey[c.key] = d; });
  return {
    byKey,
    loading: results.some((r) => r.isLoading),
    failed: results.filter((r) => r.isError).length,
    complete: read.length > 0 && read.every((c) => byKey[c.key] !== undefined),
  };
}

export const PnLTab = () => {
  const r = useReportRange();
  const [view, setView] = useState<StatementView>('single');
  const [compareWith, setCompareWith] = useState<CompareWith>('previous');
  const [months, setMonths] = useState<number>(6);
  const [level, setLevel] = useState<Level>('all');
  const [showPct, setShowPct] = useState(true);
  const [editing, setEditing] = useState(false);
  const { can } = useAuth();
  const canArrange = can('scm.payment_voucher.post');
  const tree = useReportTree(level);
  const openLedger = useOpenLedger('P&L');
  const chartWin = useChartMonths(r.from, r.to, r.usable);

  const columns = useMemo(
    () => (r.usable ? pnlColumns(view, r.from, r.to, r.today, { compareWith, months }) : []),
    [r.usable, r.from, r.to, r.today, view, compareWith, months],
  );
  const reads = useColumnReads<PnlResponse>(columns, (c) => ['report-pnl', c.from, c.to], (c) => fetchPnl(c.from, c.to));
  const lines = useMemo(() => statementLines(columns, Object.fromEntries(Object.entries(reads.byKey).map(([k, d]) => [k, pnlLines(d!)]))), [columns, reads.byKey]);
  const depth = monthlyDepth(lines);
  const shown = linesVisible(lines, level, tree.open);
  const head = reads.byKey[columns[0]?.key ?? ''];
  const stored = head?.layout.stored;
  const span = columnsSpan(columns);

  const periodText = view === 'month'
    ? `${monthName(span.from)} – ${monthName(span.to)} · ${months} months`
    : view === 'compare' && columns[1]
      ? `${fmtDate(r.from)} – ${fmtDate(r.to)} against ${fmtDate(columns[1].from)} – ${fmtDate(columns[1].to)}`
      : `${fmtDate(r.from)} – ${fmtDate(r.to)}`;
  const levelText = level === 'all' ? '' : ` · level ${level}`;
  useReportSubtitle(r.usable ? `${periodText} · % of sales${layoutWord(stored)}${levelText}` : 'Pick dates.');

  const fileBase = view === 'month'
    ? `pnl-monthly-${span.from.slice(0, 7)}-${span.to.slice(0, 7)}`
    : view === 'compare' ? `pnl-compare-${r.from}-to-${r.to}` : `pnl-${r.from}-to-${r.to}`;
  const sheet = (): ReportSheet | null => (reads.complete ? {
    title: 'P&L',
    subtitle: `${periodText} · ${showPct ? '% of sales beside' : 'amounts'}${layoutWord(stored)}${levelText}`,
    meta: [{ label: 'Period', value: view === 'month' ? `${monthName(span.from)} – ${monthName(span.to)}` : `${fmtDate(r.from)} – ${fmtDate(r.to)}` }],
    tables: [sheetTable(view, columns, shown, showPct, '% of sales')],
  } : null);

  /* The closing stock note sits under Cost of sales while the stock is provisional. */
  const noteAfter = (l: StatementLine) => (l.id === 'tot:costOfSales' && head?.stock?.closingProvisional ? (
    <tr className={s.noteRow}><td colSpan={columns.length + 1}>Closing stock is what the shelves hold as of {fmtDate(head.stock.asOf)} — provisional until the month-end close books it.</td></tr>
  ) : null);

  return (
    <>
      <ReportHeaderActions>
        <ReportExports sheet={sheet} fileBase={fileBase} onLayout={canArrange ? () => setEditing((v) => !v) : undefined} layoutOn={editing} />
      </ReportHeaderActions>
      <ReportToolbar>
        <FinanceDateRange />
        <ReportTool label="View"><Segmented options={PNL_VIEWS} value={view} onChange={setView} label="View" /></ReportTool>
        {view === 'compare' && (
          <ReportTool label="Against"><Segmented options={COMPARE_WITH} value={compareWith} onChange={setCompareWith} label="Compare against" /></ReportTool>
        )}
        {view === 'month' && (
          <ReportTool label="Months"><Segmented options={MONTH_OPTIONS} value={months} onChange={setMonths} label="Months" /></ReportTool>
        )}
        <LevelTool depth={depth} level={level} onLevel={setLevel} />
        <ReportSwitch on={showPct} onChange={setShowPct}>% beside</ReportSwitch>
      </ReportToolbar>
      {editing && <ReportLayoutEditor report="pnl" onClose={() => setEditing(false)} />}
      {chartWin && <PnlChart win={chartWin} />}
      {!r.usable && <ReportMessage>Pick dates.</ReportMessage>}
      {r.usable && reads.failed > 0 && (
        <ReportMessage tone="error">
          {view === 'single' ? 'The statement did not load — adjust the dates to retry.' : `${reads.failed} column(s) did not load — adjust the dates to retry.`}
        </ReportMessage>
      )}
      {r.usable && reads.loading && <StatementSkeleton label="Working the period out" />}
      {r.usable && !reads.loading && lines.length > 0 && (
        <StatementTable
          widthsKey={view}
          head="Account"
          columns={columns}
          lines={lines}
          shown={shown}
          level={level}
          tree={tree}
          showPct={showPct}
          finalId="net:net"
          onCategoryFigure={openLedger}
          noteAfter={noteAfter}
          note="Click an account’s name for its lines over the period, a figure for that column’s. Expenses print without brackets; only a line whose credits beat its debits, or a loss, prints in ( )."
          drillKey={`${view}|${r.from}|${r.to}|${compareWith}|${months}`}
          ariaLabel="P&L"
        />
      )}
    </>
  );
};

/* ── Balance sheet ────────────────────────────────────────────────────────── */
type BsLayout = {
  stored: boolean;
  /** Total assets — what every % is of, both sides; null when there are none. */
  baseSen: number | null;
  assets: LaidNode[]; liabilities: LaidNode[]; equity: LaidNode[];
};
type BsResponse = {
  assets: Line[]; liabilities: Line[]; equity: Line[];
  /** The same figures on the report's layout. */
  layout: BsLayout;
  totals: { assetsSen: number; liabilitiesSen: number; equitySen: number; earningsSen: number; checkSen: number };
};
const fetchBalanceSheet = (asOf: string) => authedFetch<BsResponse>(`/accounting/reports/balance-sheet?asOf=${asOf}`);
const STRONG_BS = new Set(['tot:assets']);

/** The balance sheet's tiles: what it owns, owes and is worth, and whether the two sides tie. */
export function balanceTiles(d: BsResponse | undefined): ReportTile[] {
  const t = d?.totals;
  const base = d?.layout.baseSen ?? null;
  const pct = (sen: number) => { const p = pctOf(sen, base); return p === null ? '' : `${p.toFixed(1)}% of total assets`; };
  const equity = t ? t.equitySen + t.earningsSen : 0;
  const check: ReportTile = t && t.checkSen !== 0
    ? { key: 'check', label: 'Check', value: `Out by ${fmtSen(Math.abs(t.checkSen))}`, sub: 'Assets less liabilities and equity', tone: 'late' }
    : { key: 'check', label: 'Check', value: t ? 'Balanced' : '—', sub: 'Assets = liabilities + equity', tone: t ? 'good' : 'plain' };
  return [
    { key: 'assets', label: 'Total assets', value: t ? fmtSenPlain(t.assetsSen) : '—', sub: 'What every % is of' },
    { key: 'liabilities', label: 'Total liabilities', value: t ? fmtSenPlain(t.liabilitiesSen) : '—', sub: t ? pct(t.liabilitiesSen) : '' },
    { key: 'equity', label: 'Equity', value: t ? fmtSenPlain(equity) : '—', sub: t ? `With current period earnings ${fmtSenPlain(t.earningsSen)}` : '' },
    check,
  ];
}

export const BalanceSheetTab = () => {
  const r = useReportRange();
  const asAt = r.to || r.today;
  const [view, setView] = useState<StatementView>('single');
  const [months, setMonths] = useState<number>(6);
  const [level, setLevel] = useState<Level>('all');
  const [showPct, setShowPct] = useState(true);
  const [editing, setEditing] = useState(false);
  const { can } = useAuth();
  const canArrange = can('scm.payment_voucher.post');
  const tree = useReportTree(level);
  const openLedger = useOpenLedger('Balance sheet');
  const usable = /^\d{4}-\d{2}-\d{2}$/.test(asAt);

  const columns = useMemo(() => (usable ? balanceColumns(view, asAt, r.today, months) : []), [usable, view, asAt, r.today, months]);
  const reads = useColumnReads<BsResponse>(columns, (c) => ['report-bs', c.to], (c) => fetchBalanceSheet(c.to));
  const lines = useMemo(() => statementLines(columns, Object.fromEntries(Object.entries(reads.byKey).map(([k, d]) => [k, balanceSheetLines(d!)]))), [columns, reads.byKey]);
  const depth = monthlyDepth(lines);
  const shown = linesVisible(lines, level, tree.open);
  const head = reads.byKey[columns[0]?.key ?? ''];
  const stored = head?.layout.stored;
  const span = columnsSpan(columns);

  const periodText = view === 'month' ? `Month-end balances · ${monthName(span.from)} – ${monthName(span.to)}` : `As at ${fmtDate(asAt)}`;
  const levelText = level === 'all' ? '' : ` · level ${level}`;
  useReportSubtitle(usable ? `${periodText} · % of total assets${layoutWord(stored)}${levelText}` : 'Pick the day.');

  const sheet = (): ReportSheet | null => (reads.complete ? {
    title: 'Balance Sheet',
    subtitle: `${periodText} · ${showPct ? '% of total assets beside' : 'amounts'}${layoutWord(stored)}${levelText}`,
    meta: [{ label: 'As at', value: fmtDate(asAt) }],
    tables: [sheetTable(view, columns, shown, showPct, '% of total assets')],
  } : null);
  const fileBase = view === 'month' ? `balance-sheet-monthly-${span.from.slice(0, 7)}-${span.to.slice(0, 7)}` : `balance-sheet-${asAt}`;

  return (
    <>
      <ReportHeaderActions>
        <ReportExports sheet={sheet} fileBase={fileBase} onLayout={canArrange ? () => setEditing((v) => !v) : undefined} layoutOn={editing} />
      </ReportHeaderActions>
      <ReportToolbar>
        <ReportTool label="As at">
          <DateField value={asAt} onChange={r.setAsAt} aria-label="Balance sheet as at" />
        </ReportTool>
        <ReportTool label="View"><Segmented options={BS_VIEWS} value={view} onChange={setView} label="View" /></ReportTool>
        {view === 'month' && (
          <ReportTool label="Months"><Segmented options={MONTH_OPTIONS} value={months} onChange={setMonths} label="Months" /></ReportTool>
        )}
        <LevelTool depth={depth} level={level} onLevel={setLevel} />
        <ReportSwitch on={showPct} onChange={setShowPct}>% beside</ReportSwitch>
      </ReportToolbar>
      {editing && <ReportLayoutEditor report="balance_sheet" onClose={() => setEditing(false)} />}
      {usable && <ReportTiles label="Balance sheet figures" tiles={balanceTiles(head)} pending={!head && reads.loading} />}
      {!usable && <ReportMessage>Pick the day.</ReportMessage>}
      {usable && reads.failed > 0 && (
        <ReportMessage tone="error">
          {view === 'single' ? 'The statement did not load — pick the date again to retry.' : `${reads.failed} column(s) did not load — pick the date again to retry.`}
        </ReportMessage>
      )}
      {usable && reads.loading && <StatementSkeleton label="Adding the ledger up" />}
      {usable && !reads.loading && lines.length > 0 && (
        <StatementTable
          widthsKey={view === 'month' ? 'month' : 'single'}
          head="Account"
          columns={columns}
          lines={lines}
          shown={shown}
          level={level}
          tree={tree}
          showPct={showPct}
          finalId="net:check"
          strongIds={STRONG_BS}
          onCategoryFigure={openLedger}
          note="Every line’s % is of total assets, on both sides. Click an account’s name or a figure for its lines in that month."
          drillKey={`${view}|${asAt}|${months}`}
          ariaLabel="Balance sheet"
        />
      )}
    </>
  );
};
