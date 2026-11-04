// ----------------------------------------------------------------------------
// statementTools — what the statements on the StatementTable share (the P&L,
// the Balance sheet, the Performance P&L; the owner's Claude Design, batch 6):
// one read per column, the Levels tool, the General ledger opened from a
// category's figure with Back, and the sheet the exports draw.
// ----------------------------------------------------------------------------

import { useLocation, useNavigate } from 'react-router-dom';
import { useQueries } from '@tanstack/react-query';
import { ledgerHref } from '../../../vendor/scm/lib/report-layout';
import type { FlatLine } from '../../../vendor/scm/lib/report-monthly';
import { statementColumnsTable, statementTable, type SheetTable } from '../../../vendor/scm/lib/report-sheet';
import type { Level } from '../ReportLayoutTree';
import { ReportTool, Segmented } from './reportParts';
import { MONTH_COUNTS, type StatementColumn, type StatementLine, type StatementView } from './statementColumns';

/** The columns' reads: one request per column, each the report for its period. */
export function useColumnReads<T>(columns: StatementColumn[], key: (c: StatementColumn) => unknown[], fetchOne: (c: StatementColumn) => Promise<T>) {
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

/** By month: 3 / 6 / 12 months. */
export const MONTH_OPTIONS = MONTH_COUNTS.map((n) => ({ value: n, label: String(n) }));

/** L1 … Ln + All, from the tree's own depth; nothing to choose when it is one level. */
export function LevelTool({ depth, level, onLevel }: { depth: number; level: Level; onLevel: (l: Level) => void }) {
  if (depth < 2) return null;
  const options = [...Array.from({ length: depth }, (_, i) => ({ value: (i + 1) as Level, label: `L${i + 1}` })), { value: 'all' as Level, label: 'All' }];
  return (
    <ReportTool label="Levels">
      <Segmented options={options} value={level} onChange={onLevel} label="Levels" />
    </ReportTool>
  );
}

/** Where the General ledger opens for a category's accounts — Back returns here. */
export function useOpenLedger(backLabel: string) {
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
export function sheetTable(view: StatementView, columns: StatementColumn[], shown: StatementLine[], showPct: boolean, pctTitle: string): SheetTable {
  if (view === 'single' && showPct) {
    const col = columns[0]!;
    return statementTable(shown.map((l): FlatLine => ({ ...l, amountSen: l.cells[col.key]?.amountSen ?? 0, pct: l.cells[col.key]?.pct ?? null })), pctTitle);
  }
  return statementColumnsTable(columns.map((c) => ({ key: c.key, label: c.kind === 'period' && view === 'single' ? 'Amount' : c.label, pct: c.pct && showPct, edge: c.kind === 'total' })), shown);
}
