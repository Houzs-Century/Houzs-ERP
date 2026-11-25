// ----------------------------------------------------------------------------
// PnlSideBySide — the Overall P&L's views side by side (owner 2026-11-25: 这个
// view 我可以select我要看什么view，也可以同时显示两个还是三个; 一张表并排):
// one table on the P&L's own rows, a column per view picked in the P&L views
// bar — Actual (by sales invoice: the books), Performance (by sales order),
// Forecast (the targets) — each with its % of its own sales, then the
// differences: each view less the Forecast where the Forecast is picked, else
// Performance less Actual. The range's whole months, as the Forecast is kept.
//
// The rows are the P&L's (GET /accounting/reports/pnl-views lays the other two
// views on its tree): Performance's sales stand on each product group's sales
// account, its cost of sales on a line of its own (the cost of the goods on the
// orders), its operating expense at its rate and its commission at the bills.
// A view the reader may not open is left out, as the bar leaves it out.
// ----------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { monthEnd, monthStart } from '../../lib/dateRangePresets';
import { mergeColumns, monthlyDepth, pnlLines } from '../../vendor/scm/lib/report-monthly';
import { linesVisible } from '../../vendor/scm/lib/report-layout';
import type { ReportSheet } from '../../vendor/scm/lib/report-sheet';
import { usePnlViews, type PnlViewsPayload } from '../../vendor/scm/lib/pnl-views-queries';
import { useReportTree, type Level } from './ReportLayoutTree';
import { PNL_CHOICES, pnlViewsOf, type PnlView } from './reports-catalog';
import { FinanceDateRange } from './reports/FinanceDateRange';
import { useVisibleReports } from './reports/ReportRail';
import { ReportExports, ReportHeaderActions, ReportMessage, ReportSwitch, ReportToolbar, useReportSubtitle } from './reports/reportParts';
import { StatementSkeleton, StatementTable } from './reports/StatementTable';
import { monthName, type StatementColumn, type StatementLine } from './reports/statementColumns';
import { LevelTool, sheetTable } from './reports/statementTools';
import { useReportRange } from './reports/useReportRange';

/** Each view's column: its name, what it reads, its mark. */
const VIEW_COLUMN: Record<PnlView, { label: string; sub: string; mark: NonNullable<StatementColumn['mark']> }> = {
  actual: { label: 'Actual', sub: 'by sales invoice', mark: 'petrol' },
  performance: { label: 'Performance', sub: 'by sales order', mark: 'brass' },
  forecast: { label: 'Forecast', sub: 'the targets', mark: 'gold' },
};

/** The differences a set of views shows: each less the Forecast where it is picked, else Performance less Actual. */
export function differencesOf(views: readonly PnlView[]): Array<[PnlView, PnlView]> {
  if (views.includes('forecast')) return views.filter((v) => v !== 'forecast').map((v): [PnlView, PnlView] => [v, 'forecast']);
  return views.includes('actual') && views.includes('performance') ? [['performance', 'actual']] : [];
}

/** The table's columns: a view each, then the differences. */
export function sideBySideColumns(views: readonly PnlView[], from: string, to: string): StatementColumn[] {
  return [
    ...views.map((v): StatementColumn => ({ key: v, label: VIEW_COLUMN[v].label, sub: VIEW_COLUMN[v].sub, kind: 'period', from, to, pct: true, mark: VIEW_COLUMN[v].mark, noDrill: true })),
    ...differencesOf(views).map(([a, b]): StatementColumn => ({ key: `${a}-${b}`, label: `${VIEW_COLUMN[a].label} − ${VIEW_COLUMN[b].label}`, kind: 'change', from, to, pct: false })),
  ];
}

/** The views' lines on the P&L's rows, merged, each difference worked out on every line a view names. */
export function sideBySideLines(data: PnlViewsPayload, views: readonly PnlView[]): StatementLine[] {
  const shown = views.flatMap((v) => {
    const side = data[v];
    return side ? [{ key: v, lines: pnlLines(side) }] : [];
  });
  const merged = mergeColumns(shown);
  const diffs = differencesOf(shown.map((s) => s.key as PnlView));
  return merged.map((l) => {
    if (l.kind === 'block' || diffs.length === 0) return l;
    const cells = { ...l.cells };
    for (const [a, b] of diffs) {
      const x = l.cells[a]?.amountSen;
      const y = l.cells[b]?.amountSen;
      if (x === undefined && y === undefined) continue;
      cells[`${a}-${b}`] = { amountSen: (x ?? 0) - (y ?? 0), pct: null };
    }
    return { ...l, cells };
  });
}

const NOTE = 'Actual is the books: sales as invoiced. Performance is the sales orders by SO date: its sales on each product group’s sales account, '
  + 'its cost of sales one line (the cost of the goods on the orders), the operating expense at its rate and the commission at the month’s bills. '
  + 'Forecast is the targets per account. Each % is of that view’s own sales; a difference is the first view less the second.';

export const PnlSideBySideTab = () => {
  const r = useReportRange();
  const [params] = useSearchParams();
  const reports = useVisibleReports();
  /* The views named, each only where the reader may open it. */
  const views = useMemo(() => pnlViewsOf(params.get('views')).filter((v) => {
    const choice = PNL_CHOICES.find((c) => c.family === 'overall' && c.view === v);
    return choice != null && reports.some((x) => x.id === choice.report);
  }), [params, reports]);
  const [level, setLevel] = useState<Level>('all');
  const [showPct, setShowPct] = useState(true);
  const tree = useReportTree(level);

  /* Whole months: the Forecast is kept by month. */
  const from = r.usable ? monthStart(r.from) : monthStart(r.today);
  const to = r.usable ? monthEnd(r.to) : monthEnd(r.today);
  const period = from.slice(0, 7) === to.slice(0, 7) ? monthName(from) : `${monthName(from)} – ${monthName(to)}`;
  const partMonths = r.usable && (r.from !== from || r.to !== to);
  const enough = views.length >= 2;
  useReportSubtitle(`${period}${partMonths ? ' · whole months' : ''}${enough ? ` · ${views.map((v) => VIEW_COLUMN[v].label).join(', ')} side by side` : ''}`);

  const q = usePnlViews(from, to, enough);
  /* The Forecast where the months have one. */
  const sides = useMemo(() => (q.data ? views.filter((v) => v !== 'forecast' || q.data.forecast != null) : []), [q.data, views]);
  const columns = useMemo(() => sideBySideColumns(sides, from, to), [sides, from, to]);
  const lines = useMemo(() => (q.data && sides.length > 0 ? sideBySideLines(q.data, sides) : []), [q.data, sides]);
  const shown = linesVisible(lines, level, tree.open);
  const sheet = (): ReportSheet | null => (lines.length > 0 ? {
    title: 'Overall P&L',
    subtitle: `${period} · ${sides.map((v) => VIEW_COLUMN[v].label).join(', ')} side by side${showPct ? ' · % of each view’s sales beside' : ''}`,
    meta: [{ label: 'Months', value: period }],
    tables: [sheetTable('compare', columns, shown, showPct, '% of sales')],
  } : null);

  return (
    <>
      <ReportHeaderActions>
        <ReportExports sheet={sheet} fileBase={`pnl-side-by-side-${from.slice(0, 7)}-${to.slice(0, 7)}`} />
      </ReportHeaderActions>
      <ReportToolbar>
        <FinanceDateRange label="Months" />
        <LevelTool depth={monthlyDepth(lines)} level={level} onLevel={setLevel} />
        <ReportSwitch on={showPct} onChange={setShowPct}>% beside</ReportSwitch>
      </ReportToolbar>
      {!enough && <ReportMessage>Pick two or three views above to see them side by side.</ReportMessage>}
      {enough && q.isError && <ReportMessage tone="error">The views could not be read — {q.error instanceof Error ? q.error.message : String(q.error)}</ReportMessage>}
      {enough && q.isLoading && <StatementSkeleton label="Working the views out" />}
      {q.data && views.includes('forecast') && q.data.forecast == null && (
        <ReportMessage>No forecast for {period} — the Forecast P&amp;L has none for these months.</ReportMessage>
      )}
      {lines.length > 0 && (
        <StatementTable
          widthsKey="pnl-views"
          head="Account"
          columns={columns}
          lines={lines}
          shown={shown}
          level={level}
          tree={tree}
          showPct={showPct}
          finalId="net:net"
          note={NOTE}
          drillKey={`${from}|${to}|${sides.join(',')}`}
          ariaLabel="Overall P&L, views side by side"
        />
      )}
    </>
  );
};
