// ----------------------------------------------------------------------------
// LogisticsSpend — the Logistics cost report's Spend by lorry view (owner
// 2026-11-25: 「我应该要的是每一辆lorry的spend，就是包括petrol，tol，等等」, after a
// repairs-only view): what each lorry costs, from the books — its petrol, toll &
// parking, repairs, HP instalment and insurance & road tax.
// The columns are months, and every lorry sits inside its month (2026-11-28:
// 「它应该是一个月份，然后有多少 lorry 就在里面，一个月一个月从左到右，最新的月份最靠左」):
// newest month first, each with one column per lorry, Not tied to a lorry
// (driver pay, bills that name none) and the month's Total; By month ends on
// the whole range's Total, Whole range is one block. The costs run down, and
// every lorry has its HP instalment line (「还需要包括 installment 的费用」).
// Repairs and insurance show twice (「两个我都要看，每个月实际和平摊」): actual, each
// bill in full in the month it is booked, and spread, as the P&L counts it —
// the other costs are never spread, so one line each. Total spend (spread)
// adds up to the P&L's Total In-house Expenses (the check and Difference rows,
// in each Total column). A line on one lorry's account that names another is
// listed under To check, never moved: the books decide, Finance re-posts.
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
/** The months a column block adds up: one month, or the whole range. */
export type SpendPeriod = { key: string; label: string; months: string[] };

const ALL = 'all';
export const lorryName = (e: LogisticsLorrySpend): string => e.plate ?? 'Not tied to a lorry';
const lorryKey = (e: LogisticsLorrySpend): string => e.plate ?? 'none';
const headName = (e: LogisticsLorrySpend): string => e.plate ?? 'Not tied';

/** Whole range: one block. By month: newest month first, then the range's Total when it spans months. */
export function spendPeriods(months: readonly string[], mode: Mode): SpendPeriod[] {
  const short = (m: string) => monthName(`${m}-01`);
  const all = [...months];
  const count = `${all.length} month${all.length === 1 ? '' : 's'}`;
  if (mode === 'single') {
    const span = all.length === 0 ? '' : all.length === 1 ? short(all[0]!) : `${short(all[0]!)} – ${short(all[all.length - 1]!)}`;
    return [{ key: ALL, label: span, months: all }];
  }
  const each = [...all].reverse().map((m) => ({ key: m, label: short(m), months: [m] }));
  return all.length > 1 ? [...each, { key: ALL, label: `Total · ${count}`, months: all }] : each;
}

/** Each block: a column per lorry, then its Total. */
export function spendColumns(periods: readonly SpendPeriod[], lorries: readonly LogisticsLorrySpend[]): GridColumn[] {
  return periods.flatMap((pd) => [
    ...lorries.map((e): GridColumn => ({ key: `${pd.key}|${lorryKey(e)}`, label: headName(e), group: pd.label, kind: 'money', width: 98 })),
    { key: `${pd.key}|${ALL}`, label: 'Total', group: pd.label, kind: 'money', width: 108, total: true, edge: true },
  ]);
}

export const KIND_ORDER: readonly LogisticsSpendKind[] = ['petrol', 'upkeep', 'instalment', 'roadtax', 'other', 'manpower'];
export const KIND_LABEL: Record<LogisticsSpendKind, string> = {
  petrol: 'Petrol, toll & parking', upkeep: 'Repairs & maintenance', instalment: 'Instalment (HP)',
  roadtax: 'Insurance & road tax', other: 'Other lorry cost', manpower: 'Manpower',
};
const SHOWN_FOR_EVERY_LORRY: ReadonlySet<LogisticsSpendKind> = new Set<LogisticsSpendKind>(['petrol', 'upkeep', 'instalment', 'roadtax']);
const SPREAD_BY_THE_PNL: ReadonlySet<LogisticsSpendKind> = new Set<LogisticsSpendKind>(['upkeep', 'roadtax']);

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

type Line = { id: string; label: string; kind: LogisticsSpendKind | null; figure: SpendFigure; final?: boolean };

export function SpendView({ p, mode, period, months }: ViewProps) {
  const lorries = useMemo(() => p.lorrySpend ?? [], [p]);
  const periods = useMemo(() => spendPeriods(months, mode), [months, mode]);
  const columns = useMemo(() => spendColumns(periods, lorries), [periods, lorries]);

  const rows = useMemo<GridRow[]>(() => {
    const kinds = KIND_ORDER.filter((k) => SHOWN_FOR_EVERY_LORRY.has(k) || lorries.some((e) => e.lines.some((l) => l.kind === k)));
    const lines: Line[] = [
      ...kinds.flatMap((k): Line[] => (SPREAD_BY_THE_PNL.has(k)
        ? [{ id: `${k}:A`, label: `${KIND_LABEL[k]} (actual)`, kind: k, figure: 'actual' }, { id: `${k}:S`, label: `${KIND_LABEL[k]} (spread)`, kind: k, figure: 'spread' }]
        : [{ id: k, label: KIND_LABEL[k], kind: k, figure: 'actual' }])),
      { id: 'total:A', label: 'Total spend (actual)', kind: null, figure: 'actual', final: true },
      { id: 'total:S', label: 'Total spend (spread)', kind: null, figure: 'spread', final: true },
    ];
    const cellsOf = (ln: Line): Record<string, number> => {
      const out: Record<string, number> = {};
      for (const pd of periods) {
        const sc: SpendScope = { months: pd.months, figure: ln.figure };
        let all = 0;
        for (const e of lorries) {
          const v = spendIn(e, sc, ln.kind);
          out[`${pd.key}|${lorryKey(e)}`] = v;
          all += v;
        }
        out[`${pd.key}|${ALL}`] = all;
      }
      return out;
    };
    const linesDetail = (ln: Line) => (key: string): ReactNode | null => {
      if (ln.kind == null) return null;
      const at = key.indexOf('|');
      const pd = at < 0 ? undefined : periods.find((x) => x.key === key.slice(0, at));
      if (!pd) return null;
      const who = key.slice(at + 1);
      const whose = who === ALL ? lorries : lorries.filter((e) => lorryKey(e) === who);
      const sc: SpendScope = { months: pd.months, figure: ln.figure };
      const shown = whose
        .flatMap((e) => e.lines.filter((l) => l.kind === ln.kind).map((l) => ({ ...l, lorry: lorryName(e), here: lineIn(l, sc) })))
        .filter((l) => l.here !== 0)
        .sort((x, y) => x.day.localeCompare(y.day) || x.lineId.localeCompare(y.lineId));
      if (shown.length === 0) return null;
      const spreadNote = (l: LogisticsSpendLine) => (l.months <= 1 ? null
        : sc.figure === 'actual' ? `Spread over ${l.months} months on the P&L` : `RM ${fmtMoney(l.amountSen)} over ${l.months} months`);
      return (
        <table className={s.detailTable}>
          <thead>
            <tr>
              <th>Date</th>{who === ALL && <th>Lorry</th>}<th>Document</th><th>Description</th>
              <th className={s.num}>{sc.figure === 'actual' ? 'Actual' : 'Spread'}</th><th>Note</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((l) => (
              <tr key={l.lineId}>
                <td>{fmtDateOrDash(l.day)}</td>
                {who === ALL && <td>{l.lorry}</td>}
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
    const spreadTotals = cellsOf({ id: 'total:S', label: '', kind: null, figure: 'spread' });
    const books: Record<string, number> = {};
    const diff: Record<string, number> = {};
    for (const pd of periods) {
      const key = `${pd.key}|${ALL}`;
      const sen = pd.months.reduce((t, m) => t + inHouseOf(m), 0);
      books[key] = sen;
      diff[key] = (spreadTotals[key] ?? 0) - sen;
    }
    const off = Object.values(diff).some((v) => v !== 0);
    return [
      ...lines.map((ln): GridRow => ({
        id: ln.id, label: ln.label, kind: ln.final ? 'final' : undefined, cells: cellsOf(ln), detail: linesDetail(ln),
      })),
      { id: 'check', label: 'P&L Total In-house Expenses', kind: 'check', cells: books },
      { id: 'diff', label: 'Difference (spread less the P&L)', kind: off ? 'bad' : 'check', zeroShows: true, cells: diff },
    ];
  }, [p, lorries, periods]);

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
      <FinanceGrid layoutKey={`logistics-lorry-months|${mode}`} nameColumn={{ label: 'Cost', width: 250 }} columns={columns} rows={rows}
        title="Logistics cost · spend by lorry" subtitle={`${period} · RM`} ariaLabel="Spend by lorry" drillKey={`${months.join()}|${mode}`}
        foot={<span>From the books, a block per month (newest first) with a column per lorry: each line goes to the lorry its account names, else its description; driver pay and bills that name no lorry are Not tied. Repairs and insurance show actual (each bill in full in the month it is booked) and spread (as the P&amp;L counts it, over the months Finance gives them); the other costs are never spread. Total spend (spread) adds up to the P&amp;L&rsquo;s Total In-house Expenses. Instalment (HP) is what was paid on each lorry&rsquo;s HP account. A figure opens its lines.</span>} />
    </>
  );
}
