// ----------------------------------------------------------------------------
// MonthlyReport — a Finance report month by month (owner 2026-09-14,
// docs/bugs/0916: 能看每个月的). Columns: 累计 leftmost (the whole range in one
// figure — not on the balance sheet), then the newest month on the left and
// older months to the right; a % toggle prints every cell as its % of that
// column's base instead of the amount; L1..Ln folds the layout's levels;
// Export writes the same table as CSV. Each column is ONE request to the
// report's own endpoint for that period, so a month can never disagree with
// the single-period screen for the same month. Nothing is stored.
// Owner 2026-09-18: a cell with nothing in it prints a dash in both its slots
// (没有 amount 的不留空白); an account's lines open under its row in the month
// grid, each under its own month (那笔费用挂在那个月份的下面) — the name opens
// the whole range, a month's figure opens that month alone. Rows wear a
// dashed hairline, light up under the mouse, and the name column stays put
// while the months scroll (his pick of the two samples, style one).
// Owner 2026-09-19: a subtotal or total row wears a shade of its own, apart
// from the account rows; an opened account's lines a lighter one, cut at the
// column's width, their figures under the amount slot, never under the %.
// ----------------------------------------------------------------------------

import { Fragment, useEffect, useMemo, useState } from 'react';
import { useQueries } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { Button } from '@2990s/design-system';
import { downloadCSV } from '../../lib/csv';
import { fmtPct, foldsChildren, folderOpen, linesVisible } from '../../vendor/scm/lib/report-layout';
import {
  mergeColumns, monthColumns, monthlyCsv, monthlyDepth,
  type FlatLine, type MonthColumn, type MonthlyLine,
} from '../../vendor/scm/lib/report-monthly';
import { LevelButtons, useReportTree, type Level } from './ReportLayoutTree';
import { AccountMonthRows, pctSlotStyle } from './AccountMonthRows';
import styles from './MonthlyReport.module.css';

const soft: React.CSSProperties = { fontSize: 'var(--fs-13)', color: 'var(--text-soft, #8a8578)' };
const card: React.CSSProperties = {
  background: 'var(--c-cream)', border: '1px solid var(--c-line, rgba(34,31,32,0.12))', borderRadius: 'var(--radius-md)',
};
const num: React.CSSProperties = { textAlign: 'right', whiteSpace: 'nowrap', padding: '2px 10px', fontVariantNumeric: 'tabular-nums' };
/* The % under an amount — the same figure the % toggle prints alone. */
/* The % rides BESIDE the amount, on the same line (owner 2026-09-18: percentage 应该在 amount 旁边而不是下面). */
const pctBeside: React.CSSProperties = { ...pctSlotStyle, fontSize: 'var(--fs-11, 11px)', color: 'var(--text-soft, #8a8578)', fontWeight: 400, textAlign: 'right' };
/* A row's dress: every line row dashed and frozen; a total and a subtotal (net) shaded apart from the account rows; a block plain. */
const rowClass = (kind: MonthlyLine['kind']): string | undefined =>
  (kind === 'block' ? undefined : [styles.row, kind === 'total' ? styles.total : kind === 'net' ? styles.net : ''].join(' ').trim());
const chevron: React.CSSProperties = { background: 'none', border: 'none', padding: '0 4px 0 0', cursor: 'pointer', font: 'inherit', color: 'var(--text-soft, #8a8578)', width: 18, display: 'inline-block', textAlign: 'left' };
const nameBtn: React.CSSProperties = { background: 'none', border: 'none', padding: 0, cursor: 'pointer', font: 'inherit', color: 'inherit' };
const figureBtn: React.CSSProperties = { ...nameBtn, fontVariantNumeric: 'tabular-nums' };
/* Nothing in the cell: a dash in the amount slot and one in the % slot (owner 2026-09-18, method B). */
const DASH = '-';
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
  const tree = useReportTree(level);
  /* Which month an opened account shows: null is the whole range (the name was
     clicked), a key is that month alone (its figure was clicked). */
  const [drillMonth, setDrillMonth] = useState<Record<string, string | null>>({});
  useEffect(() => { setDrillMonth({}); }, [level]);
  const openLines = (id: string, month: string | null, drilledNow: boolean, monthNow: string | null) => {
    if (!drilledNow) { tree.toggleDrill(id); setDrillMonth((m) => ({ ...m, [id]: month })); return; }
    if (monthNow === month) { tree.toggleDrill(id); return; }
    setDrillMonth((m) => ({ ...m, [id]: month }));
  };
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
  const shown = linesVisible(lines, level, tree.open);
  /* An account's lines open for the whole range on screen. */
  const range = { from: columns.reduce((a, c) => (c.from < a ? c.from : a), columns[0]?.from ?? ''), to: columns.reduce((a, c) => (c.to > a ? c.to : a), columns[0]?.to ?? '') };

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
              {shown.map((l) => {
                const i = lines.indexOf(l);
                const folder = l.kind === 'category' && foldsChildren(lines, i);
                const open = folder && folderOpen(l, level, tree.open);
                const drillable = l.kind === 'row' && Boolean(l.code);
                const drilled = drillable && Boolean(tree.drilled[l.id]);
                return (
                  <Fragment key={l.id}>
                    <tr data-kind={l.kind} data-depth={l.depth} className={rowClass(l.kind)} style={l.kind === 'net' || l.kind === 'total' ? { borderTop: l.kind === 'net' ? '2px solid var(--c-ink, #221f20)' : '1px solid var(--border-weak, #e3e1da)' } : undefined}>
                      <td className={styles.name} style={{ padding: `2px 10px 2px ${10 + 14 * Math.max(0, l.depth)}px`, ...style(l) }}>
                        {folder && <button type="button" style={chevron} aria-label={`${open ? 'Collapse' : 'Expand'} ${l.label}`} aria-expanded={open} onClick={() => tree.toggle(l.id, open)}>{open ? '▾' : '▸'}</button>}
                        {drillable
                          ? <button type="button" style={nameBtn} aria-label={`Lines of ${l.label}`} aria-expanded={drilled} onClick={() => openLines(l.id, null, drilled, drillMonth[l.id] ?? null)}>{l.label}</button>
                          : l.label}
                      </td>
                      {columns.map((c) => {
                        const cell = l.cells[c.key];
                        const blank = !cell || l.kind === 'block';
                        const monthNow = drillMonth[l.id] ?? null;
                        const pick = c.cumulative ? null : c.key;
                        const figure = showPct ? fmtPct(cell?.pct ?? null) : fmt(cell?.amountSen ?? 0);
                        return (
                          <td key={c.key} style={{ ...num, ...style(l), ...(c.cumulative ? { borderRight: '2px solid var(--c-ink, #221f20)' } : {}) }}>
                            {blank
                              ? (l.kind === 'block' ? '' : <><span style={soft}>{DASH}</span>{!showPct && <span data-pct style={pctBeside}>{DASH}</span>}</>)
                              : (
                                <>
                                  {drillable
                                    ? <button type="button" style={figureBtn} aria-label={`Lines of ${l.label} · ${c.label}`} aria-pressed={drilled && monthNow === pick} onClick={() => openLines(l.id, pick, drilled, monthNow)}>{figure}</button>
                                    : figure}
                                  {!showPct && <span data-pct style={pctBeside}>{fmtPct(cell.pct)}</span>}
                                </>
                              )}
                          </td>
                        );
                      })}
                    </tr>
                    {drilled && l.code && (
                      <AccountMonthRows code={l.code} columns={columns} from={range.from} to={range.to} month={drillMonth[l.id] ?? null}
                        rowSen={l.cells.cumulative?.amountSen ?? Object.values(l.cells).reduce((sum, cell) => sum + (cell?.amountSen ?? 0), 0)} fmt={fmt} pctSlot={!showPct} />
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
