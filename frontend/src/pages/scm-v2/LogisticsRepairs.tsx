// ----------------------------------------------------------------------------
// LogisticsRepairs — the Logistics cost tab's Repairs by lorry view (owner
// 2026-11-25: 「我要看到的就是每辆lorry的维修成本，做成一个报表」): each lorry's
// repair & maintenance cost from the books, one line per lorry, its figure
// opening its bills. The lorries add up to the P&L's Upkeep Cost (the check and
// Difference rows). A bill whose description names another lorry is listed under
// To check, never moved: the books decide, Finance corrects the posting.
// Server: scm/lib/lorry-upkeep.ts, on GET /acc-events/logistics/pnl.
// ----------------------------------------------------------------------------

import { useMemo, type ReactNode } from 'react';
import { fmtDateOrDash } from '../../vendor/shared/format';
import type { LogisticsUpkeepLorry } from '../../vendor/scm/lib/logistics-queries';
import { FinanceGrid, fmtMoney, type GridColumn, type GridRow } from './reports/FinanceGrid';
import { ReportExports, ReportHeaderActions, ReportMessage, ReportTiles, type ReportTile } from './reports/reportParts';
import { monthName } from './reports/statementColumns';
import { gridSheet, type Mode } from './logisticsColumns';
import type { ViewProps } from './LogisticsCost';
import s from './Logistics.module.css';

/** Single month: the period in one Total column. By month: Total first, then a
 *  column per month. Each column names the months it adds up. */
export function repairColumns(months: readonly string[], mode: Mode): { columns: GridColumn[]; monthsOf: Map<string, string[]> } {
  const short = (m: string) => monthName(`${m}-01`);
  const all = [...months];
  const span = all.length === 0 ? '' : all.length === 1 ? short(all[0]!) : `${short(all[0]!)} – ${short(all[all.length - 1]!)}`;
  const monthsOf = new Map<string, string[]>([['T', all]]);
  const columns: GridColumn[] = [{
    key: 'T', label: 'Total', sub: mode === 'single' ? span : `${all.length} month${all.length === 1 ? '' : 's'}`,
    kind: 'money', width: 140, total: true, edge: mode === 'months',
  }];
  if (mode === 'months') for (const m of all) { columns.push({ key: m, label: short(m), kind: 'money', width: 120 }); monthsOf.set(m, [m]); }
  return { columns, monthsOf };
}

const sumIn = (byMonth: Record<string, number>, months: readonly string[]): number => months.reduce((t, m) => t + (byMonth[m] ?? 0), 0);
export const lorryLabel = (l: LogisticsUpkeepLorry): string => l.plate ?? l.accountName ?? l.accountCode;
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
const wholeRm = (sen: number): string => {
  const text = Math.round(Math.abs(sen) / 100).toLocaleString('en-US');
  return sen < 0 ? `(${text})` : text;
};

export function RepairsView({ p, mode, period, months }: ViewProps) {
  const lorries = useMemo(() => p.upkeepLorries ?? [], [p]);
  const { columns, monthsOf } = useMemo(() => repairColumns(months, mode), [months, mode]);
  const single = mode === 'single';

  const rows = useMemo<GridRow[]>(() => {
    const cellsOf = (f: (ms: string[]) => number) => Object.fromEntries([...monthsOf].map(([k, ms]) => [k, f(ms)]));
    const billsDetail = (l: LogisticsUpkeepLorry) => (key: string): ReactNode | null => {
      const ms = monthsOf.get(key) ?? [];
      const bills = l.bills.map((b) => ({ ...b, here: sumIn(b.byMonth, ms) })).filter((b) => b.here !== 0);
      if (bills.length === 0) return null;
      return (
        <table className={s.detailTable}>
          <thead><tr><th>Date</th><th>Document</th><th>Description</th><th className={s.num}>Cost</th><th>Note</th></tr></thead>
          <tbody>
            {bills.map((b) => (
              <tr key={b.lineId}>
                <td>{fmtDateOrDash(b.day)}</td>
                <td>{b.docNo ?? '-'}</td>
                <td>{b.notes ?? ''}</td>
                <td className={s.num}>{fmtMoney(b.here)}</td>
                <td>{[b.months > 1 ? `RM ${fmtMoney(b.amountSen)} over ${b.months} months` : null, b.otherPlate ? `Says ${b.otherPlate}` : null].filter(Boolean).join(' · ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      );
    };
    const kids: GridRow[] = lorries.map((l) => {
      const bills = l.bills.filter((b) => sumIn(b.byMonth, months) !== 0).length;
      return {
        id: `lorry:${l.accountCode}`, label: lorryLabel(l),
        cap: single ? [l.accountCode, plural(bills, 'bill'), l.ours ? null : 'not in the lorry list'].filter(Boolean).join(' · ') : null,
        cells: cellsOf((ms) => sumIn(l.byMonth, ms)), detail: billsDetail(l),
      };
    });
    const total = cellsOf((ms) => lorries.reduce((t, l) => t + sumIn(l.byMonth, ms), 0));
    const upkeepOf = (m: string) => p.perMonth.find((x) => x.month === m)?.rows.find((r) => r.key === 'upkeep')?.totalSen ?? 0;
    const books = cellsOf((ms) => ms.reduce((t, m) => t + upkeepOf(m), 0));
    const diff = Object.fromEntries(Object.keys(total).map((k) => [k, total[k]! - books[k]!]));
    const off = Object.values(diff).some((v) => v !== 0);
    return [
      { id: 'lorries', label: 'Repairs & maintenance', totalLabel: 'Total repairs & maintenance', kind: 'group', kids, cells: total },
      { id: 'check', label: 'Logistics P&L · Upkeep Cost (from the books)', kind: 'check', cells: books },
      { id: 'diff', label: 'Difference', kind: off ? 'bad' : 'check', zeroShows: true, cells: diff },
    ];
  }, [p, lorries, monthsOf, months, single]);

  if (!p.upkeepLorries) return <ReportMessage>Repairs by lorry is not on the server yet. Refresh in a minute.</ReportMessage>;
  if (lorries.length === 0) return <ReportMessage>No lorry repair or maintenance is in the books for {period}.</ReportMessage>;

  const amountOf = (l: LogisticsUpkeepLorry) => sumIn(l.byMonth, months);
  const total = lorries.reduce((t, l) => t + amountOf(l), 0);
  const ours = lorries.filter((l) => l.ours);
  const top = [...lorries].sort((a, b) => amountOf(b) - amountOf(a))[0]!;
  const none = ours.filter((l) => amountOf(l) === 0);
  const flagged = lorries.flatMap((l) => l.bills.filter((b) => b.otherPlate && sumIn(b.byMonth, months) !== 0).map((b) => ({ l, b })));
  const bills = lorries.reduce((t, l) => t + l.bills.filter((b) => sumIn(b.byMonth, months) !== 0).length, 0);
  const tiles: ReportTile[] = [
    { key: 'total', label: 'Repairs & maintenance', value: wholeRm(total), sub: plural(bills, 'bill') },
    { key: 'top', label: 'Most spent', value: amountOf(top) > 0 ? lorryLabel(top) : '—', sub: amountOf(top) > 0 ? `RM ${wholeRm(amountOf(top))}` : 'no bill' },
    { key: 'avg', label: 'Per lorry', value: ours.length > 0 ? wholeRm(ours.reduce((t, l) => t + amountOf(l), 0) / ours.length) : '—', sub: `${ours.length} of our lorries` },
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
      <FinanceGrid layoutKey={`logistics-repairs|${mode}`} nameColumn={{ label: 'Lorry', width: 320 }} columns={columns} rows={rows}
        title="Logistics cost · repairs by lorry" subtitle={`${period} · RM`} ariaLabel="Repairs and maintenance by lorry" drillKey={`${months.join()}|${mode}`}
        foot={<span>From the books: each lorry&rsquo;s upkeep account (UPKEEP OF LORI - plate), every bill in the months the P&amp;L spreads it over, so the Total is the P&amp;L&rsquo;s Upkeep Cost. A lorry&rsquo;s figure opens its bills.</span>} />
    </>
  );
}
