// ----------------------------------------------------------------------------
// PnlSideBySide — the Overall P&L's views side by side (owner 2026-11-25: 这个
// view 我可以select我要看什么view，也可以同时显示两个还是三个; 一张表并排):
// one table on the P&L's own rows, a column per view on in the P&L views bar —
// Actual (by sales invoice: the books) and Forecast (the targets; the
// Performance view is gone, owner 2026-11-28) — each with its % of its own
// sales, then the difference, Actual less Forecast. The range's whole months,
// as the Forecast is kept.
//
// Whole range | By month (the same day: 可以by month 显示两份以上吗？): By month
// puts those columns under each month's name — the Total over the months
// first, then each month newest first, as the P&L's own By month; the range's
// newest 12 months at most. Each period is the server's read for it; a month
// with no forecast leaves its Forecast and differences blank, and says so.
//
// The rows are the P&L's (GET /accounting/reports/pnl-views lays the Forecast
// on its tree). A view the reader may not open is left out, as the bar leaves
// it out.
// ----------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { monthEnd, monthStart } from '../../lib/dateRangePresets';
import { fmtDate } from '../../../../shared/src/vendor/shared/format';
import { mergeColumns, monthlyDepth, pnlLines } from '../../vendor/scm/lib/report-monthly';
import { linesVisible } from '../../vendor/scm/lib/report-layout';
import { statementColumnsTable, type ReportSheet } from '../../vendor/scm/lib/report-sheet';
import { usePnlViews, type PnlViewsPayload } from '../../vendor/scm/lib/pnl-views-queries';
import { useReportTree, type Level } from './ReportLayoutTree';
import { PNL_BY_MONTH, PNL_CHOICES, pnlViewsOf, type OverallPnlView } from './reports-catalog';
import { FinanceDateRange } from './reports/FinanceDateRange';
import { useVisibleReports } from './reports/ReportRail';
import {
  ReportExports, ReportHeaderActions, ReportMessage, ReportSwitch, ReportTool, ReportToolbar, Segmented, useReportSubtitle,
} from './reports/reportParts';
import { StatementSkeleton, StatementTable } from './reports/StatementTable';
import { monthName, monthsSpanned, type StatementColumn, type StatementLine } from './reports/statementColumns';
import { LevelTool } from './reports/statementTools';
import { useReportRange } from './reports/useReportRange';

const VIEW_COLUMN: Record<OverallPnlView, { label: string; sub: string; mark: NonNullable<StatementColumn['mark']> }> = {
  actual: { label: 'Actual', sub: 'by sales invoice', mark: 'petrol' },
  forecast: { label: 'Forecast', sub: 'the targets', mark: 'gold' },
};

/** The range as one, or month by month. */
export type SideBySideShow = 'range' | 'month';
const SHOW: ReadonlyArray<{ value: SideBySideShow; label: string }> = [
  { value: 'range', label: 'Whole range' },
  { value: 'month', label: 'By month' },
];
/** By month reads at most this many months, the range's newest — as the P&L's own By month. */
export const MONTHS_AT_MOST = 12;

/** A period the table reads: the whole range (no key), or by month the Total or one month. */
export type SideBySidePeriod = { key: string | null; label: string; sub?: string; from: string; to: string };

const monthsLabel = (from: string, to: string): string =>
  (from.slice(0, 7) === to.slice(0, 7) ? monthName(from) : `${monthName(from)} – ${monthName(to)}`);

/** By month's periods: the Total over the months when there are two or more, then each
 *  month, newest first — the range's newest twelve at most; the month still running
 *  says to which day. */
export function monthPeriods(from: string, to: string, today: string): SideBySidePeriod[] {
  const n = Math.min(Math.max(1, monthsSpanned(from, to)), MONTHS_AT_MOST);
  const months = Array.from({ length: n }, (_, i) => monthStart(to, -i));
  const each = months.map((m): SideBySidePeriod => ({
    key: m.slice(0, 7),
    label: monthName(m),
    ...(m <= today && today < monthEnd(m) ? { sub: `to ${fmtDate(today)}` } : {}),
    from: m,
    to: monthEnd(m),
  }));
  if (n < 2) return each;
  return [{ key: 'total', label: 'Total', sub: `${n} months`, from: months[n - 1]!, to: monthEnd(months[0]!) }, ...each];
}

const keyIn = (period: string | null, key: string): string => (period ? `${period}:${key}` : key);

/** The differences a set of views shows: each less the Forecast where it is on. */
export function differencesOf(views: readonly OverallPnlView[]): Array<[OverallPnlView, OverallPnlView]> {
  if (!views.includes('forecast')) return [];
  return views.filter((v) => v !== 'forecast').map((v): [OverallPnlView, OverallPnlView] => [v, 'forecast']);
}

/** The table's columns: a view each, then the differences — by month, the lot under each period's name. */
export function sideBySideColumns(views: readonly OverallPnlView[], periods: readonly SideBySidePeriod[]): StatementColumn[] {
  return periods.flatMap((p) => {
    const group = p.key ? { group: { key: p.key, label: p.label, ...(p.sub ? { sub: p.sub } : {}) } } : {};
    return [
      ...views.map((v): StatementColumn => ({
        key: keyIn(p.key, v), label: VIEW_COLUMN[v].label, sub: VIEW_COLUMN[v].sub, kind: 'period', from: p.from, to: p.to, pct: true,
        mark: VIEW_COLUMN[v].mark, noDrill: true, ...group,
      })),
      ...differencesOf(views).map(([a, b]): StatementColumn => ({
        key: keyIn(p.key, `${a}-${b}`), label: `${VIEW_COLUMN[a].label} − ${VIEW_COLUMN[b].label}`, kind: 'change', from: p.from, to: p.to, pct: false, ...group,
      })),
    ];
  });
}

/** The views' lines on the P&L's rows, merged — each period's views where its read has
 *  them — and each period's differences worked out on every line a view names, where
 *  the period has both views. */
export function sideBySideLines(reads: ReadonlyArray<{ period: string | null; data: PnlViewsPayload }>, views: readonly OverallPnlView[]): StatementLine[] {
  const merged = mergeColumns(reads.flatMap(({ period, data }) => views.flatMap((v) => {
    const side = data[v];
    return side ? [{ key: keyIn(period, v), lines: pnlLines(side) }] : [];
  })));
  const diffs = reads.flatMap(({ period, data }) => differencesOf(views)
    .filter(([a, b]) => data[a] != null && data[b] != null)
    .map(([a, b]) => ({ a: keyIn(period, a), b: keyIn(period, b), key: keyIn(period, `${a}-${b}`) })));
  if (diffs.length === 0) return merged;
  return merged.map((l) => {
    if (l.kind === 'block') return l;
    const cells = { ...l.cells };
    for (const d of diffs) {
      const x = l.cells[d.a]?.amountSen;
      const y = l.cells[d.b]?.amountSen;
      if (x === undefined && y === undefined) continue;
      cells[d.key] = { amountSen: (x ?? 0) - (y ?? 0), pct: null };
    }
    return { ...l, cells };
  });
}

const NOTE = 'Actual is the books: sales as invoiced. Forecast is the targets per account. '
  + 'Each % is of that view’s own sales; the difference is Actual less Forecast.';
const MONTH_NOTE = ' By month: the Total over the months, then each month, newest first.';

export const PnlSideBySideTab = () => {
  const r = useReportRange();
  const [params, setParams] = useSearchParams();
  const reports = useVisibleReports();
  const views = useMemo(() => pnlViewsOf(params.get('views')).filter((v) => {
    const choice = PNL_CHOICES.find((c) => c.family === 'overall' && c.view === v);
    return choice != null && reports.some((x) => x.id === choice.report);
  }), [params, reports]);
  const show: SideBySideShow = params.get(PNL_BY_MONTH.param) === PNL_BY_MONTH.value ? 'month' : 'range';
  const setShow = (v: SideBySideShow) => setParams((prev) => {
    const next = new URLSearchParams(prev);
    if (v === 'month') next.set(PNL_BY_MONTH.param, PNL_BY_MONTH.value); else next.delete(PNL_BY_MONTH.param);
    return next;
  }, { replace: true });
  const [level, setLevel] = useState<Level>('all');
  const [showPct, setShowPct] = useState(true);
  const tree = useReportTree(level);

  const from = r.usable ? monthStart(r.from) : monthStart(r.today);
  const to = r.usable ? monthEnd(r.to) : monthEnd(r.today);
  const periods = useMemo(
    () => (show === 'month' ? monthPeriods(from, to, r.today) : [{ key: null, label: monthsLabel(from, to), from, to }]),
    [show, from, to, r.today],
  );
  const span = periods[0]!;
  const period = monthsLabel(span.from, span.to);
  const partMonths = r.usable && (r.from !== from || r.to !== to);
  const cut = span.from !== from;
  const enough = views.length >= 2;
  useReportSubtitle(`${period}${partMonths ? ' · whole months' : ''}${cut ? ` · the range’s newest ${MONTHS_AT_MOST} months` : ''}`
    + `${enough ? ` · ${views.map((v) => VIEW_COLUMN[v].label).join(', ')} side by side` : ''}${show === 'month' ? ' · by month' : ''}`);

  const q = usePnlViews(periods, enough);
  const reads = q.complete ? periods.map((p, i) => ({ period: p.key, label: p.label, data: q.data[i]! })) : [];
  const sides = views.filter((v) => v !== 'forecast' || reads.some((x) => x.data.forecast != null));
  const columns = sideBySideColumns(sides, periods);
  const lines = reads.length > 0 && sides.length > 0 ? sideBySideLines(reads, sides) : [];
  const shown = linesVisible(lines, level, tree.open);
  const monthsRead = reads.filter((x) => x.period !== 'total');
  const noForecast = views.includes('forecast') ? monthsRead.filter((x) => x.data.forecast == null) : [];
  const noForecastText = noForecast.length === monthsRead.length ? period : noForecast.map((x) => x.label).join(', ');
  const sheet = (): ReportSheet | null => (lines.length > 0 ? {
    title: 'Overall P&L',
    subtitle: `${period}${show === 'month' ? ' · by month' : ''} · ${sides.map((v) => VIEW_COLUMN[v].label).join(', ')} side by side${showPct ? ' · % of each view’s sales beside' : ''}`,
    meta: [{ label: 'Months', value: period }],
    tables: [statementColumnsTable(columns.map((c) => ({
      key: c.key, label: c.label, pct: c.pct && showPct, ...(c.group ? { group: c.group.label } : {}),
    })), shown)],
  } : null);

  return (
    <>
      <ReportHeaderActions>
        <ReportExports sheet={sheet} fileBase={`pnl-side-by-side${show === 'month' ? '-monthly' : ''}-${span.from.slice(0, 7)}-${span.to.slice(0, 7)}`} />
      </ReportHeaderActions>
      <ReportToolbar>
        <FinanceDateRange label="Months" />
        <ReportTool label="Show"><Segmented options={SHOW} value={show} onChange={setShow} label="Whole range or by month" /></ReportTool>
        <LevelTool depth={monthlyDepth(lines)} level={level} onLevel={setLevel} />
        <ReportSwitch on={showPct} onChange={setShowPct}>% beside</ReportSwitch>
      </ReportToolbar>
      {!enough && <ReportMessage>Turn on Actual and Forecast above to see them side by side.</ReportMessage>}
      {enough && q.failed > 0 && (
        <ReportMessage tone="error">The views could not be read — {q.error instanceof Error ? q.error.message : String(q.error)}</ReportMessage>
      )}
      {enough && q.failed === 0 && !q.complete && <StatementSkeleton label="Working the views out" />}
      {noForecast.length > 0 && (
        <ReportMessage>No forecast for {noForecastText} — the Forecast P&amp;L has none for {noForecast.length === 1 && monthsRead.length > 1 ? 'that month' : 'these months'}.</ReportMessage>
      )}
      {lines.length > 0 && (
        <StatementTable
          widthsKey={show === 'month' ? 'pnl-views-month' : 'pnl-views'}
          head="Account"
          columns={columns}
          lines={lines}
          shown={shown}
          level={level}
          tree={tree}
          showPct={showPct}
          finalId="net:net"
          note={show === 'month' ? `${NOTE}${MONTH_NOTE}` : NOTE}
          drillKey={`${show}|${span.from}|${span.to}|${sides.join(',')}`}
          ariaLabel="Overall P&L, views side by side"
        />
      )}
    </>
  );
};
