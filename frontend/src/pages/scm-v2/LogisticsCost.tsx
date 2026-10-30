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
// ----------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import { StatCard } from '../../components/StatCard';
import { DataTable, type Column } from '../../components/DataTable';
import { fmtDayMonthRange, fmtDateOrDash } from '../../vendor/shared/format';
import {
  useLogisticsCost,
  type LogisticsEventRow, type LogisticsRegionRow, type LogisticsReport, type LogisticsTripRow,
} from '../../vendor/scm/lib/logistics-queries';
import { PnlView } from './LogisticsPnl';

const myt = (): string => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
const firstDay = (month: string): string => `${month}-01`;
const lastDay = (month: string): string => {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y!, m!, 0)).toISOString().slice(0, 10);
};

const soft: React.CSSProperties = { fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' };
const card: React.CSSProperties = { background: 'var(--c-paper, #fff)', border: '1px solid var(--border-weak, #e3e1da)', borderRadius: 8, padding: 'var(--space-3)' };
const num: React.CSSProperties = { textAlign: 'right', fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };
const warn = 'var(--c-festive-b, #B8331F)';

/** Table money: 1,234.56 (the header says RM); a negative in brackets. */
export const fmtRm = (sen: number): string => {
  const text = (Math.abs(sen) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return sen < 0 ? `(${text})` : text;
};
/** Card money: whole ringgit. */
const cardRm = (sen: number): string => `RM ${Math.round(sen / 100).toLocaleString('en-MY')}`;
const pct = (part: number, whole: number): string => (whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : '—');
const sum = <T,>(rows: readonly T[], f: (r: T) => number): number => rows.reduce((s, r) => s + f(r), 0);
const Num = ({ children }: { children: React.ReactNode }) => <span style={num}>{children}</span>;

type View = 'pnl' | 'region' | 'trips' | 'events';
const VIEWS: Array<{ key: View; text: string }> = [
  { key: 'pnl', text: 'P&L' },
  { key: 'region', text: 'By region' },
  { key: 'trips', text: 'Per trip' },
  { key: 'events', text: 'Setup & Dismantle' },
];

export const LogisticsCostTab = () => {
  const [fromMonth, setFromMonth] = useState(myt().slice(0, 7));
  const [toMonth, setToMonth] = useState(myt().slice(0, 7));
  const [view, setView] = useState<View>('pnl');
  const from = firstDay(fromMonth);
  const to = lastDay(fromMonth > toMonth ? fromMonth : toMonth);

  return (
    <div className="space-y-3">
      <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={soft}>Deliveries from</span>
        <input type="month" value={fromMonth} onChange={(e) => { if (e.target.value) setFromMonth(e.target.value); }} aria-label="From month" style={{ padding: '4px 6px', fontSize: 'var(--fs-12)' }} />
        <span style={soft}>to</span>
        <input type="month" value={toMonth} onChange={(e) => { if (e.target.value) setToMonth(e.target.value); }} aria-label="To month" style={{ padding: '4px 6px', fontSize: 'var(--fs-12)' }} />
        <span style={soft}>· by the delivery date Delivery Planning shows, else the DO date · fairs in these months</span>
      </div>

      <div role="tablist" aria-label="Logistics views" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {VIEWS.map((v) => (
          <button key={v.key} type="button" role="tab" aria-selected={view === v.key} onClick={() => setView(v.key)}
            style={{
              padding: '4px 12px', borderRadius: 999, fontSize: 'var(--fs-13)', cursor: 'pointer',
              border: '1px solid var(--border-weak, #e3e1da)',
              background: view === v.key ? 'var(--c-ink)' : 'transparent', color: view === v.key ? 'var(--c-cream)' : 'var(--c-ink)',
            }}>
            {v.text}
          </button>
        ))}
      </div>

      {view === 'pnl' ? <PnlView from={from} to={to} /> : <CostViews view={view} from={from} to={to} />}
    </div>
  );
};

/* ── The cost views: one read of the Logistics cost report ────────────────── */
function CostViews({ view, from, to }: { view: Exclude<View, 'pnl'>; from: string; to: string }) {
  const q = useLogisticsCost(from, to);
  const r = q.data;

  const ownTrips = useMemo(() => (r?.trips ?? []).filter((t) => t.kind === 'own'), [r]);
  const runs = useMemo(() => (r?.trips ?? []).filter((t) => t.kind === '3pl'), [r]);
  const t = r?.totals;
  const eventsKnown = r != null && r.eventsProblem == null;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5" aria-label="Logistics totals">
        <StatCard label="Deliveries (DOs)" pending={!r} value={t ? t.dos.toLocaleString('en-MY') : ''} subtitle={t ? `Goods ${cardRm(t.valueSen)}` : undefined} />
        <StatCard label="Delivery cost" pending={!r} value={t ? cardRm(t.totalSen) : ''}
          subtitle={t ? `${t.dos > 0 ? `${cardRm(t.totalSen / t.dos)} per DO` : '—'} · ${pct(t.totalSen, t.valueSen)} of goods` : undefined} />
        <StatCard label="Our lorries" pending={!r} value={t ? cardRm(t.ownSen) : ''}
          subtitle={r ? `${ownTrips.length} trip${ownTrips.length === 1 ? '' : 's'}${ownTrips.length > 0 ? ` · ${cardRm(t!.ownSen / ownTrips.length)} each` : ''}` : undefined} />
        <StatCard label="3PL" pending={!r} value={t ? cardRm(t.threeplSen) : ''} subtitle={r ? `${runs.length} bill line${runs.length === 1 ? '' : 's'}` : undefined} />
        <StatCard label="Setup & Dismantle" pending={!eventsKnown} value={t && eventsKnown ? cardRm(t.setupSen + t.transportSen) : ''}
          subtitle={r ? (eventsKnown ? `${r.events.length} fair${r.events.length === 1 ? '' : 's'}` : 'could not be read') : undefined} />
      </div>

      {q.isError && <div style={{ ...soft, color: warn }}>The report could not be read — {q.error instanceof Error ? q.error.message : String(q.error)}</div>}
      {r && <NotCounted report={r} />}

      {view === 'region' && <RegionView rows={r?.regions ?? null} loading={q.isLoading} noState={r?.gaps.dosNoState ?? 0} />}
      {view === 'trips' && <TripsView rows={r?.trips ?? null} loading={q.isLoading} />}
      {view === 'events' && <EventsView rows={r?.events ?? null} loading={q.isLoading} problem={r?.eventsProblem ?? null} />}
    </div>
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
    <div style={{ ...card, borderColor: warn }} aria-label="Not counted">
      <b style={{ color: warn, fontSize: 'var(--fs-13)' }}>Not counted</b>
      <ul style={{ margin: '4px 0 0 18px', padding: 0, fontSize: 'var(--fs-13)' }}>
        {lines.map((l) => <li key={l}>{l}</li>)}
      </ul>
    </div>
  );
}

/* ── By region — the four the books split transport by (2026-10-29): Penang
   900-T005, KL 900-T006, SBH & SWK 900-T007, SGD 900-T027 … T029. ─────────── */
function RegionView({ rows, loading, noState }: { rows: LogisticsRegionRow[] | null; loading: boolean; noState: number }) {
  const columns = useMemo<Column<LogisticsRegionRow>[]>(() => [
    {
      key: 'zone', label: 'Region', getValue: (x) => x.name, total: () => 'Total',
      render: (x) => (
        <span style={{ display: 'inline-flex', flexDirection: 'column' }}>
          <span>{x.name}</span>
          <span style={{ ...soft, fontSize: 'var(--fs-11)' }}>{x.covers}</span>
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
      {noState > 0 && <div style={soft}>KL includes {noState} DO{noState === 1 ? '' : 's'} with no state on {noState === 1 ? 'it' : 'them'} (others). A Singapore address is read from its postcode or the word Singapore.</div>}
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
      render: (x) => <span title={x.doNumbers.join(', ')} style={num}>{x.dos}</span>, total: (rs) => <Num>{sum(rs, (x) => x.dos)}</Num>,
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
      <div style={soft}>A trip of ours is one lorry on one day; it costs the month&rsquo;s lorry cost ÷ the month&rsquo;s trips. A 3PL run is one line of the carrier&rsquo;s bill.</div>
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
  if (problem) return <div style={{ ...soft, color: warn }}>The fairs&rsquo; books could not be read — {problem}.</div>;
  return (
    <>
      <div style={soft}>Each fair&rsquo;s own books — the Setup and Transport Setup &amp; Dismantle rows Project Overview shows. Fairs with nothing booked are left out.</div>
      <DataTable<LogisticsEventRow> tableId="logistics-setup-dismantle" exportName="logistics-setup-dismantle" exportXlsx
        columns={columns} rows={rows} loading={loading} getRowKey={(x) => String(x.id)}
        emptyLabel="No fair starting in these months has setup or dismantle booked." />
    </>
  );
}
