// ----------------------------------------------------------------------------
// LogisticsCost — the Logistics cost tab (owner 2026-10-29: 物流报告 按地区、每趟、
// setup & dismantle —「都需要」; 自己罗厘的成本（油、过路费、司机）也要算 →「那就
// 先算 overall … trip 除成本」). What getting goods to customers and fairs cost in
// the chosen months:
//   • By region — the DOs that went out, what they carried, our lorries' share
//     and the 3PL bills, per delivery-planning region;
//   • Per trip — each trip of ours (one lorry, one day) at the month's lorry cost
//     ÷ the month's trips, and each 3PL run (one bill line);
//   • Setup & Dismantle — each fair's booth setup and its transport, from its
//     own books (the rows Project Overview shows);
//   • Own-lorry cost — what the ticked accounts booked each month, the trips, one
//     trip's cost, and the tick list itself (Finance).
// What could not be counted is said above the views, never folded into a zero.
// Server: backend/src/scm/routes/acc-logistics.ts.
// ----------------------------------------------------------------------------

import { useEffect, useMemo, useState } from 'react';
import { Button } from '@2990s/design-system';
import { StatCard } from '../../components/StatCard';
import { DataTable, type Column } from '../../components/DataTable';
import { fmtDayMonthRange, fmtDateOrDash } from '../../vendor/shared/format';
import {
  useLogisticsCost, useLogisticsSettings, useSaveLogisticsSettings,
  type LogisticsEventRow, type LogisticsMonthRow, type LogisticsRegionRow, type LogisticsReport, type LogisticsTripRow,
} from '../../vendor/scm/lib/logistics-queries';

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

type View = 'region' | 'trips' | 'events' | 'own';
const VIEWS: Array<{ key: View; text: string }> = [
  { key: 'region', text: 'By region' },
  { key: 'trips', text: 'Per trip' },
  { key: 'events', text: 'Setup & Dismantle' },
  { key: 'own', text: 'Own-lorry cost' },
];

export const LogisticsCostTab = () => {
  const [fromMonth, setFromMonth] = useState(myt().slice(0, 7));
  const [toMonth, setToMonth] = useState(myt().slice(0, 7));
  const [view, setView] = useState<View>('region');
  const q = useLogisticsCost(firstDay(fromMonth), lastDay(fromMonth > toMonth ? fromMonth : toMonth));
  const r = q.data;

  const ownTrips = useMemo(() => (r?.trips ?? []).filter((t) => t.kind === 'own'), [r]);
  const runs = useMemo(() => (r?.trips ?? []).filter((t) => t.kind === '3pl'), [r]);
  const t = r?.totals;
  const eventsKnown = r != null && r.eventsProblem == null;

  return (
    <div className="space-y-3">
      <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={soft}>Deliveries from</span>
        <input type="month" value={fromMonth} onChange={(e) => { if (e.target.value) setFromMonth(e.target.value); }} aria-label="From month" style={{ padding: '4px 6px', fontSize: 'var(--fs-12)' }} />
        <span style={soft}>to</span>
        <input type="month" value={toMonth} onChange={(e) => { if (e.target.value) setToMonth(e.target.value); }} aria-label="To month" style={{ padding: '4px 6px', fontSize: 'var(--fs-12)' }} />
        <span style={soft}>· by the delivery date Delivery Planning shows, else the DO date · fairs starting in these months</span>
      </div>

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

      {view === 'region' && <RegionView rows={r?.regions ?? null} loading={q.isLoading} />}
      {view === 'trips' && <TripsView rows={r?.trips ?? null} loading={q.isLoading} />}
      {view === 'events' && <EventsView rows={r?.events ?? null} loading={q.isLoading} problem={r?.eventsProblem ?? null} />}
      {view === 'own' && <OwnView rows={r?.months ?? null} loading={q.isLoading} accounts={r?.ownCostAccounts ?? []} isDefault={r?.ownCostDefault ?? true} />}
    </div>
  );
};

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

/* ── By region ─────────────────────────────────────────────────────────────── */
function RegionView({ rows, loading }: { rows: LogisticsRegionRow[] | null; loading: boolean }) {
  const columns = useMemo<Column<LogisticsRegionRow>[]>(() => [
    { key: 'region', label: 'Region', getValue: (x) => x.name, render: (x) => x.name, total: () => 'Total' },
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
      key: 'pct', label: '% of goods', align: 'right', getValue: (x) => (x.valueSen > 0 ? x.totalSen / x.valueSen : 0),
      render: (x) => <Num>{pct(x.totalSen, x.valueSen)}</Num>,
      total: (rs) => <Num>{pct(sum(rs, (x) => x.totalSen), sum(rs, (x) => x.valueSen))}</Num>,
    },
  ], []);
  return (
    <DataTable<LogisticsRegionRow> tableId="logistics-by-region" exportName="logistics-by-region" exportXlsx
      columns={columns} rows={rows} loading={loading} getRowKey={(x) => x.code}
      emptyLabel="No DO goes out in these months." />
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
    { key: 'regions', label: 'Regions', getValue: (x) => x.regions.join(', '), render: (x) => x.regions.join(', ') || '—' },
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
    { key: 'fair', label: 'Fair', getValue: (x) => x.name, render: (x) => x.name, total: () => 'Total' },
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

/* ── Own-lorry cost, and the accounts it is read from ─────────────────────── */
function OwnView({ rows, loading, accounts, isDefault }: { rows: LogisticsMonthRow[] | null; loading: boolean; accounts: string[]; isDefault: boolean }) {
  const columns = useMemo<Column<LogisticsMonthRow>[]>(() => [
    { key: 'month', label: 'Month', getValue: (x) => x.month, render: (x) => x.month, total: () => 'Total' },
    money('cost', 'Cost booked (RM)', (x) => x.ownCostSen),
    { key: 'trips', label: 'Trips', align: 'right', getValue: (x) => x.trips, render: (x) => <Num>{x.trips}</Num>, total: (rs) => <Num>{sum(rs, (x) => x.trips)}</Num> },
    {
      key: 'perTrip', label: 'Per trip (RM)', align: 'right', getValue: (x) => x.perTripSen ?? 0, exportValue: (x) => (x.perTripSen == null ? null : x.perTripSen / 100), exportFormat: 'money',
      render: (x) => <Num>{x.perTripSen == null ? '—' : fmtRm(x.perTripSen)}</Num>,
    },
    { key: 'accounts', label: 'Booked on', getValue: (x) => x.accounts.map((a) => a.code).join(', '), render: (x) => x.accounts.map((a) => `${a.code} ${fmtRm(a.sen)}`).join(' · ') || '—' },
  ], []);
  return (
    <>
      <div style={soft}>
        Overall: each month&rsquo;s cost on the accounts below ÷ that month&rsquo;s trips of our lorries.
        {' '}{isDefault ? 'The accounts are the chart’s default — every expense account naming a lorry or one of our plates.' : 'The accounts are Finance’s own list.'}
        {' '}Reading: {accounts.length > 0 ? accounts.join(', ') : 'none'}.
      </div>
      <DataTable<LogisticsMonthRow> tableId="logistics-own-cost" exportName="logistics-own-cost" exportXlsx
        columns={columns} rows={rows} loading={loading} getRowKey={(x) => x.month} emptyLabel="No month chosen." />
      <CostAccountsCard />
    </>
  );
}

function CostAccountsCard() {
  const s = useLogisticsSettings();
  const save = useSaveLogisticsSettings();
  const [ticked, setTicked] = useState<Set<string> | null>(null);
  const [find, setFind] = useState('');
  const current = useMemo(() => new Set(s.data?.picked ?? s.data?.defaults ?? []), [s.data]);
  /* A fresh read (another tab saved) resets an untouched list. */
  useEffect(() => { setTicked(null); }, [s.data]);
  const shown = ticked ?? current;
  const dirty = ticked != null && (ticked.size !== current.size || [...ticked].some((x) => !current.has(x)));
  const needle = find.trim().toLowerCase();
  const list = (s.data?.candidates ?? []).filter((a) => !needle || `${a.code} ${a.name ?? ''}`.toLowerCase().includes(needle));
  const flip = (code: string) => setTicked((prev) => {
    const next = new Set(prev ?? current);
    if (next.has(code)) next.delete(code); else next.add(code);
    return next;
  });

  return (
    <section style={card} aria-label="Own-lorry cost accounts">
      <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'baseline', flexWrap: 'wrap' }}>
        <b style={{ fontSize: 'var(--fs-13)' }}>Own-lorry cost accounts</b>
        <span style={soft}>
          {s.data?.picked ? 'Finance’s own list.' : 'Using the chart’s default.'} Tick a driver salary account here once there is one — it then counts in every trip.
        </span>
      </div>
      {s.isError && <div style={{ ...soft, color: warn }}>The accounts could not be read.</div>}
      <input type="search" value={find} onChange={(e) => setFind(e.target.value)} placeholder="Find an account" aria-label="Find an account"
        style={{ margin: 'var(--space-2) 0', padding: '4px 8px', fontSize: 'var(--fs-12)', minWidth: 220 }} />
      <div style={{ maxHeight: 260, overflowY: 'auto', display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '2px 16px' }}>
        {list.map((a) => (
          <label key={a.code} style={{ display: 'flex', gap: 6, alignItems: 'flex-start', fontSize: 'var(--fs-12)' }}>
            <input type="checkbox" checked={shown.has(a.code)} onChange={() => flip(a.code)} aria-label={`${a.code} ${a.name ?? ''}`} />
            <span><span style={{ fontFamily: 'var(--font-mono)' }}>{a.code}</span><br />{a.name ?? ''}</span>
          </label>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', marginTop: 'var(--space-2)', flexWrap: 'wrap' }}>
        <Button size="sm" disabled={!dirty || save.isPending} onClick={() => save.mutate([...shown].sort(), { onSuccess: () => setTicked(null) })}>
          {save.isPending ? 'Saving…' : 'Save the list'}
        </Button>
        {s.data?.picked && (
          <Button size="sm" variant="ghost" disabled={save.isPending} onClick={() => save.mutate(null, { onSuccess: () => setTicked(null) })}>
            Back to the default
          </Button>
        )}
        {save.isError && <span style={{ ...soft, color: warn }}>{save.error instanceof Error ? save.error.message : 'Not saved.'}</span>}
      </div>
    </section>
  );
}
