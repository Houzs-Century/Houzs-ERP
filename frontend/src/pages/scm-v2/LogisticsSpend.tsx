// ----------------------------------------------------------------------------
// LogisticsSpend — the Logistics cost report's Spend by lorry view (owner
// 2026-11-25: 「我应该要的是每一辆lorry的spend，就是包括petrol，tol，等等」, after a
// repairs-only view): what each lorry costs, from the books — its petrol, toll &
// parking, repairs, HP instalment and insurance & road tax. The lorries run
// across the top, one pair of columns each (2026-11-28: 「一列 Lori、一列 Lori
// 这样从左到右，不是往下」), then Not tied to a lorry (driver pay, bills that name
// none), then Total; the costs run down, and every lorry has its HP instalment
// line (「还需要包括 installment 的费用，就是一辆lorry每个月的 HP installment」),
// a dash in a month nothing was paid. Each lorry shows two figures
// (「两个我都要看，每个月实际和平摊」): Actual, each line in full in the month it is
// booked, and Spread, as the P&L counts it — so Total's Spread adds up to the
// P&L's Total In-house Expenses (the check and Difference rows). By month: the
// whole range first, then a block per month. A line on one lorry's account that
// names another is listed under To check, never moved: the books decide, Finance
// corrects the posting.
// Server: scm/lib/lorry-spend.ts, on GET /acc-events/logistics/pnl.
// ----------------------------------------------------------------------------

import { useMemo, type ReactNode } from 'react';
import { fmtDateOrDash } from '../../../../shared/src/vendor/shared/format';
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
/** The months a block of rows adds up: the whole range, or one month. */
export type SpendPeriod = { key: string; label: string; totalLabel: string; months: string[] };

const TOTAL = 'all';
const FIGURES: ReadonlyArray<{ suffix: 'A' | 'S'; figure: SpendFigure; label: string }> = [
  { suffix: 'A', figure: 'actual', label: 'Actual' },
  { suffix: 'S', figure: 'spread', label: 'Spread' },
];
const SPREAD_TOTAL = `${TOTAL}:S`;

export const lorryName = (e: LogisticsLorrySpend): string => e.plate ?? 'Not tied to a lorry';
const lorryKey = (e: LogisticsLorrySpend): string => e.plate ?? 'none';

/** Each lorry across the top, its Actual and Spread side by side, then Total's. */
export function spendColumns(lorries: readonly LogisticsLorrySpend[]): GridColumn[] {
  const pair = (key: string, group: string, total: boolean): GridColumn[] => FIGURES.map((f, i) => ({
    key: `${key}:${f.suffix}`, label: f.label, group, kind: 'money', width: 104, total, edge: i === FIGURES.length - 1,
  }));
  return [...lorries.flatMap((e) => pair(lorryKey(e), lorryName(e), false)), ...pair(TOTAL, 'Total', true)];
}

/** Whole range: one block. By month: the whole range first, then each month. */
export function spendPeriods(months: readonly string[], mode: Mode): SpendPeriod[] {
  const short = (m: string) => monthName(`${m}-01`);
  const all = [...months];
  const count = `${all.length} month${all.length === 1 ? '' : 's'}`;
  if (mode === 'single') {
    const span = all.length === 0 ? '' : all.length === 1 ? short(all[0]!) : `${short(all[0]!)} – ${short(all[all.length - 1]!)}`;
    return [{ key: TOTAL, label: span, totalLabel: 'Total in-house spend', months: all }];
  }
  return [
    { key: TOTAL, label: `Total · ${count}`, totalLabel: `Total in-house spend · ${count}`, months: all },
    ...all.map((m) => ({ key: m, label: short(m), totalLabel: `Total in-house spend · ${short(m)}`, months: [m] })),
  ];
}

function columnOf(key: string, lorries: readonly LogisticsLorrySpend[]): { who: LogisticsLorrySpend[]; figure: SpendFigure; total: boolean } | null {
  const at = key.lastIndexOf(':');
  const fig = FIGURES.find((f) => f.suffix === key.slice(at + 1));
  if (at < 0 || !fig) return null;
  const who = key.slice(0, at);
  if (who === TOTAL) return { who: [...lorries], figure: fig.figure, total: true };
  const e = lorries.find((x) => lorryKey(x) === who);
  return e ? { who: [e], figure: fig.figure, total: false } : null;
}

export const KIND_ORDER: readonly LogisticsSpendKind[] = ['petrol', 'upkeep', 'instalment', 'roadtax', 'other', 'manpower'];
export const KIND_LABEL: Record<LogisticsSpendKind, string> = {
  petrol: 'Petrol, toll & parking', upkeep: 'Repairs & maintenance', instalment: 'Instalment (HP)',
  roadtax: 'Insurance & road tax', other: 'Other lorry cost', manpower: 'Manpower',
};
const SHOWN_FOR_EVERY_LORRY: ReadonlySet<LogisticsSpendKind> = new Set<LogisticsSpendKind>(['petrol', 'upkeep', 'instalment', 'roadtax']);

const sumIn = (byMonth: Record<string, number>, months: readonly string[]): number => months.reduce((t, m) => t + (byMonth[m] ?? 0), 0);
/** A line's figure in a column: in full in its booked month (Actual), or as the P&L counts it (Spread). */
export const lineIn = (l: LogisticsSpendLine, sc: SpendScope): number =>
  (sc.figure === 'actual' ? (sc.months.includes(l.day.slice(0, 7)) ? l.amountSen : 0) : sumIn(l.byMonth, sc.months));
const spendIn = (e: LogisticsLorrySpend, sc: SpendScope, kind: LogisticsSpendKind | null): number =>
  e.lines.reduce((t, l) => t + (kind == null || l.kind === kind ? lineIn(l, sc) : 0), 0);
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
const wholeRm = (sen: number): string => {
  const text = Math.round(Math.abs(sen) / 100).toLocaleString('en-US');
  return sen < 0 ? `(${text})` : text;
};

export function SpendView({ p, mode, period, months }: ViewProps) {
  const lorries = useMemo(() => p.lorrySpend ?? [], [p]);
  const columns = useMemo(() => spendColumns(lorries), [lorries]);
  const periods = useMemo(() => spendPeriods(months, mode), [months, mode]);
  const single = mode === 'single';

  const rows = useMemo<GridRow[]>(() => {
    const kinds = KIND_ORDER.filter((k) => SHOWN_FOR_EVERY_LORRY.has(k) || lorries.some((e) => e.lines.some((l) => l.kind === k)));
    const cellsOf = (f: (e: LogisticsLorrySpend, figure: SpendFigure) => number): Record<string, number> => {
      const out: Record<string, number> = {};
      for (const fig of FIGURES) {
        let all = 0;
        for (const e of lorries) {
          const v = f(e, fig.figure);
          out[`${lorryKey(e)}:${fig.suffix}`] = v;
          all += v;
        }
        out[`${TOTAL}:${fig.suffix}`] = all;
      }
      return out;
    };
    const linesDetail = (pd: SpendPeriod, kind: LogisticsSpendKind) => (key: string): ReactNode | null => {
      const col = columnOf(key, lorries);
      if (!col) return null;
      const sc: SpendScope = { months: pd.months, figure: col.figure };
      const lines = col.who
        .flatMap((e) => e.lines.filter((l) => l.kind === kind).map((l) => ({ ...l, lorry: lorryName(e), here: lineIn(l, sc) })))
        .filter((l) => l.here !== 0)
        .sort((x, y) => x.day.localeCompare(y.day) || x.lineId.localeCompare(y.lineId));
      if (lines.length === 0) return null;
      const spreadNote = (l: LogisticsSpendLine) => (l.months <= 1 ? null
        : sc.figure === 'actual' ? `Spread over ${l.months} months on the P&L` : `RM ${fmtMoney(l.amountSen)} over ${l.months} months`);
      return (
        <table className={s.detailTable}>
          <thead>
            <tr>
              <th>Date</th>{col.total && <th>Lorry</th>}<th>Document</th><th>Description</th>
              <th className={s.num}>{sc.figure === 'actual' ? 'Actual' : 'Spread'}</th><th>Note</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.lineId}>
                <td>{fmtDateOrDash(l.day)}</td>
                {col.total && <td>{l.lorry}</td>}
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
    const inHouseOf = (m: string) => p.perMonth.find((x) => x.month === m)?.rows.find((r) => r.key === 'inhouse_total')?.totalSen ?? 0;

    const block = (pd: SpendPeriod) => {
      const scope = (figure: SpendFigure): SpendScope => ({ months: pd.months, figure });
      const linesOf = (k: LogisticsSpendKind) => lorries.reduce((t, e) => t + e.lines
        .filter((l) => l.kind === k && (lineIn(l, scope('actual')) !== 0 || lineIn(l, scope('spread')) !== 0)).length, 0);
      const kindRows: GridRow[] = kinds.map((k) => {
        const n = single ? linesOf(k) : 0;
        return {
          id: `${pd.key}:${k}`, label: KIND_LABEL[k], cap: n > 0 ? plural(n, 'line') : null,
          cells: cellsOf((e, figure) => spendIn(e, scope(figure), k)), detail: linesDetail(pd, k),
        };
      });
      const totals = cellsOf((e, figure) => spendIn(e, scope(figure), null));
      const books = pd.months.reduce((t, m) => t + inHouseOf(m), 0);
      const diff = (totals[SPREAD_TOTAL] ?? 0) - books;
      const cap = single ? null : pd.label;
      const checks: GridRow[] = [
        { id: `${pd.key}:check`, label: 'P&L Total In-house Expenses', cap, kind: 'check', cells: { [SPREAD_TOTAL]: books } },
        { id: `${pd.key}:diff`, label: 'Difference (Spread less the P&L)', cap, kind: diff !== 0 ? 'bad' : 'check', zeroShows: true, cells: { [SPREAD_TOTAL]: diff } },
      ];
      return { kindRows, totals, checks };
    };

    if (single) {
      const pd = periods[0]!;
      const b = block(pd);
      return [...b.kindRows, { id: 'total', label: pd.totalLabel, kind: 'final', cells: b.totals }, ...b.checks];
    }
    return periods.flatMap((pd) => {
      const b = block(pd);
      return [{ id: `period:${pd.key}`, label: pd.label, totalLabel: pd.totalLabel, kids: b.kindRows, cells: b.totals }, ...b.checks];
    });
  }, [p, lorries, periods, single]);

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
  const sheet = () => gridSheet({ title: 'Logistics cost · spend by lorry', subtitle: `${period} · RM`, period, nameLabel: 'Cost', columns, rows, showPct: false });

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
      <FinanceGrid layoutKey={`logistics-lorry-columns|${mode}`} nameColumn={{ label: 'Cost', width: 260 }} columns={columns} rows={rows}
        title="Logistics cost · spend by lorry" subtitle={`${period} · RM`} ariaLabel="Spend by lorry" drillKey={`${months.join()}|${mode}`}
        foot={<span>From the books, one pair of columns per lorry: each line goes to the lorry its account names, else its description; driver pay and bills that name no lorry are Not tied. Actual: each line in full in the month it is booked. Spread: as the P&amp;L counts it (repairs and insurance over the months Finance gives them), so Total&rsquo;s Spread adds up to the P&amp;L&rsquo;s Total In-house Expenses. Instalment (HP) is what was paid on each lorry&rsquo;s HP account. A figure opens its lines.</span>} />
    </>
  );
}
