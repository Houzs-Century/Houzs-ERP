// ----------------------------------------------------------------------------
// LogisticsCost — the Logistics cost tab, the design the owner approved on
// 2026-11-05 (demo https://claude.ai/artifact/JoQSYerQXoWd7gQgWLrZQw). Three
// views, all report style (FinanceGrid — the statement look, the owner's
// "finance table"), each Single month (regions across the top) or By month
// (Total first, then a column per month; optionally each month split by region):
//   • P&L — the owner's Logistic Cost Report from the books (LogisticsPnl.tsx);
//   • By region & trip — our lorries one line per lorry, 3PL one line per
//     carrier, so that its Total IS the P&L's TOTAL EXPENSE (Difference 0); a
//     lorry's figure opens its trips;
//   • Setup & Dismantle — each fair in its region: 1% of its sales as income,
//     its cost from its own books (Project Overview), the net, and the check.
// One read for all three: GET /acc-events/logistics/pnl (backend/src/scm/routes/
// acc-logistics-pnl.ts; the arithmetic scm/lib/logistics-pnl.ts and
// logistics-breakdown.ts). The view and mode live in the URL.
// ----------------------------------------------------------------------------

import { useMemo, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { monthEnd, monthStart } from '../../lib/dateRangePresets';
import { fmtDayMonthRange } from '../../vendor/shared/format';
import { useLogisticsPnl, type LogisticsMonth, type LogisticsPnl, type PnlRegion } from '../../vendor/scm/lib/logistics-queries';
import { FinanceGrid, fmtMoney, type GridRow } from './reports/FinanceGrid';
import { FinanceDateRange } from './reports/FinanceDateRange';
import {
  ReportExports, ReportHeaderActions, ReportMessage, ReportSwitch, ReportTiles, ReportTool, ReportToolbar, Segmented, useReportSubtitle,
  type ReportTile,
} from './reports/reportParts';
import { monthName } from './reports/statementColumns';
import { useReportRange } from './reports/useReportRange';
import { PnlView } from './LogisticsPnl';
import {
  ALL_REGIONS, REGIONS, cellsBy, gridSheet, isWhole, logisticsColumns, pctOf, regionName, totalsOnly,
  type Mode, type Scope,
} from './logisticsColumns';
import s from './Logistics.module.css';

/** A tile's money: whole ringgit, a negative in brackets. */
export const tileRm = (sen: number): string => {
  const text = Math.round(Math.abs(sen) / 100).toLocaleString('en-US');
  return sen < 0 ? `(${text})` : text;
};

type View = 'pnl' | 'region' | 'events';
const VIEWS: ReadonlyArray<{ value: View; label: string }> = [
  { value: 'pnl', label: 'P&L' },
  { value: 'region', label: 'By region & trip' },
  { value: 'events', label: 'Setup & Dismantle' },
];
const MODES: ReadonlyArray<{ value: Mode; label: string }> = [{ value: 'single', label: 'Single month' }, { value: 'months', label: 'By month' }];

export type ViewProps = { p: LogisticsPnl; mode: Mode; split: boolean; showPct: boolean; period: string; months: string[] };

export const LogisticsCostTab = () => {
  const r = useReportRange();
  const [params, setParams] = useSearchParams();
  const view = (VIEWS.find((v) => v.value === params.get('lv'))?.value ?? 'pnl');
  const mode: Mode = params.get('lm') === 'months' ? 'months' : 'single';
  const split = params.get('lsplit') === '1';
  const showPct = params.get('lpct') !== '0';
  const setParam = (k: string, v: string | null) => setParams((prev) => {
    const n = new URLSearchParams(prev);
    if (v == null) n.delete(k); else n.set(k, v);
    return n;
  }, { replace: true });

  /* Whole months: the range widens to its months' first and last days. */
  const from = r.usable ? monthStart(r.from) : monthStart(r.today);
  const to = r.usable ? monthEnd(r.to) : monthEnd(r.today);
  const period = from.slice(0, 7) === to.slice(0, 7) ? monthName(from) : `${monthName(from)} – ${monthName(to)}`;
  const partMonths = r.usable && (r.from !== from || r.to !== to);
  useReportSubtitle(`${period}${partMonths ? ' · whole months' : ''}${mode === 'months' ? ' · by month' : ''} · RM`);

  const q = useLogisticsPnl(from, to);
  const p = q.data;
  const months = p?.months ?? [];

  return (
    <>
      <ReportToolbar>
        <FinanceDateRange label="Months" />
        <ReportTool label="View"><Segmented options={VIEWS} value={view} onChange={(v) => setParam('lv', v === 'pnl' ? null : v)} label="Logistics views" /></ReportTool>
        <ReportTool label="Show"><Segmented options={MODES} value={mode} onChange={(v) => setParam('lm', v === 'single' ? null : v)} label="Single month or by month" /></ReportTool>
        {view !== 'region' && (
          <ReportSwitch on={showPct} onChange={(v) => setParam('lpct', v ? null : '0')}>{view === 'events' ? '% of fair sales' : '% of DO'}</ReportSwitch>
        )}
        {mode === 'months' && <ReportSwitch on={split} onChange={(v) => setParam('lsplit', v ? '1' : null)}>Split each month by region</ReportSwitch>}
      </ReportToolbar>
      {!r.usable && <ReportMessage>Pick dates.</ReportMessage>}
      {q.isError && <ReportMessage tone="error">The report could not be read — {q.error instanceof Error ? q.error.message : String(q.error)}</ReportMessage>}
      {!p && q.isLoading && <ReportTiles tiles={['Deliveries (DOs)', 'Delivery cost', 'Our lorries', '3PL', 'Setup & Dismantle'].map((label) => ({ key: label, label, value: '' }))} label="Logistics totals" pending />}
      {p && view === 'pnl' && <PnlView p={p} mode={mode} split={split} showPct={showPct} period={period} months={months} />}
      {p && view === 'region' && <RegionView p={p} mode={mode} split={split} showPct={false} period={period} months={months} />}
      {p && view === 'events' && <EventsView p={p} mode={mode} split={split} showPct={showPct} period={period} months={months} />}
    </>
  );
};

const byMonthOf = (p: LogisticsPnl) => new Map(p.perMonth.map((m) => [m.month, m] as const));
const sumR = (x: Record<PnlRegion, number>) => x.PG + x.KL + x.EM + x.SG;
const totalOf = (p: LogisticsPnl, f: (m: LogisticsMonth) => number) => p.perMonth.reduce((t, m) => t + f(m), 0);

/* ── What could not be counted ─────────────────────────────────────────────── */
function NotCounted({ lines }: { lines: string[] }) {
  if (lines.length === 0) return null;
  return (
    <section className={s.notCounted} aria-label="Not counted">
      <h3 className={s.notCountedTitle}>Not counted</h3>
      <ul>{lines.map((l) => <li key={l}>{l}</li>)}</ul>
    </section>
  );
}
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/* ── By region & trip ──────────────────────────────────────────────────────── */
function RegionView({ p, mode, split, period, months }: ViewProps) {
  const byMonth = useMemo(() => byMonthOf(p), [p]);
  const { columns, scopes } = useMemo(() => logisticsColumns(months, mode, split, 120), [months, mode, split]);
  const single = mode === 'single';

  const rows = useMemo<GridRow[]>(() => {
    /* One line per lorry and per carrier over the months shown. */
    const plates = [...new Set(p.perMonth.flatMap((m) => m.cost.lorries.map((l) => l.plate)))].sort();
    const carriers = [...new Set(p.perMonth.flatMap((m) => m.cost.carriers.map((c) => c.name)))];
    const lorryOf = (m: LogisticsMonth, plate: string) => m.cost.lorries.find((l) => l.plate === plate);
    const carrierOf = (m: LogisticsMonth, name: string) => m.cost.carriers.find((c) => c.name === name);
    const tripsDetail = (plate: string) => (key: string): ReactNode | null => {
      const sc = scopes.get(key)!;
      const trips = sc.months.flatMap((mm) => lorryOf(byMonth.get(mm)!, plate)?.tripList ?? [])
        .map((t) => ({ ...t, here: sc.regions.reduce((x, r) => x + t.sen[r], 0) })).filter((t) => t.here !== 0);
      if (trips.length === 0) return null;
      return (
        <table className={s.detailTable}>
          <thead><tr><th>Date</th><th className={s.num}>DOs</th><th>Regions</th><th className={s.num}>Cost</th></tr></thead>
          <tbody>
            {trips.map((t) => (
              <tr key={t.day}>
                <td>{t.day.replace(/-/g, '/')}</td>
                <td className={s.num} title={t.doNumbers.join(', ')}>{t.dos}</td>
                <td>{ALL_REGIONS.filter((r) => t.sen[r] !== 0).map(regionName).join(', ')}</td>
                <td className={s.num}>{fmtMoney(t.here)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      );
    };
    const billsDetail = (name: string) => (key: string): ReactNode | null => {
      const sc = scopes.get(key)!;
      const bills = sc.months.flatMap((mm) => carrierOf(byMonth.get(mm)!, name)?.billList ?? [])
        .map((b) => ({ ...b, here: sc.regions.reduce((x, r) => x + b.sen[r], 0) })).filter((b) => b.here !== 0);
      if (bills.length === 0) return null;
      return (
        <table className={s.detailTable}>
          <thead><tr><th>Bill</th><th>Date</th><th className={s.num}>Cost</th></tr></thead>
          <tbody>{bills.map((b) => <tr key={b.ref}><td>{b.ref}</td><td>{b.day.replace(/-/g, '/')}</td><td className={s.num}>{fmtMoney(b.here)}</td></tr>)}</tbody>
        </table>
      );
    };
    const lorryLines: GridRow[] = plates.map((plate) => {
      const trips = totalOf(p, (m) => lorryOf(m, plate)?.trips ?? 0);
      const dos = totalOf(p, (m) => lorryOf(m, plate)?.dos ?? 0);
      return {
        id: `lorry:${plate}`, label: plate, cap: single ? `${plural(trips, 'trip')} · ${plural(dos, 'DO')}` : null,
        cells: cellsBy(scopes, byMonth, (m, r) => lorryOf(m, plate)?.sen[r] ?? 0), detail: tripsDetail(plate),
      };
    });
    const noTrip = totalOf(p, (m) => m.cost.inHouseNoTripSen);
    if (noTrip !== 0) lorryLines.push({ id: 'notrip', label: 'In-house cost with no trip recorded', kind: 'warn', cells: totalsOnly(scopes, byMonth, (m) => m.cost.inHouseNoTripSen) });
    const carrierLines: GridRow[] = carriers.map((name) => {
      const lines = totalOf(p, (m) => carrierOf(m, name)?.lines ?? 0);
      const dos = totalOf(p, (m) => carrierOf(m, name)?.dos ?? 0);
      return {
        id: `carrier:${name}`, label: name, cap: single && lines > 0 ? `${plural(lines, 'bill line')} · ${plural(dos, 'DO')}` : null,
        cells: cellsBy(scopes, byMonth, (m, r) => carrierOf(m, name)?.sen[r] ?? 0), detail: billsDetail(name),
      };
    });
    const noDoLines = totalOf(p, (m) => m.cost.threeplNoDo.lines);
    carrierLines.push({
      id: 'nodo', label: '3PL bill lines on no DO yet', cap: single && noDoLines > 0 ? plural(noDoLines, 'line') : null, kind: 'warn',
      cells: totalsOnly(scopes, byMonth, (m) => m.cost.threeplNoDo.sen),
    });
    const sumCells = (list: GridRow[]) => {
      const out: Record<string, number> = {};
      for (const k of scopes.keys()) out[k] = list.reduce((t, x) => t + (typeof x.cells[k] === 'number' ? (x.cells[k] as number) : 0), 0);
      return out;
    };
    const own: GridRow = { id: 'own', label: 'Our lorries', totalLabel: 'Total our lorries', kind: 'group', kids: lorryLines, cells: sumCells(lorryLines) };
    const tpl: GridRow = { id: 'tpl', label: '3PL (Outsourced)', totalLabel: 'Total 3PL (Outsourced)', kind: 'group', kids: carrierLines, cells: sumCells(carrierLines) };
    const total = sumCells([own, tpl]);
    const dos = cellsBy(scopes, byMonth, (m, r) => m.cost.dos[r]);
    const goods = cellsBy(scopes, byMonth, (m, r) => m.cost.goodsSen[r]);
    const ratio = (f: (k: string) => number | null) => Object.fromEntries([...scopes.keys()].map((k) => [k, f(k)]));
    const books = totalsOnly(scopes, byMonth, (m) => m.rows.find((x) => x.key === 'total_expense')?.totalSen ?? 0);
    const diff = ratio((k) => (books[k] == null ? null : total[k]! - books[k]!));
    const off = Object.values(diff).some((v) => v != null && v !== 0);
    return [
      own, tpl,
      { id: 'total', label: 'Total delivery cost', kind: 'final', cells: total },
      { id: 'dos', label: 'DOs', kind: 'ratio', int: true, cells: dos },
      { id: 'goods', label: 'Goods', kind: 'ratio', cells: goods },
      { id: 'perdo', label: 'Cost per DO', kind: 'ratio', cells: ratio((k) => (dos[k] ? Math.round(total[k]! / dos[k]!) : null)) },
      { id: 'pctgoods', label: '% of goods', kind: 'ratio', isPct: true, cells: ratio((k) => (goods[k] ? Math.round((total[k]! / goods[k]!) * 1000) / 10 : null)) },
      { id: 'nobody', label: 'DOs with no lorry and no 3PL bill', kind: 'warn', int: true, cells: cellsBy(scopes, byMonth, (m, r) => m.cost.noDeliverer[r]) },
      { id: 'check', label: 'Logistics P&L · TOTAL EXPENSE (from the books)', kind: 'check', cells: books },
      { id: 'diff', label: 'Difference', kind: off ? 'bad' : 'check', zeroShows: true, cells: diff },
    ];
  }, [p, byMonth, scopes, single]);

  const T = (f: (m: LogisticsMonth) => number) => totalOf(p, f);
  const dos = T((m) => sumR(m.cost.dos));
  const goods = T((m) => sumR(m.cost.goodsSen));
  const cost = T((m) => m.costTotalSen);
  const own = T((m) => m.cost.lorries.reduce((t, l) => t + sumR(l.sen), 0) + m.cost.inHouseNoTripSen);
  const ownTrips = T((m) => m.cost.ownTrips);
  const tpl = cost - own;
  const fairs = T((m) => m.fairs.reduce((t, f) => t + f.chargeSen + f.setupSen + f.dismantleSen + f.transportSen, 0) + m.noFair.sen);
  const tiles: ReportTile[] = [
    { key: 'dos', label: 'Deliveries (DOs)', value: dos.toLocaleString('en-US'), sub: `Goods RM ${tileRm(goods)}` },
    { key: 'cost', label: 'Delivery cost', value: tileRm(cost), sub: `${dos > 0 ? `RM ${tileRm(cost / dos)} per DO` : '—'} · ${goods > 0 ? `${((cost / goods) * 100).toFixed(1)}%` : '—'} of goods` },
    { key: 'own', label: 'Our lorries', value: tileRm(own), sub: `${plural(ownTrips, 'trip')}${ownTrips > 0 ? ` · RM ${tileRm(own / ownTrips)} each` : ''}` },
    { key: '3pl', label: '3PL', value: tileRm(tpl), sub: `${plural(T((m) => m.cost.carriers.reduce((t, c) => t + c.lines, 0) + m.cost.threeplNoDo.lines), 'bill line')}` },
    { key: 'setup', label: 'Setup & Dismantle', value: p.fairsProblem ? '—' : tileRm(fairs), sub: p.fairsProblem ? 'could not be read' : plural(T((m) => m.fairs.length), 'fair'), tone: p.fairsProblem ? 'late' : 'plain' },
  ];
  const notCounted: string[] = [];
  const nobody = T((m) => sumR(m.cost.noDeliverer));
  if (nobody > 0) notCounted.push(`${plural(nobody, 'DO')} with nobody on ${nobody === 1 ? 'it' : 'them'}: no lorry picked and no 3PL bill. Pick the lorry in Delivery Planning.`);
  const noDo = T((m) => m.cost.threeplNoDo.sen);
  if (noDo !== 0) notCounted.push(`RM ${fmtMoney(noDo)} on 3PL bills is on no DO yet (no region): Delivery Rate Cards › 3PL invoices.`);
  const sheet = () => gridSheet({ title: 'Logistics cost · by region & trip', subtitle: `${period} · RM`, period, nameLabel: 'Lorry / 3PL', columns, rows, showPct: false });

  return (
    <>
      <ReportHeaderActions><ReportExports sheet={sheet} fileBase={`logistics-by-region-${months[0] ?? ''}-${months.at(-1) ?? ''}`} /></ReportHeaderActions>
      <ReportTiles tiles={tiles} label="Logistics totals" />
      <NotCounted lines={notCounted} />
      <FinanceGrid storageKey={`logistics-region|${mode}|${split ? 1 : 0}`} nameColumn={{ label: 'Lorry / 3PL', width: 300 }} columns={columns} rows={rows}
        title="Logistics cost · by region & trip" subtitle={`${period} · RM`} ariaLabel="Delivery cost by region and trip" drillKey={`${months.join()}|${mode}|${split}`}
        foot={<span>Our lorries carry the full in-house cost (petrol, upkeep, instalment, road tax &amp; insurance, manpower) ÷ the month&rsquo;s trips; a trip into two regions splits by DOs. 3PL goes by bill month. A lorry&rsquo;s figure opens its trips.</span>} />
    </>
  );
}

/* ── Setup & Dismantle ─────────────────────────────────────────────────────── */
function EventsView({ p, mode, split, showPct, period, months }: ViewProps) {
  const byMonth = useMemo(() => byMonthOf(p), [p]);
  const { columns, scopes } = useMemo(() => logisticsColumns(months, mode, split, showPct ? 172 : 120), [months, mode, split, showPct]);
  const rate = `${(p.fairIncomeBp / 100).toFixed(2).replace(/\.?0+$/, '')}%`;

  const rows = useMemo<GridRow[]>(() => {
    const fairs = p.perMonth.flatMap((m) => m.fairs.map((f) => ({ f, month: m.month })));
    const at = (month: string, region: PnlRegion, sen: number) => {
      const out: Record<string, number | null> = {};
      for (const [k, sc] of scopes) out[k] = sc.months.includes(month) && sc.regions.includes(region) ? sen : null;
      return out;
    };
    const where = (f: (typeof fairs)[number]['f']) => [f.venue, fmtDayMonthRange(f.startDate, f.endDate)].filter(Boolean).join(' · ');
    const sumCells = (list: GridRow[]) => {
      const out: Record<string, number> = {};
      for (const k of scopes.keys()) out[k] = list.reduce((t, x) => t + (typeof x.cells[k] === 'number' ? (x.cells[k] as number) : 0), 0);
      return out;
    };
    const sales = cellsBy(scopes, byMonth, (m, r) => m.fairs.filter((f) => f.region === r).reduce((t, f) => t + f.salesSen, 0));
    const withPct = (r: GridRow): GridRow => ({ ...r, pct: pctOf(r.cells, sales), kids: r.kids?.map(withPct) });

    const incomeKids: GridRow[] = fairs.map(({ f, month }) => ({ id: `inc:${f.id}`, label: f.name, cap: where(f), capBelow: true, cells: at(month, f.region, f.incomeSen) }));
    const income: GridRow = { id: 'income', label: `INCOME · ${rate} of fair sales`, totalLabel: 'Total income', kids: incomeKids, cells: sumCells(incomeKids) };
    const costOf = ({ f, month }: (typeof fairs)[number]): GridRow => {
      const kids: GridRow[] = [
        ...(f.chargeTrips > 0 ? [{ id: `c:${f.id}:charge`, label: 'Logistics setup / dismantle charge', cap: plural(f.chargeTrips, 'trip'), cells: at(month, f.region, f.chargeSen) }] : []),
        { id: `c:${f.id}:setup`, label: 'Setup', cells: at(month, f.region, f.setupSen) },
        { id: `c:${f.id}:dis`, label: 'Dismantle', cells: at(month, f.region, f.dismantleSen) },
        { id: `c:${f.id}:tr`, label: 'Transport', cells: at(month, f.region, f.transportSen) },
      ];
      return { id: `c:${f.id}`, label: f.name, cap: where(f), capBelow: true, kind: 'group', closedAtFirst: true, totalLabel: `Total ${f.name}`, kids, cells: sumCells(kids) };
    };
    const inKids = fairs.filter((x) => x.f.who === 'inhouse').map(costOf);
    const noFairLines = totalOf(p, (m) => m.noFair.lines);
    const outKids = [
      ...fairs.filter((x) => x.f.who === '3pl').map(costOf),
      { id: 'nofair', label: '3PL setup / dismantle lines with no fair picked', cap: mode === 'single' && noFairLines > 0 ? plural(noFairLines, 'line') : null, kind: 'warn' as const, cells: totalsOnly(scopes, byMonth, (m) => m.noFair.sen) },
    ];
    const groups: GridRow[] = [
      ...(inKids.length ? [{ id: 'cin', label: 'In-house (our crew and lorries)', totalLabel: 'Total in-house', kind: 'group' as const, kids: inKids, cells: sumCells(inKids) }] : []),
      { id: 'cout', label: '3PL (Outsourced)', totalLabel: 'Total 3PL (Outsourced)', kind: 'group', kids: outKids, cells: sumCells(outKids) },
    ];
    const cost: GridRow = { id: 'cost', label: 'COST', totalLabel: 'Total setup & dismantle cost', kids: groups, cells: sumCells(groups) };
    const net = Object.fromEntries([...scopes.keys()].map((k) => [k, (income.cells[k] as number) - (cost.cells[k] as number)]));
    const books = cellsBy(scopes, byMonth, (m, r) => m.fairs.filter((f) => f.region === r).reduce((t, f) => t + f.booksSen, 0));
    const noFair = totalsOnly(scopes, byMonth, (m) => m.noFair.sen);
    const diff = Object.fromEntries([...scopes.keys()].map((k) => [k, (cost.cells[k] as number) - (noFair[k] ?? 0) - books[k]!]));
    const off = Object.values(diff).some((v) => v !== 0);
    return [
      { id: 'sales', label: 'Fair sales', kind: 'strong', cells: sales, pct: pctOf(sales, sales) },
      { id: 'events', label: 'Total events', kind: 'ratio', int: true, cells: cellsBy(scopes, byMonth, (m, r) => m.fairs.filter((f) => f.region === r).length) },
      withPct(income), withPct(cost),
      { id: 'net', label: 'NET', kind: 'final', cells: net, pct: pctOf(net, sales) },
      { id: 'check', label: 'Check: the fairs’ own books (Project Overview)', kind: 'check', cells: books },
      { id: 'diff', label: 'Difference (the fairs’ cost less their books)', kind: off ? 'bad' : 'check', zeroShows: true, cells: diff },
    ];
  }, [p, byMonth, scopes, rate, mode]);

  const T = (f: (m: LogisticsMonth) => number) => totalOf(p, f);
  const salesT = T((m) => m.fairs.reduce((t, f) => t + f.salesSen, 0));
  const incomeT = T((m) => m.fairs.reduce((t, f) => t + f.incomeSen, 0));
  const costT = T((m) => m.fairs.reduce((t, f) => t + f.chargeSen + f.setupSen + f.dismantleSen + f.transportSen, 0) + m.noFair.sen);
  const tiles: ReportTile[] = [
    { key: 'sales', label: 'Fair sales', value: tileRm(salesT), sub: plural(T((m) => m.fairs.length), 'fair') },
    { key: 'income', label: `Income (${rate})`, value: tileRm(incomeT), sub: 'of the fairs’ sales' },
    { key: 'cost', label: 'Setup & dismantle cost', value: tileRm(costT), sub: salesT > 0 ? `${((costT / salesT) * 100).toFixed(1)}% of fair sales` : '—' },
    { key: 'net', label: 'Net', value: tileRm(incomeT - costT), tone: incomeT - costT < 0 ? 'late' : 'good', sub: incomeT - costT < 0 ? '▼ cost more than it earned' : '▲ earned more than it cost' },
  ];
  const sheet = () => gridSheet({ title: 'Logistics cost · setup & dismantle', subtitle: `${period} · RM`, period, nameLabel: 'Fair', columns, rows, showPct });
  if (p.fairsProblem) return <ReportMessage tone="error">The fairs&rsquo; sales and books could not be read — {p.fairsProblem}.</ReportMessage>;
  return (
    <>
      <ReportHeaderActions><ReportExports sheet={sheet} fileBase={`logistics-setup-dismantle-${months[0] ?? ''}-${months.at(-1) ?? ''}`} /></ReportHeaderActions>
      <ReportTiles tiles={tiles} label="Setup and dismantle totals" />
      <FinanceGrid storageKey={`logistics-events|${mode}|${split ? 1 : 0}|${showPct ? 1 : 0}`} nameColumn={{ label: 'Fair', width: 370 }} columns={columns} rows={rows} showPct={showPct}
        title="Logistics cost · setup & dismantle" subtitle={`${period} · RM`} ariaLabel="Setup and dismantle by fair" drillKey={`${months.join()}|${mode}|${split}`}
        foot={<span>Every % is of the fair sales in its column. A fair counts in the month it opened. Open a fair for the Logistics charge (trips × the area rate), Setup, Dismantle and Transport.</span>} />
    </>
  );
}

export { REGIONS, isWhole };
export type { Scope };
