// ----------------------------------------------------------------------------
// LogisticsRepairs — the Logistics cost tab's Repairs by lorry view (owner
// 2026-11-25: 「我要看到的就是每辆lorry的维修成本，做成一个报表」): each lorry's
// repair & maintenance cost from the books, one line per lorry, its figure
// opening its bills. Every period shows two figures (owner, same day: 「两个我都
// 要看，每个月实际和平摊」): Actual, each bill in full in the month it is booked,
// and Spread, each bill over the months Finance gives it on the P&L — so the
// Spread columns add up to the P&L's Upkeep Cost (the check and Difference rows).
// A bill whose description names another lorry is listed under To check, never
// moved: the books decide, Finance corrects the posting.
// Server: scm/lib/lorry-upkeep.ts, on GET /acc-events/logistics/pnl.
// ----------------------------------------------------------------------------

import { useMemo, type ReactNode } from 'react';
import { fmtDateOrDash } from '../../vendor/shared/format';
import type { LogisticsUpkeepBill, LogisticsUpkeepLorry } from '../../vendor/scm/lib/logistics-queries';
import { FinanceGrid, fmtMoney, type GridColumn, type GridRow } from './reports/FinanceGrid';
import { ReportExports, ReportHeaderActions, ReportMessage, ReportTiles, type ReportTile } from './reports/reportParts';
import { monthName } from './reports/statementColumns';
import { gridSheet, type Mode } from './logisticsColumns';
import type { ViewProps } from './LogisticsCost';
import s from './Logistics.module.css';

/** Actual: a bill in full in the month it is booked. Spread: its parts in the
 *  months the P&L spreads it over. */
export type RepairKind = 'actual' | 'spread';
export type RepairScope = { months: string[]; kind: RepairKind };

/** Single month: the period's Actual and Spread. By month: Total's, then each
 *  month's. Each column names the months and the kind it adds up. */
export function repairColumns(months: readonly string[], mode: Mode): { columns: GridColumn[]; scopes: Map<string, RepairScope> } {
  const short = (m: string) => monthName(`${m}-01`);
  const all = [...months];
  const span = all.length === 0 ? '' : all.length === 1 ? short(all[0]!) : `${short(all[0]!)} – ${short(all[all.length - 1]!)}`;
  const scopes = new Map<string, RepairScope>();
  const columns: GridColumn[] = [];
  const pair = (key: string, group: string, ms: string[], total: boolean) => {
    columns.push({ key: `${key}:A`, label: 'Actual', group, kind: 'money', width: 120, total });
    scopes.set(`${key}:A`, { months: ms, kind: 'actual' });
    columns.push({ key: `${key}:S`, label: 'Spread', group, kind: 'money', width: 120, total, edge: true });
    scopes.set(`${key}:S`, { months: ms, kind: 'spread' });
  };
  if (mode === 'single') pair('T', span, all, true);
  else {
    pair('T', `Total · ${all.length} month${all.length === 1 ? '' : 's'}`, all, true);
    for (const m of all) pair(m, short(m), [m], false);
  }
  return { columns, scopes };
}

const sumIn = (byMonth: Record<string, number>, months: readonly string[]): number => months.reduce((t, m) => t + (byMonth[m] ?? 0), 0);
/** A bill's figure in a column: in full in its booked month (Actual), or its spread parts (Spread). */
export const billIn = (b: LogisticsUpkeepBill, sc: RepairScope): number =>
  (sc.kind === 'actual' ? (sc.months.includes(b.day.slice(0, 7)) ? b.amountSen : 0) : sumIn(b.byMonth, sc.months));
const lorryIn = (l: LogisticsUpkeepLorry, sc: RepairScope): number => l.bills.reduce((t, b) => t + billIn(b, sc), 0);
export const lorryLabel = (l: LogisticsUpkeepLorry): string => l.plate ?? l.accountName ?? l.accountCode;
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
const wholeRm = (sen: number): string => {
  const text = Math.round(Math.abs(sen) / 100).toLocaleString('en-US');
  return sen < 0 ? `(${text})` : text;
};

export function RepairsView({ p, mode, period, months }: ViewProps) {
  const lorries = useMemo(() => p.upkeepLorries ?? [], [p]);
  const { columns, scopes } = useMemo(() => repairColumns(months, mode), [months, mode]);
  const single = mode === 'single';

  const rows = useMemo<GridRow[]>(() => {
    const cellsOf = (f: (sc: RepairScope) => number | null) => Object.fromEntries([...scopes].map(([k, sc]) => [k, f(sc)]));
    const whole = { months, kind: 'actual' as const };
    const billsDetail = (l: LogisticsUpkeepLorry) => (key: string): ReactNode | null => {
      const sc = scopes.get(key);
      if (!sc) return null;
      const bills = l.bills.map((b) => ({ ...b, here: billIn(b, sc) })).filter((b) => b.here !== 0);
      if (bills.length === 0) return null;
      const spreadNote = (b: LogisticsUpkeepBill) => (b.months <= 1 ? null
        : sc.kind === 'actual' ? `Spread over ${b.months} months on the P&L` : `RM ${fmtMoney(b.amountSen)} over ${b.months} months`);
      return (
        <table className={s.detailTable}>
          <thead><tr><th>Date</th><th>Document</th><th>Description</th><th className={s.num}>{sc.kind === 'actual' ? 'Actual' : 'Spread'}</th><th>Note</th></tr></thead>
          <tbody>
            {bills.map((b) => (
              <tr key={b.lineId}>
                <td>{fmtDateOrDash(b.day)}</td>
                <td>{b.docNo ?? '-'}</td>
                <td>{b.notes ?? ''}</td>
                <td className={s.num}>{fmtMoney(b.here)}</td>
                <td>{[spreadNote(b), b.otherPlate ? `Says ${b.otherPlate}` : null].filter(Boolean).join(' · ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      );
    };
    const kids: GridRow[] = lorries.map((l) => {
      const bills = l.bills.filter((b) => billIn(b, whole) !== 0 || sumIn(b.byMonth, months) !== 0).length;
      return {
        id: `lorry:${l.accountCode}`, label: lorryLabel(l),
        cap: single ? [l.accountCode, plural(bills, 'bill'), l.ours ? null : 'not in the lorry list'].filter(Boolean).join(' · ') : null,
        cells: cellsOf((sc) => lorryIn(l, sc)), detail: billsDetail(l),
      };
    });
    const total = cellsOf((sc) => lorries.reduce((t, l) => t + lorryIn(l, sc), 0));
    const upkeepOf = (m: string) => p.perMonth.find((x) => x.month === m)?.rows.find((r) => r.key === 'upkeep')?.totalSen ?? 0;
    /* The P&L spreads: it checks the Spread columns only. */
    const books = cellsOf((sc) => (sc.kind === 'spread' ? sc.months.reduce((t, m) => t + upkeepOf(m), 0) : null));
    const diff = Object.fromEntries(Object.keys(total).map((k) => [k, books[k] == null ? null : (total[k] ?? 0) - books[k]!]));
    const off = Object.values(diff).some((v) => v != null && v !== 0);
    return [
      { id: 'lorries', label: 'Repairs & maintenance', totalLabel: 'Total repairs & maintenance', kind: 'group', kids, cells: total },
      { id: 'check', label: 'Logistics P&L · Upkeep Cost (from the books)', kind: 'check', cells: books },
      { id: 'diff', label: 'Difference (Spread less the P&L)', kind: off ? 'bad' : 'check', zeroShows: true, cells: diff },
    ];
  }, [p, lorries, scopes, months, single]);

  if (!p.upkeepLorries) return <ReportMessage>Repairs by lorry is not on the server yet. Refresh in a minute.</ReportMessage>;
  if (lorries.length === 0) return <ReportMessage>No lorry repair or maintenance is in the books for {period}.</ReportMessage>;

  const actual: RepairScope = { months, kind: 'actual' };
  const spread: RepairScope = { months, kind: 'spread' };
  const actualT = lorries.reduce((t, l) => t + lorryIn(l, actual), 0);
  const spreadT = lorries.reduce((t, l) => t + lorryIn(l, spread), 0);
  const booked = lorries.reduce((t, l) => t + l.bills.filter((b) => billIn(b, actual) !== 0).length, 0);
  const top = [...lorries].sort((a, b) => lorryIn(b, actual) - lorryIn(a, actual))[0]!;
  const none = lorries.filter((l) => l.ours && lorryIn(l, actual) === 0 && lorryIn(l, spread) === 0);
  const flagged = lorries.flatMap((l) => l.bills.filter((b) => b.otherPlate && (billIn(b, actual) !== 0 || billIn(b, spread) !== 0)).map((b) => ({ l, b })));
  const tiles: ReportTile[] = [
    { key: 'actual', label: 'Actual', value: wholeRm(actualT), sub: `${plural(booked, 'bill')} booked in these months` },
    { key: 'spread', label: 'Spread', value: wholeRm(spreadT), sub: 'as the P&L: its Upkeep Cost' },
    { key: 'top', label: 'Most spent (actual)', value: lorryIn(top, actual) > 0 ? lorryLabel(top) : '—', sub: lorryIn(top, actual) > 0 ? `RM ${wholeRm(lorryIn(top, actual))}` : 'no bill' },
    { key: 'none', label: 'No repair booked', value: String(none.length), sub: none.length > 0 ? none.map(lorryLabel).join(', ') : 'every lorry has a bill' },
    {
      key: 'check', label: 'To check', value: String(flagged.length), tone: flagged.length > 0 ? 'late' : 'plain',
      sub: flagged.length > 0 ? `RM ${wholeRm(flagged.reduce((t, x) => t + x.b.amountSen, 0))} names another lorry` : 'none',
    },
  ];
  const sheet = () => gridSheet({ title: 'Logistics cost · repairs by lorry', subtitle: `${period} · RM`, period, nameLabel: 'Lorry', columns, rows, showPct: false });

  return (
    <>
      <ReportHeaderActions><ReportExports sheet={sheet} fileBase={`logistics-repairs-by-lorry-${months[0] ?? ''}-${months.at(-1) ?? ''}`} /></ReportHeaderActions>
      <ReportTiles tiles={tiles} label="Repairs by lorry totals" />
      {flagged.length > 0 && (
        <section className={s.notCounted} aria-label="To check">
          <h3 className={s.notCountedTitle}>To check</h3>
          <ul>
            {flagged.map(({ l, b }) => (
              <li key={b.lineId}>
                {`${b.docNo ?? 'A bill'} of ${fmtDateOrDash(b.day)}, RM ${fmtMoney(b.amountSen)}: the description says ${b.otherPlate}, but it is booked to ${lorryLabel(l)} (${l.accountCode}). If the description is right, Finance moves it to ${b.otherPlate}'s upkeep account.`}
              </li>
            ))}
          </ul>
        </section>
      )}
      <FinanceGrid layoutKey={`logistics-repairs-actual-spread|${mode}`} nameColumn={{ label: 'Lorry', width: 300 }} columns={columns} rows={rows}
        title="Logistics cost · repairs by lorry" subtitle={`${period} · RM`} ariaLabel="Repairs and maintenance by lorry" drillKey={`${months.join()}|${mode}`}
        foot={<span>Actual: each bill in full in the month it is booked. Spread: each bill over the months Finance gives it on the P&amp;L, so the Spread columns add up to the P&amp;L&rsquo;s Upkeep Cost. A lorry&rsquo;s figure opens its bills.</span>} />
    </>
  );
}
