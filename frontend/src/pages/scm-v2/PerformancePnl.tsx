// ----------------------------------------------------------------------------
// PerformancePnl — the Performance P&L tab (owner 2026-09-12: 我还要多一份
// performance P&L，就是 sales 和 COGS 的数额是根据 sales order 的，expense 其他
// remain，但是 expense 的 operating 要根据 sales 的 16% 来算 … 分成 bedframe,
// mattress, sofa, dining, accessory, service … 16% 要设计成可调 … 只取代 900-O001，
// 然后在 performance P&L 要注明 … 放 finance report, CSV, PDF, 每组显示 gross
// profit 和 %; docs/bugs/0835). The numbers come from
// GET /accounting/reports/performance, computed live on every read; the rate
// and the account it stands in for are the company's settings, edited here —
// with the other accounts the rate also covers (owner 2026-10-06: 2990's
// transport is inside the 16%; Houzs names none).
//
// In the owner's Claude Design (batch 6 step 12, §5.5): the report shell, the
// shared range read as the SO date, the operating expense line under the
// toolbar (Change edits it in place), the statement table — Single: the
// product groups, the other income and the expenses on the report's own
// layout (docs/bugs/0912), NET PERFORMANCE; By month: a column per month,
// one read each — and the chart of the months, from read c6 (the report's
// own builder, the window's orders read once). Excel / PDF / Print carry the
// tables AS SHOWN (owner 2026-09-19: 显示什么就 export 什么).
// ----------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import { SlidersHorizontal } from 'lucide-react';
import { useAuth } from '../../auth/AuthContext';
import { authedFetch } from '../../vendor/scm/lib/authed-fetch';
import { fmtDate, fmtSenPlain } from '../../vendor/shared/format';
import {
  fmtPerf, performanceNotes, performanceReportPath, performanceSummaryLines, usePerformanceMonths, usePerformanceReport,
  useSavePerformanceSettings, type PerformanceMonth, type PerformanceReport,
} from '../../vendor/scm/lib/performance-report-queries';
import { performanceSheet } from '../../vendor/scm/lib/performance-pnl-pdf';
import { linesVisible } from '../../vendor/scm/lib/report-layout';
import { monthlyDepth, performanceLines } from '../../vendor/scm/lib/report-monthly';
import type { ReportSheet } from '../../vendor/scm/lib/report-sheet';
import { monthStart } from '../../lib/dateRangePresets';
import { useReportTree, type Level } from './ReportLayoutTree';
import { ReportLayoutEditor } from './ReportLayoutEditor';
import { useBooksToast } from './books/BooksToast';
import { FinanceDateRange } from './reports/FinanceDateRange';
import { useReportRange } from './reports/useReportRange';
import {
  ReportExports, ReportHeaderActions, ReportMessage, ReportTool, ReportToolbar, Segmented, useReportSubtitle,
} from './reports/reportParts';
import { StatementSkeleton, StatementTable } from './reports/StatementTable';
import { LevelTool, MONTH_OPTIONS, sheetTable, useColumnReads, useOpenLedger } from './reports/statementTools';
import { columnsSpan, monthColumns, monthName, statementLines, type StatementColumn, type StatementLine } from './reports/statementColumns';
import { REPORT_CHART_COLORS, ReportBarChart, thousands, useChartMonths, type ChartBarSeries, type ChartMonth } from './reports/ReportBarChart';
import { windowMonths, type ChartWindow } from './reports/chartWindow';
import css from './reports/OperatingExpense.module.css';

type PerfView = 'single' | 'month';
const VIEWS: ReadonlyArray<{ value: PerfView; label: string }> = [
  { value: 'single', label: 'Single' },
  { value: 'month', label: 'By month' },
];

const ratePct = (bp: number): string => `${(bp / 100).toFixed(2)}%`;
const errText = (e: unknown): string => (e instanceof Error && e.message ? e.message : 'That was not accepted.');
/** The codes typed into "also covers": comma or space apart, upper case, each once. */
const codesOf = (text: string): string[] => [...new Set(text.split(/[\s,]+/).map((c) => c.trim().toUpperCase()).filter(Boolean))];

/** The Single view's columns: Sales, Cost of sales, Gross profit with its % beside. */
const singleColumns = (from: string, to: string): StatementColumn[] => [
  { key: 'sales', label: 'Sales', kind: 'period', from, to, pct: false },
  { key: 'cogs', label: 'Cost of sales', kind: 'period', from, to, pct: false },
  { key: 'gp', label: 'Gross profit', sub: 'amounts below the groups · % of sales below', kind: 'period', from, to, pct: true },
];

/** The Single view as statement lines: the product groups with their total,
 *  then the other income and the expenses on the report's tree — each amount
 *  under Gross profit, its % of sales under GP % — and NET PERFORMANCE. The
 *  sums are the server's; nothing is added up here. */
export function performanceSingleLines(r: PerformanceReport): StatementLine[] {
  const cell = (amountSen: number, pct: number | null = null) => ({ amountSen, pct });
  const summary = performanceSummaryLines(r);
  const otherAt = summary.findIndex((l) => l.id === 'sum:otherIncome');
  const expensesAt = summary.findIndex((l) => l.id === 'sum:expenses');
  const tree = (from: number, to: number): StatementLine[] => summary.slice(from, to).map((l) => ({
    id: l.id, label: l.label, kind: l.kind === 'row' ? 'row' : 'category', depth: l.depth,
    ...(l.code ? { code: l.code } : {}), cells: { gp: cell(l.amountSen, l.pct) },
  }));
  const fixed = (id: string, kind: StatementLine['kind']): StatementLine => {
    const l = summary.find((x) => x.id === id)!;
    return { id, label: l.label, kind, depth: 0, cells: { gp: cell(l.amountSen, l.pct) } };
  };
  return [
    { id: 'blk:groups', label: 'Product groups', caption: '· GP % = gross profit ÷ that group’s own sales', kind: 'block', depth: 0, cells: {} },
    ...r.groups.map((g): StatementLine => ({
      id: `grp:${g.key}`, label: g.label, caption: `· ${g.lines} ${g.lines === 1 ? 'line' : 'lines'}`, kind: 'row', depth: 1,
      cells: { sales: cell(g.salesSen), cogs: cell(g.cogsSen), gp: cell(g.gpSen, g.gpPct) },
    })),
    {
      id: 'tot:groups', label: 'Total', caption: `· ${r.orders.counted} orders, ${r.orders.notDelivered} not yet delivered`, kind: 'total', depth: 0,
      cells: { sales: cell(r.totals.salesSen), cogs: cell(r.totals.cogsSen), gp: cell(r.totals.gpSen, r.totals.gpPct) },
    },
    { id: 'blk:otherIncome', label: 'Other income', caption: '· amount under Gross profit, % of total sales under GP %', kind: 'block', depth: 0, cells: {} },
    ...tree(1, otherAt),
    fixed('sum:otherIncome', 'total'),
    { id: 'blk:expenses', label: 'Expenses', kind: 'block', depth: 0, cells: {} },
    ...tree(otherAt + 1, expensesAt),
    fixed('sum:expenses', 'total'),
    fixed('sum:net', 'net'),
  ];
}

/** By month: what each block's % is, in the design's words. */
const MONTH_CAPTIONS: Record<string, string> = {
  'blk:sales': '· % = share of the month’s sales',
  'blk:cogs': '· % of the month’s sales',
  'blk:gp': '· % = GP % · gross profit ÷ that group’s own sales',
  'sum:otherIncome': '· % of the month’s sales',
  'sum:expenses': '· % of the month’s sales',
};

/* ── The chart (batch 6 §5.5): sales, cost of sales and expenses a month, net
   performance under each — from read c6, the report's own builder. ── */
const PERF_SERIES: ChartBarSeries[] = [
  { key: 'sales', label: 'Sales', color: REPORT_CHART_COLORS.petrol },
  { key: 'cogs', label: 'Cost of sales', color: REPORT_CHART_COLORS.gold },
  { key: 'expenses', label: 'Expenses', color: REPORT_CHART_COLORS.grey },
];

/** The window's months as the chart draws them; GP % and the margin are the server's. */
export function performanceChartMonths(win: ChartWindow | null, months: readonly PerformanceMonth[]): ChartMonth[] {
  if (!win) return [];
  const byMonth = new Map(months.map((m) => [`${m.month}-01`, m]));
  return windowMonths(win).map((month): ChartMonth => {
    const p = byMonth.get(month);
    if (!p) return { month, values: {}, bottom: [], under: null };
    const loss = p.netSen < 0;
    return {
      month,
      values: { sales: p.salesSen, cogs: p.cogsSen, expenses: p.expensesSen },
      bottom: [
        { label: 'Net performance', value: fmtSenPlain(p.netSen), loss },
        { label: 'GP %', value: p.gpPct == null ? '—' : `${p.gpPct.toFixed(1)}%` },
        { label: 'Net margin', value: p.netPct == null ? '—' : `${p.netPct.toFixed(1)}%`, loss },
      ],
      under: { text: thousands(p.netSen), loss },
    };
  });
}

function PerformanceChart({ win, onOpen }: { win: ChartWindow; onOpen: () => void }) {
  const q = usePerformanceMonths(win.from.slice(0, 7), win.to.slice(0, 7));
  return (
    <ReportBarChart
      title="Sales, cost and expenses"
      series={PERF_SERIES}
      months={performanceChartMonths(win, q.data?.months ?? [])}
      win={win}
      loading={q.isLoading}
      failed={q.isError}
      note="Figures under the bars are net performance (RM thousand) — red is a loss. Shaded months are in the period; click a month to open it."
      onOpen={onOpen}
    />
  );
}

/* ── The operating expense line (batch 6 §5.5): the rate and what it stands
   in for, Change to edit it in place — the rate, the account and the other
   accounts the rate also covers (owner 2026-10-06). ── */
function OperatingExpenseLine({ r }: { r: PerformanceReport }) {
  const save = useSavePerformanceSettings();
  const toast = useBooksToast();
  const [draft, setDraft] = useState<{ ratePct: string; account: string; also: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const o = r.operatingExpense;
  const also = o.also ?? [];
  const start = () => {
    setError(null);
    setDraft({ ratePct: (r.settings.rateBp / 100).toFixed(2), account: r.settings.account, also: (r.settings.also ?? []).join(', ') });
  };
  const submit = () => {
    if (!draft) return;
    const rateBp = Math.round(Number(draft.ratePct) * 100);
    if (draft.ratePct.trim() === '' || !Number.isFinite(rateBp) || rateBp < 0 || rateBp > 10000) { setError('The rate must be between 0% and 100%.'); return; }
    if (draft.account.trim() === '') { setError('Name the account the rate stands in for.'); return; }
    save.mutate({ rateBp, account: draft.account.trim(), also: codesOf(draft.also) }, {
      onSuccess: (res) => {
        setDraft(null);
        const covers = res.settings.also ?? [];
        toast.say(`Saved · ${ratePct(res.settings.rateBp)} in place of ${res.settings.account}${covers.length > 0 ? `, also covering ${covers.join(', ')}` : ''}`);
      },
      onError: (e) => setError(errText(e)),
    });
  };

  return (
    <section className={css.line} aria-label="Performance settings">
      {toast.node}
      <SlidersHorizontal size={15} strokeWidth={1.75} className={css.icon} aria-hidden />
      <span className={css.title}>Operating expense</span>
      {draft == null ? (
        <>
          <span className={css.what}>
            {ratePct(o.rateBp)} of sales excluding service, in place of <span className={css.code}>{o.account}</span>{' '}
            {o.accountFound ? o.accountName : <span className={css.missing}>· not in this company’s chart</span>}
            {also.length > 0 && (
              <span aria-label="Covered accounts">
                {' and '}
                {also.map((a, i) => (
                  <span key={a.code}>
                    {i > 0 && ', '}
                    {a.code}{a.name ? '' : <span className={css.missing}> not in this company’s chart</span>}
                  </span>
                ))}
              </span>
            )}
          </span>
          <span className={css.spacer} />
          <button type="button" className={css.btn} onClick={start}>Change</button>
        </>
      ) : (
        <>
          <input type="number" min={0} max={100} step="0.01" value={draft.ratePct} onChange={(e) => setDraft({ ...draft, ratePct: e.target.value })}
            aria-label="Operating expense rate percent" className={`${css.input} ${css.rate}`} />
          <span>% of sales excluding service, in place of account</span>
          <input value={draft.account} onChange={(e) => setDraft({ ...draft, account: e.target.value })} aria-label="Operating expense account"
            className={`${css.input} ${css.account}`} />
          {o.accountFound ? <span>{o.accountName}</span> : <span className={css.missing}>not in this company’s chart</span>}
          <span>also covers</span>
          <input value={draft.also} onChange={(e) => setDraft({ ...draft, also: e.target.value })} placeholder="none — e.g. 900-T004, 900-T008"
            aria-label="Accounts the rate also covers" title="Their booked amounts are inside the rate: they leave the expenses and print at nil (with the accounts under them)."
            className={`${css.input} ${css.also}`} />
          <span className={css.spacer} />
          <button type="button" className={css.btn} onClick={() => { setDraft(null); setError(null); }}>Cancel</button>
          <button type="button" className={`${css.btn} ${css.solid}`} disabled={save.isPending} onClick={submit}>{save.isPending ? 'Saving…' : 'Save'}</button>
          {error && <p className={css.error} role="alert">{error}</p>}
        </>
      )}
    </section>
  );
}

/** "October runs to the 29th" when the period's last month is still running. */
function runsTo(lastDay: string, today: string): string {
  if (monthStart(lastDay) !== monthStart(today)) return '';
  const day = Number(today.slice(8, 10));
  const nth = day % 10 === 1 && day !== 11 ? 'st' : day % 10 === 2 && day !== 12 ? 'nd' : day % 10 === 3 && day !== 13 ? 'rd' : 'th';
  const month = new Date(`${monthStart(today)}T00:00:00Z`).toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
  return ` · ${month} runs to the ${day}${nth}`;
}

export const PerformanceTab = () => {
  const r = useReportRange();
  const [view, setView] = useState<PerfView>('single');
  const [months, setMonths] = useState<number>(6);
  const [level, setLevel] = useState<Level>('all');
  const [editing, setEditing] = useState(false);
  const { can } = useAuth();
  const canArrange = can('scm.payment_voucher.post');
  const tree = useReportTree(level);
  const openLedger = useOpenLedger('Performance P&L');
  const chartWin = useChartMonths(r.from, r.to, r.usable);

  /* Single: one read of the report. By month: one read per column (the same endpoint). */
  const single = usePerformanceReport(r.usable ? r.from : '', r.usable ? r.to : '');
  const rep = single.data;
  const monthCols = useMemo(() => (r.usable && view === 'month' ? monthColumns(r.to, months, r.today, true) : []), [r.usable, r.to, r.today, view, months]);
  const reads = useColumnReads<PerformanceReport>(monthCols, (c) => ['report-performance', c.from, c.to], (c) => authedFetch<PerformanceReport>(performanceReportPath(c.from, c.to)));

  const columns = view === 'single' ? singleColumns(r.from, r.to) : monthCols;
  const lines = useMemo((): StatementLine[] => {
    if (view === 'single') return rep ? performanceSingleLines(rep) : [];
    const merged = statementLines(monthCols, Object.fromEntries(Object.entries(reads.byKey).map(([k, d]) => [k, performanceLines(d!, performanceSummaryLines(d!))])));
    return merged.map((l) => (MONTH_CAPTIONS[l.id] ? { ...l, caption: MONTH_CAPTIONS[l.id] } : l));
  }, [view, rep, monthCols, reads.byKey]);
  const depth = monthlyDepth(lines);
  const shown = linesVisible(lines, level, tree.open);
  const span = columnsSpan(monthCols);

  const periodText = view === 'month'
    ? `${monthName(span.from)} – ${monthName(span.to)} · ${months} months${runsTo(span.to, r.today)}`
    : `${fmtDate(r.from)} – ${fmtDate(r.to)}${runsTo(r.to, r.today)}`;
  useReportSubtitle(r.usable ? `${periodText} · sales orders by SO date · click a figure for its lines` : 'Pick dates.');

  const loading = view === 'single' ? single.isLoading : reads.loading;
  const failed = view === 'single' ? single.isError : reads.failed > 0;
  const fileBase = view === 'month'
    ? `performance-pnl-monthly-${span.from.slice(0, 7)}-${span.to.slice(0, 7)}`
    : `performance-pnl-${r.from}-to-${r.to}`;
  const sheet = (): ReportSheet | null => {
    if (view === 'single') return rep ? performanceSheet(rep, { level, open: tree.open }) : null;
    return reads.complete ? {
      title: 'Performance P&L',
      subtitle: `${monthName(span.from)} – ${monthName(span.to)} · ${months} months · sales orders by SO date · % beside`,
      meta: [{ label: 'Period', value: `${monthName(span.from)} – ${monthName(span.to)}` }],
      tables: [sheetTable('month', monthCols, shown, true, '% of sales')],
      fmt: fmtPerf,
    } : null;
  };

  return (
    <>
      <ReportHeaderActions>
        <ReportExports sheet={sheet} fileBase={fileBase} onLayout={canArrange ? () => setEditing((v) => !v) : undefined} layoutOn={editing} />
      </ReportHeaderActions>
      <ReportToolbar>
        <FinanceDateRange />
        <ReportTool label="View"><Segmented options={VIEWS} value={view} onChange={setView} label="View" /></ReportTool>
        {view === 'month' && (
          <ReportTool label="Months"><Segmented options={MONTH_OPTIONS} value={months} onChange={setMonths} label="Months" /></ReportTool>
        )}
        <LevelTool depth={depth} level={level} onLevel={setLevel} />
      </ReportToolbar>
      {rep && <OperatingExpenseLine r={rep} />}
      {editing && <ReportLayoutEditor report="performance" onClose={() => setEditing(false)} />}
      {chartWin && <PerformanceChart win={chartWin} onOpen={() => setView('single')} />}
      {!r.usable && <ReportMessage>Pick dates.</ReportMessage>}
      {r.usable && failed && (
        <ReportMessage tone="error">
          {view === 'single'
            ? `The report did not load — ${errText(single.error)}`
            : `${reads.failed} column(s) did not load — adjust the dates to retry.`}
        </ReportMessage>
      )}
      {r.usable && loading && <StatementSkeleton label="Working the period out" />}
      {r.usable && !loading && lines.length > 0 && (
        <StatementTable
          widthsKey={view === 'single' ? 'perf' : 'perf-month'}
          head={view === 'single' ? 'Product group / line' : 'Line'}
          columns={columns}
          lines={lines}
          shown={shown}
          level={level}
          tree={tree}
          showPct
          fmt={fmtPerf}
          finalId="sum:net"
          onCategoryFigure={openLedger}
          note="Click an account’s name for its lines over the period, a figure for that column’s. Expenses print without brackets; only a line whose credits beat its debits, or a loss, prints in ( )."
          drillKey={`${view}|${r.from}|${r.to}|${months}`}
          ariaLabel="Performance P&L"
        />
      )}
      {view === 'single' && rep && (
        <ul className={css.notes} aria-label="Performance notes">
          {performanceNotes(rep).map((n) => <li key={n}>{n}</li>)}
        </ul>
      )}
    </>
  );
};
