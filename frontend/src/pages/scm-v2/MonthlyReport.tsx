// ----------------------------------------------------------------------------
// MonthlyReport — a Finance report month by month (owner 2026-09-14,
// docs/bugs/0916: 能看每个月的). Columns: 累计 leftmost (the whole range in one
// figure — not on the balance sheet), then the newest month on the left and
// older months to the right; a % toggle prints every cell as its % of that
// column's base instead of the amount; L1..Ln folds the layout's levels;
// Export writes the same table as CSV. Each column is ONE request to the
// report's own endpoint for that period, so a month can never disagree with
// the single-period screen for the same month. Nothing is stored.
// ----------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import { useQueries } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { Button } from '@2990s/design-system';
import { downloadCSV } from '../../lib/csv';
import { fmtPct } from '../../vendor/scm/lib/report-layout';
import {
  mergeColumns, monthColumns, monthlyCsv, monthlyDepth, monthlyLinesAtLevel,
  type FlatLine, type MonthColumn, type MonthlyLine,
} from '../../vendor/scm/lib/report-monthly';
import { LevelButtons, type Level } from './ReportLayoutTree';

const soft: React.CSSProperties = { fontSize: 'var(--fs-13)', color: 'var(--text-soft, #8a8578)' };
const card: React.CSSProperties = {
  background: 'var(--c-cream)', border: '1px solid var(--c-line, rgba(34,31,32,0.12))', borderRadius: 'var(--radius-md)',
};
const num: React.CSSProperties = { textAlign: 'right', whiteSpace: 'nowrap', padding: '2px 10px', fontVariantNumeric: 'tabular-nums' };
const btn = (active: boolean): React.CSSProperties => ({
  padding: '2px 8px', fontSize: 'var(--fs-12, 12px)', borderRadius: 'var(--radius-sm, 4px)',
  border: '1px solid var(--c-line, rgba(34,31,32,0.2))', background: active ? 'var(--c-ink, #221f20)' : 'transparent',
  color: active ? 'var(--c-cream, #fff)' : 'inherit', cursor: 'pointer',
});

const myt = (): string => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 7);

export type MonthlyProps<T> = {
  /** Names the query and the CSV file. */
  report: string;
  title: string;
  /** The balance sheet has no cumulative column: a month IS a balance. */
  withCumulative: boolean;
  /** One request per column — the report's own endpoint for that period. */
  fetchColumn: (col: MonthColumn) => Promise<T>;
  /** The report as the lines the single-period screen prints. */
  linesOf: (data: T) => FlatLine[];
  fmt: (sen: number) => string;
  pctTitle: string;
  /** Extra query-key parts (the R&P's accounts and party toggle). */
  keyParts?: string[];
};

const COUNTS = [3, 6, 12] as const;

/** The By month / single period switch every report page wears. */
export const ByMonthButton = ({ on, onToggle }: { on: boolean; onToggle: () => void }) => (
  <Button variant={on ? 'secondary' : 'ghost'} size="sm" onClick={onToggle} aria-pressed={on}>By month</Button>
);

export function MonthlyReport<T>({ report, title, withCumulative, fetchColumn, linesOf, fmt, pctTitle, keyParts = [] }: MonthlyProps<T>) {
  const [latest, setLatest] = useState(myt());
  const [count, setCount] = useState<number>(6);
  const [showPct, setShowPct] = useState(false);
  const [level, setLevel] = useState<Level>('all');
  const columns = useMemo(() => monthColumns(latest, count, withCumulative), [latest, count, withCumulative]);

  const results = useQueries({
    queries: columns.map((col) => ({
      queryKey: ['report-monthly', report, col.key === 'cumulative' ? `${col.from}..${col.to}` : col.key, ...keyParts],
      queryFn: () => fetchColumn(col),
      staleTime: 30_000,
    })),
  });
  const loading = results.some((r) => r.isLoading);
  const failed = results.filter((r) => r.isError).length;
  const lines: MonthlyLine[] = useMemo(() => mergeColumns(
    columns.flatMap((col, i) => {
      const data = results[i]?.data as T | undefined;
      return data ? [{ key: col.key, lines: linesOf(data) }] : [];
    }),
  ), [columns, results, linesOf]);
  const depth = monthlyDepth(lines);
  const shown = monthlyLinesAtLevel(lines, level);

  const style = (l: MonthlyLine): React.CSSProperties =>
    l.kind === 'block' ? { fontWeight: 700, paddingTop: 10 }
      : l.kind === 'net' ? { fontWeight: 700, borderTop: '2px solid var(--c-ink, #221f20)' }
        : l.kind === 'total' ? { fontWeight: 600, borderTop: '1px solid var(--border-weak, #e3e1da)' }
          : l.kind === 'category' ? { fontWeight: 600 }
            : l.kind === 'unassigned' ? { fontStyle: 'italic', ...soft } : {};

  return (
    <div className="space-y-3">
      <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={soft}>Latest month</span>
        <input type="month" value={latest} onChange={(e) => { if (e.target.value) setLatest(e.target.value); }} aria-label="Latest month"
          style={{ fontSize: 'var(--fs-13)', padding: '2px 6px' }} />
        <span role="group" aria-label="Months" style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
          <span style={soft}>Months</span>
          {COUNTS.map((n) => <button key={n} type="button" aria-pressed={count === n} style={btn(count === n)} onClick={() => setCount(n)}>{n}</button>)}
        </span>
        <span role="group" aria-label="Amounts or percentages" style={{ display: 'inline-flex', gap: 4 }}>
          <button type="button" aria-pressed={!showPct} style={btn(!showPct)} onClick={() => setShowPct(false)}>RM</button>
          <button type="button" aria-pressed={showPct} style={btn(showPct)} onClick={() => setShowPct(true)}>%</button>
        </span>
        <LevelButtons depth={depth} level={level} onLevel={setLevel} />
        <span style={{ flex: 1 }} />
        <Button variant="ghost" size="sm" disabled={lines.length === 0}
          onClick={() => downloadCSV(`${report}-monthly-${columns[columns.length - 1]?.key ?? ''}-${latest}.csv`, monthlyCsv(title, columns, shown, showPct, fmt, fmtPct))}>
          <Download size={16} strokeWidth={1.75} /> Export
        </Button>
      </div>
      {loading && <div style={soft}>Working the months out…</div>}
      {failed > 0 && <div style={{ fontSize: 'var(--fs-13)', color: 'var(--c-danger, #a33)' }}>{failed} column(s) did not load — pick the month again to retry.</div>}
      {lines.length > 0 && (
        <div style={{ ...card, padding: 0, overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', fontSize: 'var(--fs-13)', minWidth: '100%' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border-weak, #e3e1da)' }}>
                <th style={{ padding: '6px 10px', textAlign: 'left', position: 'sticky', left: 0, background: 'var(--c-cream)', ...soft }}>{title}{showPct ? ` · ${pctTitle}` : ''}</th>
                {columns.map((c) => (
                  <th key={c.key} data-column={c.key} style={{ padding: '6px 10px', textAlign: 'right', whiteSpace: 'nowrap', ...soft, ...(c.cumulative ? { fontWeight: 700, borderRight: '2px solid var(--c-ink, #221f20)' } : {}) }}>{c.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map((l) => (
                <tr key={l.id} data-kind={l.kind} data-depth={l.depth} style={l.kind === 'net' || l.kind === 'total' ? { borderTop: l.kind === 'net' ? '2px solid var(--c-ink, #221f20)' : '1px solid var(--border-weak, #e3e1da)' } : undefined}>
                  <td style={{ padding: `2px 10px 2px ${10 + 14 * Math.max(0, l.depth)}px`, position: 'sticky', left: 0, background: 'var(--c-cream)', whiteSpace: 'nowrap', ...style(l) }}>{l.label}</td>
                  {columns.map((c) => {
                    const cell = l.cells[c.key];
                    const text = !cell || l.kind === 'block' ? '' : showPct ? fmtPct(cell.pct) : fmt(cell.amountSen);
                    return <td key={c.key} style={{ ...num, ...style(l), ...(c.cumulative ? { borderRight: '2px solid var(--c-ink, #221f20)' } : {}) }}>{text || (l.kind === 'block' ? '' : <span style={soft}>—</span>)}</td>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
