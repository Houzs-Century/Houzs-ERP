// ----------------------------------------------------------------------------
// LogisticsCost — the Logistics cost tab (owner 2026-10-29: 物流报告 按地区、每趟、
// setup & dismantle —「都需要」; 自己罗厘的成本（油、过路费、司机）也要算 →「那就
// 先算 overall … trip 除成本」). What getting goods to customers and fairs cost in
// the chosen months:
//   • P&L — the owner's own Logistic Cost Report from the books (LogisticsPnl.tsx,
//     2026-10-29 做), the first view;
//   • By region — the DOs that went out, what they carried, our lorries' share
//     and the 3PL bills, per delivery-planning region;
//   • Per trip — each trip of ours (one lorry, one day) at the month's lorry cost
//     ÷ the month's trips, and each 3PL run (one bill line);
//   • Setup & Dismantle — each fair's booth setup and its transport, from its
//     own books (the rows Project Overview shows).
// Which account feeds which row — Petrol, Upkeep, Outsource by region … — is
// Finance's pick on the Chart of Accounts (its Logistics column, owner 2026-10-29:
// the tick list here 「这样显示很丑，就不能在coa 那边tick？」).
// What could not be counted is said above the views, never folded into a zero.
// Server: backend/src/scm/routes/acc-logistics.ts.
//
// The owner's redesign (batch 6 §5.11): inside the report shell — the months
// in the subtitle, Excel · PDF · Print in the header for the view on screen;
// one toolbar row (the shared range in whole months, the view); the tiles.
// ----------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import { DataTable, type Column } from '../../components/DataTable';
import { monthEnd, monthStart } from '../../lib/dateRangePresets';
import { AMOUNT_COLUMN, PCT_COLUMN, type ReportSheet, type SheetRow } from '../../vendor/scm/lib/report-sheet';
import { fmtDayMonthRange, fmtDateOrDash } from '../../vendor/shared/format';
import {
  useLogisticsCost,
  type LogisticsEventRow, type LogisticsRegionRow, type LogisticsReport, type LogisticsTripRow,
} from '../../vendor/scm/lib/logistics-queries';
import { PnlView } from './LogisticsPnl';
import { FinanceDateRange } from './reports/FinanceDateRange';
import {
  ReportExports, ReportHeaderActions, ReportMessage, ReportTiles, ReportTool, ReportToolbar, Segmented, useReportSubtitle,
  type ReportTile,
} from './reports/reportParts';
import { monthName } from './reports/statementColumns';
import { useReportRange } from './reports/useReportRange';
import s from './Logistics.module.css';

/** Table money: 1,234.56 (the header says RM); a negative in brackets. */
export const fmtRm = (sen: number): string => {
  const text = (Math.abs(sen) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return sen < 0 ? `(${text})` : text;
};
/** A tile's money: whole ringgit, a negative in brackets (the owner's sheet reads whole ringgit). */
export const tileRm = (sen: number): string => {
  const text = Math.round(Math.abs(sen) / 100).toLocaleString('en-MY');
  return sen < 0 ? `(${text})` : text;
};
const pct = (part: number, whole: number): string => (whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : '—');
const sum = <T,>(rows: readonly T[], f: (r: T) => number): number => rows.reduce((t, r) => t + f(r), 0);
const Num = ({ children }: { children: React.ReactNode }) => <span className={s.num}>{children}</span>;

type View = 'pnl' | 'region' | 'trips' | 'events';
const VIEWS: ReadonlyArray<{ value: View; label: string }> = [
  { value: 'pnl', label: 'P&L' },
  { value: 'region', label: 'By region' },
  { value: 'trips', label: 'Per trip' },
  { value: 'events', label: 'Setup & Dismantle' },
];

export const LogisticsCostTab = () => {
  const r = useReportRange();
  const [view, setView] = useState<View>('pnl');
  /* Whole months: the range widens to its months' first and last days. */
  const from = r.usable ? monthStart(r.from) : monthStart(r.today);
  const to = r.usable ? monthEnd(r.to) : monthEnd(r.today);
  const period = from.slice(0, 7) === to.slice(0, 7) ? monthName(from) : `${monthName(from)} – ${monthName(to)}`;
  const partMonths = r.usable && (r.from !== from || r.to !== to);
  useReportSubtitle(`Deliveries ${period}${partMonths ? ' · whole months' : ''} · by the delivery date Delivery Planning shows, else the DO date · fairs in these months`);

  return (
    <>
      <ReportToolbar>
        <FinanceDateRange label="Deliveries" />
        <ReportTool label="View"><Segmented options={VIEWS} value={view} onChange={setView} label="Logistics views" /></ReportTool>
      </ReportToolbar>
      {!r.usable && <ReportMessage>Pick dates.</ReportMessage>}
      {view === 'pnl' ? <PnlView from={from} to={to} period={period} /> : <CostViews view={view} from={from} to={to} period={period} />}
    </>
  );
};

/* ── The sheets each view exports, as the screen shows it ─────────────────── */
export function regionSheet(rows: readonly LogisticsRegionRow[], period: string): ReportSheet {
  const cells = (x: Pick<LogisticsRegionRow, 'dos' | 'valueSen' | 'ownSen' | 'threeplSen' | 'totalSen'>) =>
    [String(x.dos), x.valueSen, x.ownSen, x.threeplSen, x.totalSen, x.dos > 0 ? Math.round(x.totalSen / x.dos) : null, x.valueSen > 0 ? (x.totalSen / x.valueSen) * 100 : null];
  const total = { dos: sum(rows, (x) => x.dos), valueSen: sum(rows, (x) => x.valueSen), ownSen: sum(rows, (x) => x.ownSen), threeplSen: sum(rows, (x) => x.threeplSen), totalSen: sum(rows, (x) => x.totalSen) };
  return {
    title: 'Logistics cost · by region', subtitle: `Deliveries ${period} · RM`, meta: [{ label: 'Months', value: period }],
    tables: [{
      columns: [{ label: 'DOs', kind: 'text' }, AMOUNT_COLUMN('Goods'), AMOUNT_COLUMN('Our lorries'), AMOUNT_COLUMN('3PL'), AMOUNT_COLUMN('Total'), AMOUNT_COLUMN('Per DO'), PCT_COLUMN('% of goods')],
      rows: [
        ...rows.map((x): SheetRow => ({ kind: 'row', depth: 0, label: x.name, cells: cells(x) })),
        { kind: 'total', depth: 0, label: 'Total', cells: cells(total) },
      ],
    }],
  };
}
export function tripsSheet(rows: readonly LogisticsTripRow[], period: string): ReportSheet {
  return {
    title: 'Logistics cost · per trip', subtitle: `Deliveries ${period} · RM`, meta: [{ label: 'Months', value: period }],
    tables: [{
      columns: [{ label: 'Type', kind: 'text' }, { label: 'Lorry / 3PL', kind: 'text' }, { label: 'Bill', kind: 'text' }, { label: 'DOs', kind: 'text' }, { label: 'Regions', kind: 'text' }, AMOUNT_COLUMN('Cost')],
      rows: [
        ...rows.map((x): SheetRow => ({ kind: 'row', depth: 0, label: fmtDateOrDash(x.day), cells: [x.kind === 'own' ? 'Our lorry' : '3PL', x.who, x.ref ?? null, String(x.dos), x.regions.join(', ') || null, x.amountSen] })),
        { kind: 'total', depth: 0, label: 'Total', cells: [null, null, null, String(sum(rows, (x) => x.dos)), null, sum(rows, (x) => x.amountSen ?? 0)] },
      ],
    }],
  };
}
export function eventsSheet(rows: readonly LogisticsEventRow[], period: string): ReportSheet {
  return {
    title: 'Logistics cost · setup & dismantle', subtitle: `Fairs ${period} · RM`, meta: [{ label: 'Months', value: period }],
    tables: [{
      columns: [{ label: 'Dates', kind: 'text' }, AMOUNT_COLUMN('Setup'), AMOUNT_COLUMN('Transport setup & dismantle'), AMOUNT_COLUMN('Total')],
      rows: [
        ...rows.map((x): SheetRow => ({ kind: 'row', depth: 0, label: x.name, cells: [fmtDayMonthRange(x.startDate, x.endDate), x.setupSen, x.transportSen, x.totalSen] })),
        { kind: 'total', depth: 0, label: 'Total', cells: [null, sum(rows, (x) => x.setupSen), sum(rows, (x) => x.transportSen), sum(rows, (x) => x.totalSen)] },
      ],
    }],
  };
}

/* ── The cost views: one read of the Logistics cost report ────────────────── */
function CostViews({ view, from, to, period }: { view: Exclude<View, 'pnl'>; from: string; to: string; period: string }) {
  const q = useLogisticsCost(from, to);
  const r = q.data;

  const ownTrips = useMemo(() => (r?.trips ?? []).filter((t) => t.kind === 'own'), [r]);
  const runs = useMemo(() => (r?.trips ?? []).filter((t) => t.kind === '3pl'), [r]);
  const eventsKnown = r != null && r.eventsProblem == null;
  const months = `${from.slice(0, 7)}-${to.slice(0, 7)}`;
  const sheet = (): ReportSheet | null => {
    if (!r) return null;
    if (view === 'region') return regionSheet(r.regions, period);
    if (view === 'trips') return tripsSheet(r.trips, period);
    return r.eventsProblem ? null : eventsSheet(r.events, period);
  };
  const fileBase = `logistics-${view === 'region' ? 'by-region' : view === 'trips' ? 'per-trip' : 'setup-dismantle'}-${months}`;

  const t = r?.totals ?? null;
  const tiles: ReportTile[] = t ? [
    { key: 'dos', label: 'Deliveries (DOs)', value: t.dos.toLocaleString('en-MY'), sub: `Goods RM ${tileRm(t.valueSen)}` },
    { key: 'cost', label: 'Delivery cost', value: tileRm(t.totalSen), sub: `${t.dos > 0 ? `RM ${tileRm(t.totalSen / t.dos)} per DO` : '—'} · ${pct(t.totalSen, t.valueSen)} of goods` },
    { key: 'own', label: 'Our lorries', value: tileRm(t.ownSen), sub: `${ownTrips.length} trip${ownTrips.length === 1 ? '' : 's'}${ownTrips.length > 0 ? ` · RM ${tileRm(t.ownSen / ownTrips.length)} each` : ''}` },
    { key: '3pl', label: '3PL', value: tileRm(t.threeplSen), sub: `${runs.length} bill line${runs.length === 1 ? '' : 's'}` },
    {
      key: 'setup', label: 'Setup & Dismantle', value: eventsKnown ? tileRm(t.setupSen + t.transportSen) : '—',
      sub: eventsKnown ? `${r.events.length} fair${r.events.length === 1 ? '' : 's'}` : 'could not be read', tone: eventsKnown ? 'plain' : 'late',
    },
  ] : [];

  return (
    <>
      <ReportHeaderActions><ReportExports sheet={sheet} fileBase={fileBase} /></ReportHeaderActions>
      <ReportTiles tiles={tiles.length > 0 ? tiles : ['Deliveries (DOs)', 'Delivery cost', 'Our lorries', '3PL', 'Setup & Dismantle'].map((label) => ({ key: label, label, value: '' }))}
        label="Logistics totals" pending={!r} />

      {q.isError && <ReportMessage tone="error">The report could not be read — {q.error instanceof Error ? q.error.message : String(q.error)}</ReportMessage>}
      {r && <NotCounted report={r} />}

      {view === 'region' && <RegionView rows={r?.regions ?? null} loading={q.isLoading} noState={r?.gaps.dosNoState ?? 0} />}
      {view === 'trips' && <TripsView rows={r?.trips ?? null} loading={q.isLoading} />}
      {view === 'events' && <EventsView rows={r?.events ?? null} loading={q.isLoading} problem={r?.eventsProblem ?? null} />}
    </>
  );
}

/* ── What could not be counted ─────────────────────────────────────────────── */
function NotCounted({ report }: { report: LogisticsReport }) {
  const g = report.gaps;
  const lines: string[] = [];
  if (g.dosNoDeliverer > 0) lines.push(`${g.dosNoDeliverer} DO${g.dosNoDeliverer === 1 ? ' has' : 's have'} nobody on ${g.dosNoDeliverer === 1 ? 'it' : 'them'} — no lorry picked and no 3PL bill. Pick the lorry in Delivery Planning.`);
  if (g.dosOutsideNoBill > 0) lines.push(`${g.dosOutsideNoBill} DO${g.dosOutsideNoBill === 1 ? '' : 's'} went on an outside lorry that no 3PL bill names yet.`);
  if (g.unlistedPlates.length > 0) lines.push(`Plates not on the lorry list: ${g.unlistedPlates.join(', ')} — not counted as ours.`);
  if (g.openLines.count > 0) lines.push(`${g.openLines.count} 3PL bill line${g.openLines.count === 1 ? '' : 's'} not assigned yet (RM ${fmtRm(g.openLines.sen)}) — Delivery Rate Cards › 3PL invoices.`);
  if (g.eventLinesNoFair.count > 0) lines.push(`${g.eventLinesNoFair.count} setup / dismantle line${g.eventLinesNoFair.count === 1 ? '' : 's'} on 3PL bills with no fair picked (RM ${fmtRm(g.eventLinesNoFair.sen)}).`);
  for (const m of g.monthsWithoutTrips) {
    const cost = report.months.find((x) => x.month === m)?.ownCostSen ?? 0;
    lines.push(`${m}: our lorries' cost RM ${fmtRm(cost)} is booked but no trip is recorded, so it is not shared to any DO.`);
  }
  if (report.eventsProblem) lines.push(`Setup & Dismantle could not be read — ${report.eventsProblem}.`);
  if (lines.length === 0) return null;
  return (
    <section className={s.notCounted} aria-label="Not counted">
      <h3 className={s.notCountedTitle}>Not counted</h3>
      <ul>{lines.map((l) => <li key={l}>{l}</li>)}</ul>
    </section>
  );
}

/* ── By region — the four the books split transport by (2026-10-29): Penang
   900-T005, KL 900-T006, SBH & SWK 900-T007, SGD 900-T027 … T029. ─────────── */
function RegionView({ rows, loading, noState }: { rows: LogisticsRegionRow[] | null; loading: boolean; noState: number }) {
  const columns = useMemo<Column<LogisticsRegionRow>[]>(() => [
    {
      key: 'zone', label: 'Region', getValue: (x) => x.name, total: () => 'Total',
      render: (x) => (
        <span className={s.region}>
          <span>{x.name}</span>
          <span className={s.regionCovers}>{x.covers}</span>
        </span>
      ),
    },
    { key: 'dos', label: 'DOs', align: 'right', getValue: (x) => x.dos, render: (x) => <Num>{x.dos}</Num>, total: (rs) => <Num>{sum(rs, (x) => x.dos)}</Num> },
    money('value', 'Goods (RM)', (x) => x.valueSen),
    money('own', 'Our lorries (RM)', (x) => x.ownSen),
    money('threepl', '3PL (RM)', (x) => x.threeplSen),
    money('total', 'Total (RM)', (x) => x.totalSen),
    {
      key: 'perDo', label: 'Per DO (RM)', align: 'right', getValue: (x) => (x.dos > 0 ? x.totalSen / x.dos : 0),
      render: (x) => <Num>{x.dos > 0 ? fmtRm(Math.round(x.totalSen / x.dos)) : '—'}</Num>,
      total: (rs) => { const d = sum(rs, (x) => x.dos); return <Num>{d > 0 ? fmtRm(Math.round(sum(rs, (x) => x.totalSen) / d)) : '—'}</Num>; },
    },
    {
      key: 'value_pct', label: '% of goods', align: 'right', getValue: (x) => (x.valueSen > 0 ? x.totalSen / x.valueSen : 0),
      render: (x) => <Num>{pct(x.totalSen, x.valueSen)}</Num>,
      total: (rs) => <Num>{pct(sum(rs, (x) => x.totalSen), sum(rs, (x) => x.valueSen))}</Num>,
    },
  ], []);
  return (
    <>
      <DataTable<LogisticsRegionRow> tableId="logistics-by-region" exportName="logistics-by-region" exportXlsx
        columns={columns} rows={rows} loading={loading} getRowKey={(x) => x.code}
        emptyLabel="No DO goes out in these months." />
      {noState > 0 && <p className={s.hint}>KL includes {noState} DO{noState === 1 ? '' : 's'} with no state on {noState === 1 ? 'it' : 'them'} (others). A Singapore address is read from its postcode or the word Singapore.</p>}
    </>
  );
}

function money<T>(key: string, label: string, of: (x: T) => number): Column<T> {
  return {
    key, label, align: 'right', getValue: of, exportValue: (x) => of(x) / 100, exportFormat: 'money',
    render: (x) => <Num>{fmtRm(of(x))}</Num>, total: (rs) => <Num>{fmtRm(sum(rs, of))}</Num>,
  };
}

/* ── Per trip ──────────────────────────────────────────────────────────────── */
function TripsView({ rows, loading }: { rows: LogisticsTripRow[] | null; loading: boolean }) {
  const columns = useMemo<Column<LogisticsTripRow>[]>(() => [
    { key: 'day', label: 'Date', getValue: (x) => x.day, render: (x) => fmtDateOrDash(x.day), exportFormat: 'date', total: () => 'Total' },
    { key: 'kind', label: 'Type', getValue: (x) => (x.kind === 'own' ? 'Our lorry' : '3PL'), render: (x) => (x.kind === 'own' ? 'Our lorry' : '3PL') },
    { key: 'who', label: 'Lorry / 3PL', getValue: (x) => x.who, render: (x) => x.who },
    { key: 'ref', label: 'Bill', getValue: (x) => x.ref ?? '', render: (x) => x.ref ?? '—' },
    {
      key: 'dos', label: 'DOs', align: 'right', getValue: (x) => x.dos,
      render: (x) => <span title={x.doNumbers.join(', ')} className={s.num}>{x.dos}</span>, total: (rs) => <Num>{sum(rs, (x) => x.dos)}</Num>,
    },
    { key: 'route', label: 'Regions', getValue: (x) => x.regions.join(', '), render: (x) => x.regions.join(', ') || '—' },
    {
      key: 'amount', label: 'Cost (RM)', align: 'right', getValue: (x) => x.amountSen ?? 0, exportValue: (x) => (x.amountSen == null ? null : x.amountSen / 100), exportFormat: 'money',
      render: (x) => <Num>{x.amountSen == null ? <span title="This month has no lorry cost to share yet">—</span> : fmtRm(x.amountSen)}</Num>,
      total: (rs) => <Num>{fmtRm(sum(rs, (x) => x.amountSen ?? 0))}</Num>,
    },
  ], []);
  return (
    <>
      <p className={s.hint}>A trip of ours is one lorry on one day; it costs the month&rsquo;s lorry cost ÷ the month&rsquo;s trips. A 3PL run is one line of the carrier&rsquo;s bill.</p>
      <DataTable<LogisticsTripRow> tableId="logistics-per-trip" exportName="logistics-per-trip" exportXlsx
        columns={columns} rows={rows} loading={loading} getRowKey={(x) => `${x.kind}|${x.day}|${x.who}|${x.ref ?? ''}|${x.doNumbers.join(',')}`}
        emptyLabel="No trip in these months." />
    </>
  );
}

/* ── Setup & Dismantle ─────────────────────────────────────────────────────── */
function EventsView({ rows, loading, problem }: { rows: LogisticsEventRow[] | null; loading: boolean; problem: string | null }) {
  const columns = useMemo<Column<LogisticsEventRow>[]>(() => [
    { key: 'project', label: 'Fair', getValue: (x) => x.name, render: (x) => x.name, total: () => 'Total' },
    { key: 'dates', label: 'Dates', getValue: (x) => x.startDate ?? '', render: (x) => fmtDayMonthRange(x.startDate, x.endDate) },
    money('setup', 'Setup (RM)', (x) => x.setupSen),
    money('transport', 'Transport setup & dismantle (RM)', (x) => x.transportSen),
    money('total', 'Total (RM)', (x) => x.totalSen),
  ], []);
  if (problem) return <ReportMessage tone="error">The fairs&rsquo; books could not be read — {problem}.</ReportMessage>;
  return (
    <>
      <p className={s.hint}>Each fair&rsquo;s own books — the Setup and Transport Setup &amp; Dismantle rows Project Overview shows. Fairs with nothing booked are left out.</p>
      <DataTable<LogisticsEventRow> tableId="logistics-setup-dismantle" exportName="logistics-setup-dismantle" exportXlsx
        columns={columns} rows={rows} loading={loading} getRowKey={(x) => String(x.id)}
        emptyLabel="No fair starting in these months has setup or dismantle booked." />
    </>
  );
}
