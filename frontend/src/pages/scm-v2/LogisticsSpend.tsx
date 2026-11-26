// ----------------------------------------------------------------------------
// LogisticsSpend — the Logistics cost report's Spend by lorry view (owner
// 2026-11-25: 「我应该要的是每一辆lorry的spend，就是包括petrol，tol，等等」, after a
// repairs-only view): what each lorry costs, from the books — its petrol, toll &
// parking, repairs, HP instalment and insurance & road tax, one group per lorry,
// and Not tied to a lorry for driver pay and bills that name none. Every period
// shows two figures (「两个我都要看，每个月实际和平摊」): Actual, each line in full
// in the month it is booked, and Spread, as the P&L counts it — so the Spread
// columns add up to the P&L's Total In-house Expenses (the check and Difference
// rows). A line on one lorry's account that names another is listed under To
// check, never moved: the books decide, Finance corrects the posting.
// Server: scm/lib/lorry-spend.ts, on GET /acc-events/logistics/pnl.
// ----------------------------------------------------------------------------

import { useMemo, type ReactNode } from 'react';
import { fmtDateOrDash } from '../../vendor/shared/format';
import type { LogisticsLorrySpend, LogisticsSpendKind, LogisticsSpendLine } from '../../vendor/scm/lib/logistics-queries';
import { FinanceGrid, fmtMoney, type GridColumn, type GridRow } from './reports/FinanceGrid';
import { ReportExports, ReportHeaderActions, ReportMessage, ReportTiles, type ReportTile } from './reports/reportParts';
import { monthName } from './reports/statementColumns';
import { gridSheet, type Mode } from './logisticsColumns';
import type { ViewProps } from './LogisticsCost';
import s from './Logistics.module.css';

/** Actual: a line in full in the month it is booked. Spread: as the P&L counts it. */
export type SpendFigure = 'actual' | 'spread';
export type SpendScope = { months: string[]; figure: SpendFigure };

/** Whole range: the period's Actual and Spread. By month: Total's, then each
 *  month's. Each column names the months and the figure it adds up. */
export function spendColumns(months: readonly string[], mode: Mode): { columns: GridColumn[]; scopes: Map<string, SpendScope> } {
  const short = (m: string) => monthName(`${m}-01`);
  const all = [...months];
  const span = all.length === 0 ? '' : all.length === 1 ? short(all[0]!) : `${short(all[0]!)} – ${short(all[all.length - 1]!)}`;
  const scopes = new Map<string, SpendScope>();
  const columns: GridColumn[] = [];
  const pair = (key: string, group: string, ms: string[], total: boolean) => {
    columns.push({ key: `${key}:A`, label: 'Actual', group, kind: 'money', width: 120, total });
    scopes.set(`${key}:A`, { months: ms, figure: 'actual' });
    columns.push({ key: `${key}:S`, label: 'Spread', group, kind: 'money', width: 120, total, edge: true });
    scopes.set(`${key}:S`, { months: ms, figure: 'spread' });
  };
  if (mode === 'single') pair('T', span, all, true);
  else {
    pair('T', `Total · ${all.length} month${all.length === 1 ? '' : 's'}`, all, true);
    for (const m of all) pair(m, short(m), [m], false);
  }
  return { columns, scopes };
}

export const KIND_ORDER: readonly LogisticsSpendKind[] = ['petrol', 'upkeep', 'instalment', 'roadtax', 'other', 'manpower'];
export const KIND_LABEL: Record<LogisticsSpendKind, string> = {
  petrol: 'Petrol, toll & parking', upkeep: 'Repairs & maintenance', instalment: 'Instalment (HP)',
  roadtax: 'Insurance & road tax', other: 'Other lorry cost', manpower: 'Manpower',
};

const sumIn = (byMonth: Record<string, number>, months: readonly string[]): number => months.reduce((t, m) => t + (byMonth[m] ?? 0), 0);
/** A line's figure in a column: in full in its booked month (Actual), or as the P&L counts it (Spread). */
export const lineIn = (l: LogisticsSpendLine, sc: SpendScope): number =>
  (sc.figure === 'actual' ? (sc.months.includes(l.day.slice(0, 7)) ? l.amountSen : 0) : sumIn(l.byMonth, sc.months));
const spendIn = (e: LogisticsLorrySpend, sc: SpendScope, kind: LogisticsSpendKind | null): number =>
  e.lines.reduce((t, l) => t + (kind == null || l.kind === kind ? lineIn(l, sc) : 0), 0);
export const lorryName = (e: LogisticsLorrySpend): string => e.plate ?? 'Not tied to a lorry';
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
const wholeRm = (sen: number): string => {
  const text = Math.round(Math.abs(sen) / 100).toLocaleString('en-US');
  return sen < 0 ? `(${text})` : text;
};

export function SpendView({ p, mode, period, months }: ViewProps) {
  const lorries = useMemo(() => p.lorrySpend ?? [], [p]);
  const { columns, scopes } = useMemo(() => spendColumns(months, mode), [months, mode]);
  const single = mode === 'single';

  const rows = useMemo<GridRow[]>(() => {
    const cellsOf = (f: (sc: SpendScope) => number | null) => Object.fromEntries([...scopes].map(([k, sc]) => [k, f(sc)]));
    const whole = (figure: SpendFigure): SpendScope => ({ months, figure });
    const shown = (l: LogisticsSpendLine) => lineIn(l, whole('actual')) !== 0 || lineIn(l, whole('spread')) !== 0;
    const linesDetail = (e: LogisticsLorrySpend, kind: LogisticsSpendKind) => (key: string): ReactNode | null => {
      const sc = scopes.get(key);
      if (!sc) return null;
      const lines = e.lines.filter((l) => l.kind === kind).map((l) => ({ ...l, here: lineIn(l, sc) })).filter((l) => l.here !== 0);
      if (lines.length === 0) return null;
      const spreadNote = (l: LogisticsSpendLine) => (l.months <= 1 ? null
        : sc.figure === 'actual' ? `Spread over ${l.months} months on the P&L` : `RM ${fmtMoney(l.amountSen)} over ${l.months} months`);
      return (
        <table className={s.detailTable}>
          <thead><tr><th>Date</th><th>Document</th><th>Description</th><th className={s.num}>{sc.figure === 'actual' ? 'Actual' : 'Spread'}</th><th>Note</th></tr></thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.lineId}>
                <td>{fmtDateOrDash(l.day)}</td>
                <td>{l.docNo ?? '-'}</td>
                <td>{l.notes ?? ''}</td>
                <td className={s.num}>{fmtMoney(l.here)}</td>
                <td>{[spreadNote(l), l.otherPlate ? `Says ${l.otherPlate}` : null].filter(Boolean).join(' · ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      );
    };
    const groups: GridRow[] = lorries.map((e) => {
      const id = `lorry:${e.plate ?? 'none'}`;
      const label = lorryName(e);
      const cells = cellsOf((sc) => spendIn(e, sc, null));
      const kids: GridRow[] = KIND_ORDER.filter((k) => e.lines.some((l) => l.kind === k)).map((k) => ({
        id: `${id}:${k}`, label: KIND_LABEL[k],
        cap: single ? plural(e.lines.filter((l) => l.kind === k && shown(l)).length, 'line') : null,
        cells: cellsOf((sc) => spendIn(e, sc, k)), detail: linesDetail(e, k),
      }));
      const cap = e.plate == null ? 'driver pay and bills that name no lorry' : e.ours ? null : 'not in the lorry list';
      if (kids.length === 0) return { id, label, cap: single ? 'nothing in the books' : null, cells };
      return { id, label, cap, kind: 'group', totalLabel: `Total ${label}`, kids, cells };
    });
    const total = cellsOf((sc) => lorries.reduce((t, e) => t + spendIn(e, sc, null), 0));
    const inHouseOf = (m: string) => p.perMonth.find((x) => x.month === m)?.rows.find((r) => r.key === 'inhouse_total')?.totalSen ?? 0;
    const books = cellsOf((sc) => (sc.figure === 'spread' ? sc.months.reduce((t, m) => t + inHouseOf(m), 0) : null));
    const diff = Object.fromEntries(Object.keys(total).map((k) => [k, books[k] == null ? null : (total[k] ?? 0) - books[k]!]));
    const off = Object.values(diff).some((v) => v != null && v !== 0);
    return [
      ...groups,
      { id: 'total', label: 'Total in-house spend', kind: 'final', cells: total },
      { id: 'check', label: 'Logistics P&L · Total In-house Expenses (from the books)', kind: 'check', cells: books },
      { id: 'diff', label: 'Difference (Spread less the P&L)', kind: off ? 'bad' : 'check', zeroShows: true, cells: diff },
    ];
  }, [p, lorries, scopes, months, single]);

  if (!p.lorrySpend) return <ReportMessage>Spend by lorry is not on the server yet. Refresh in a minute.</ReportMessage>;
  if (lorries.length === 0) return <ReportMessage>No lorry cost is in the books for {period}.</ReportMessage>;

  const actual: SpendScope = { months, figure: 'actual' };
  const spread: SpendScope = { months, figure: 'spread' };
  const actualT = lorries.reduce((t, e) => t + spendIn(e, actual, null), 0);
  const spreadT = lorries.reduce((t, e) => t + spendIn(e, spread, null), 0);
  const booked = lorries.reduce((t, e) => t + e.lines.filter((l) => lineIn(l, actual) !== 0).length, 0);
  const plated = lorries.filter((e) => e.plate != null);
  const top = [...plated].sort((a, b) => spendIn(b, actual, null) - spendIn(a, actual, null)).at(0);
  const topSen = top ? spendIn(top, actual, null) : 0;
  const ours = lorries.filter((e) => e.ours);
  const flagged = lorries.flatMap((e) => e.lines.filter((l) => l.otherPlate && (lineIn(l, actual) !== 0 || lineIn(l, spread) !== 0)).map((l) => ({ e, l })));
  const tiles: ReportTile[] = [
    { key: 'actual', label: 'Actual', value: wholeRm(actualT), sub: `${plural(booked, 'line')} booked in these months` },
    { key: 'spread', label: 'Spread', value: wholeRm(spreadT), sub: 'as the P&L: Total In-house Expenses' },
    { key: 'top', label: 'Most spent (actual)', value: top && topSen > 0 ? lorryName(top) : '—', sub: top && topSen > 0 ? `RM ${wholeRm(topSen)}` : 'no line' },
    {
      key: 'avg', label: 'Per lorry (actual)', value: ours.length > 0 ? wholeRm(ours.reduce((t, e) => t + spendIn(e, actual, null), 0) / ours.length) : '—',
      sub: `${ours.length} of our lorries`,
    },
    {
      key: 'check', label: 'To check', value: String(flagged.length), tone: flagged.length > 0 ? 'late' : 'plain',
      sub: flagged.length > 0 ? `RM ${wholeRm(flagged.reduce((t, x) => t + x.l.amountSen, 0))} names another lorry` : 'none',
    },
  ];
  const sheet = () => gridSheet({ title: 'Logistics cost · spend by lorry', subtitle: `${period} · RM`, period, nameLabel: 'Lorry', columns, rows, showPct: false });

  return (
    <>
      <ReportHeaderActions><ReportExports sheet={sheet} fileBase={`logistics-spend-by-lorry-${months[0] ?? ''}-${months.at(-1) ?? ''}`} /></ReportHeaderActions>
      <ReportTiles tiles={tiles} label="Spend by lorry totals" />
      {flagged.length > 0 && (
        <section className={s.notCounted} aria-label="To check">
          <h3 className={s.notCountedTitle}>To check</h3>
          <ul>
            {flagged.map(({ e, l }) => (
              <li key={l.lineId}>
                {`${l.docNo ?? 'A line'} of ${fmtDateOrDash(l.day)}, RM ${fmtMoney(l.amountSen)} (${KIND_LABEL[l.kind].toLowerCase()}): the description says ${l.otherPlate}, but it is booked to ${lorryName(e)} (${l.accountCode}). If the description is right, Finance moves it to ${l.otherPlate}'s account.`}
              </li>
            ))}
          </ul>
        </section>
      )}
      <FinanceGrid layoutKey={`logistics-lorry-spend|${mode}`} nameColumn={{ label: 'Lorry', width: 300 }} columns={columns} rows={rows}
        title="Logistics cost · spend by lorry" subtitle={`${period} · RM`} ariaLabel="Spend by lorry" drillKey={`${months.join()}|${mode}`}
        foot={<span>From the books: each lorry&rsquo;s lines by the lorry its account names, else its description; driver pay and bills that name no lorry are Not tied. Actual: each line in full in the month it is booked. Spread: as the P&amp;L counts it (repairs and insurance over the months Finance gives them), so the Spread columns add up to the P&amp;L&rsquo;s Total In-house Expenses. A figure opens its lines.</span>} />
    </>
  );
}
