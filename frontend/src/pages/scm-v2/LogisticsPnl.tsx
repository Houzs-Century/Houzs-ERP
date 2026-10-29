// ----------------------------------------------------------------------------
// LogisticsPnl — the Logistics cost tab's P&L view: the owner's own Logistic Cost
// Report ("Logistic - Auto" sheet), built from the books instead of typed (owner
// 2026-10-29, 做 —「不要我填」). Penang / KL / SBH & SWK / SGD, then everything it
// counted, each with the one thing Finance keeps on it (which account feeds which
// row is the Chart of Accounts' Logistics column):
//   • the setup / dismantle trips (tick or untick one) and the rate per trip by
//     area (「我要自己能维护」);
//   • the upkeep and insurance bills, each spread over its own months
//     (「根据情况定的，这个我可以自己定」);
//   • the Other Debtor bill lines counted as transport income;
//   • the share of the DOs' value counted as transport income (3% to start).
// Server: backend/src/scm/routes/acc-logistics-pnl.ts.
// ----------------------------------------------------------------------------

import { useEffect, useState } from 'react';
import { Button } from '@2990s/design-system';
import { StatCard } from '../../components/StatCard';
import { fmtDateOrDash } from '../../vendor/shared/format';
import { AccountCell } from './JournalEntryCards';
import {
  useLogisticsPnl, useSaveAreaRate, useSaveIncomeRate, useSaveSpread, useSaveTripMark,
  type LogisticsAreaRate, type LogisticsPnl, type LogisticsPnlRow, type LogisticsSetupTrip, type LogisticsSpreadRow, type PnlRegion,
} from '../../vendor/scm/lib/logistics-queries';

const REGIONS: Array<{ code: PnlRegion; name: string }> = [
  { code: 'PG', name: 'Penang' }, { code: 'KL', name: 'KL' }, { code: 'EM', name: 'SBH & SWK' }, { code: 'SG', name: 'SGD' },
];
const ROW_OF: Record<string, string> = { houzs: 'Houzs', conts: 'The Conts', hookka: 'Hookka', '2990': '2990' };
const regionName = (code: PnlRegion): string => REGIONS.find((r) => r.code === code)!.name;

const soft: React.CSSProperties = { fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' };
const card: React.CSSProperties = { background: 'var(--c-paper, #fff)', border: '1px solid var(--border-weak, #e3e1da)', borderRadius: 8, padding: 'var(--space-3)' };
const num: React.CSSProperties = { textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };
const th: React.CSSProperties = {
  padding: '6px 8px', fontSize: 'var(--fs-11)', fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase',
  color: 'var(--fg-muted)', borderBottom: '1px solid var(--border-weak, #e3e1da)', whiteSpace: 'nowrap', textAlign: 'left',
};
const td: React.CSSProperties = { padding: '5px 8px', borderBottom: '1px solid var(--border-weak, #efede6)', verticalAlign: 'top' };
const warn = 'var(--c-festive-b, #B8331F)';
const input: React.CSSProperties = { padding: '2px 6px', fontSize: 'var(--fs-12)', width: 84, textAlign: 'right' };

/** Whole ringgit, a negative in brackets — the P&L reads like the owner's sheet. */
const whole = (sen: number | null): string => {
  if (sen == null) return '—';
  const text = Math.round(Math.abs(sen) / 100).toLocaleString('en-MY');
  return sen < 0 ? `(${text})` : text;
};
/** Ringgit and sen, for a bill or a rate. */
const rm2 = (sen: number | null): string => (sen == null ? '—' : (sen / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const cardRm = (sen: number): string => `${sen < 0 ? '−' : ''}RM ${Math.round(Math.abs(sen) / 100).toLocaleString('en-MY')}`;
const pctOf = (part: number | null, whole_: number): string => (part == null || whole_ <= 0 ? '' : `${((part / whole_) * 100).toFixed(1)}%`);

/* Rows the sheet groups, set in from their heading; rows it closes with, in bold. */
const INCOME_LINES = new Set(['ti_houzs', 'ti_conts', 'ti_hookka', 'sd_income', 'ti_2990']);
const IN_HOUSE_LINES = new Set(['petrol', 'upkeep', 'instalment', 'roadtax', 'manpower', 'other_lorry']);
const BOLD = new Set(['total_income', 'total_expense', 'net']);
const PER_DO = new Set(['cost_per_do', 'net_cost_per_do']);

export function PnlView({ from, to }: { from: string; to: string }) {
  const q = useLogisticsPnl(from, to);
  const p = q.data;
  if (q.isError) return <div style={{ ...soft, color: warn }}>The P&amp;L could not be read — {q.error instanceof Error ? q.error.message : String(q.error)}</div>;
  const row = (k: string) => p?.rows.find((r) => r.key === k) ?? null;
  const income = row('total_income')?.totalSen ?? 0;
  const expense = row('total_expense')?.totalSen ?? 0;
  const net = row('net')?.totalSen ?? 0;
  const perDo = row('cost_per_do')?.totalSen ?? null;
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4" aria-label="P&L totals">
        <StatCard label="Total income" pending={!p} value={p ? cardRm(income) : ''} subtitle={p ? `${pctOf(income, row('do_value')?.totalSen ?? 0) || '—'} of DO value` : undefined} />
        <StatCard label="Total expense" pending={!p} value={p ? cardRm(expense) : ''} subtitle={p ? `${pctOf(expense, row('do_value')?.totalSen ?? 0) || '—'} of DO value` : undefined} />
        <StatCard label="Net profit" pending={!p} tone={!p ? 'default' : net < 0 ? 'error' : 'success'} value={p ? cardRm(net) : ''}
          subtitle={p ? (net < 0 ? '▼ logistics cost more than it earned' : '▲ logistics earned more than it cost') : undefined} />
        <StatCard label="Cost per DO" pending={!p} value={p ? (perDo == null ? '—' : cardRm(perDo)) : ''} subtitle={p ? `${p.dos.total.toLocaleString('en-MY')} DOs` : undefined} />
      </div>
      {p ? <PnlTable p={p} /> : <div style={soft}>{q.isLoading ? 'Reading the books…' : ''}</div>}
      {p && (
        <>
          <TripsCard p={p} />
          <AreaRatesCard rates={p.areaRates} />
          <SpreadsCard rows={p.spreads} />
          <IncomeCard p={p} />
        </>
      )}
    </div>
  );
}

/* ── The P&L ───────────────────────────────────────────────────────────────── */
function PnlTable({ p }: { p: LogisticsPnl }) {
  const doValue = p.rows.find((r) => r.key === 'do_value')!;
  const first = (k: string) => k === 'ti_houzs' || k === 'petrol';
  return (
    <section style={card} aria-label="Logistics P&L">
      <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'baseline', flexWrap: 'wrap', marginBottom: 'var(--space-2)' }}>
        <b style={{ fontSize: 'var(--fs-13)' }}>Logistic cost report (RM)</b>
        <span style={soft}>{p.months.length === 1 ? p.months[0] : `${p.months[0]} to ${p.months[p.months.length - 1]}`} · in-house costs sit in KL, as on the sheet</span>
        <IncomeRateBox bp={p.doIncomeBp} />
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 'var(--fs-13)' }}>
          <thead>
            <tr>
              <th style={th}>Category</th>
              {REGIONS.map((r) => <th key={r.code} style={{ ...th, ...num }}>{r.name}</th>)}
              <th style={{ ...th, ...num }}>Total</th>
              <th style={{ ...th, ...num }}>% of DO</th>
            </tr>
          </thead>
          <tbody>
            {p.rows.map((r) => (
              <PnlLine key={r.key} r={r} doValue={doValue} heading={first(r.key) ? (r.key === 'petrol' ? 'In-house expense' : 'Income') : null}
                dos={r.key === 'do_value' ? p.dos : null} />
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ ...soft, marginTop: 'var(--space-2)' }}>
        {p.ownTrips > 0
          ? `In-house cost per trip: RM ${whole(p.inHousePerTripSen)} — ${p.ownTrips} trip${p.ownTrips === 1 ? '' : 's'} of our lorries (one lorry, one day).`
          : 'No trip of our lorries is recorded in these months, so there is no in-house cost per trip — pick the lorry on the DOs in Delivery Planning.'}
        {' '}Which account feeds which row: Chart of Accounts › Logistics column.
      </div>
    </section>
  );
}

function PnlLine({ r, doValue, heading, dos }: { r: LogisticsPnlRow; doValue: LogisticsPnlRow; heading: string | null; dos: LogisticsPnl['dos'] | null }) {
  const indent = INCOME_LINES.has(r.key) || IN_HOUSE_LINES.has(r.key);
  const bold = BOLD.has(r.key);
  const per = PER_DO.has(r.key);
  const tone = r.key === 'net' && r.totalSen != null ? (r.totalSen < 0 ? 'text-err' : 'text-synced') : undefined;
  const cell: React.CSSProperties = { ...td, ...num, fontWeight: bold ? 650 : undefined, color: per ? 'var(--fg-muted)' : undefined };
  return (
    <>
      {heading && (
        <tr><td colSpan={7} style={{ ...td, fontWeight: 600, fontSize: 'var(--fs-12)', color: 'var(--fg-muted)', borderBottom: 'none', paddingTop: 10 }}>{heading}</td></tr>
      )}
      <tr style={bold ? { borderTop: '2px solid var(--border-weak, #e3e1da)' } : undefined}>
        <td style={{ ...td, paddingLeft: indent ? 22 : 8, fontWeight: bold ? 650 : undefined, color: per ? 'var(--fg-muted)' : undefined }}>{r.label}</td>
        {REGIONS.map((g) => (
          <td key={g.code} style={cell} className={tone} title={per ? undefined : pctOf(r.sen[g.code], doValue.sen[g.code] ?? 0) || undefined}>{whole(r.sen[g.code])}</td>
        ))}
        <td style={cell} className={tone}>{whole(r.totalSen)}</td>
        <td style={{ ...cell, color: 'var(--fg-muted)', fontWeight: undefined }}>{per ? '' : pctOf(r.totalSen, doValue.totalSen ?? 0)}</td>
      </tr>
      {dos && (
        <tr>
          <td style={{ ...td, color: 'var(--fg-muted)' }}>DOs</td>
          {REGIONS.map((g) => <td key={g.code} style={{ ...td, ...num, color: 'var(--fg-muted)' }}>{dos[g.code].toLocaleString('en-MY')}</td>)}
          <td style={{ ...td, ...num, color: 'var(--fg-muted)' }}>{dos.total.toLocaleString('en-MY')}</td>
          <td style={td} />
        </tr>
      )}
    </>
  );
}

/** The share of the DOs' value counted as transport income. */
function IncomeRateBox({ bp }: { bp: number }) {
  const save = useSaveIncomeRate();
  const [text, setText] = useState(String(bp / 100));
  useEffect(() => { setText(String(bp / 100)); }, [bp]);
  const value = Number(text);
  const dirty = text.trim() !== '' && Number.isFinite(value) && Math.round(value * 100) !== bp;
  return (
    <span style={{ ...soft, display: 'inline-flex', gap: 6, alignItems: 'center', marginLeft: 'auto' }}>
      Transport income = DO value ×
      <input type="number" min={0} max={100} step={0.01} value={text} onChange={(e) => setText(e.target.value)} aria-label="Transport income percent of DO value" style={{ ...input, width: 64 }} />
      %
      {dirty && <Button size="sm" disabled={save.isPending} onClick={() => save.mutate({ pct: value })}>{save.isPending ? 'Saving…' : 'Save'}</Button>}
    </span>
  );
}

/* ── Setup & dismantle trips ───────────────────────────────────────────────── */
function TripsCard({ p }: { p: LogisticsPnl }) {
  const save = useSaveTripMark();
  const ours = p.trips.filter((t) => t.inHouse);
  const noRate = ours.filter((t) => t.rateSen == null).length;
  /* A tick that lands back on the rule is stored as the rule, never as a mark. */
  const flip = (t: LogisticsSetupTrip) => {
    const next = !t.inHouse;
    save.mutate({ tripKey: t.key, inHouse: next === !t.outsourced ? null : next });
  };
  return (
    <section style={card} aria-label="Setup and dismantle trips">
      <b style={{ fontSize: 'var(--fs-13)' }}>Set/Dismantle Income (in-house) — the trips</b>
      <div style={soft}>
        Each fair is one setup trip on its first day and one dismantle trip on its last; booths at one venue on one day share the trip.
        A trip an outsourced bill covers is not ours — tick it if our lorry went anyway, untick one we did not do.
        {' '}{ours.length} of {p.trips.length} trip{p.trips.length === 1 ? '' : 's'} ours{noRate > 0 ? ` · ${noRate} in an area with no rate (not counted)` : ''}.
      </div>
      {p.tripsProblem && <div style={{ ...soft, color: warn }}>The fairs could not be read — {p.tripsProblem}. No trip is counted.</div>}
      {p.trips.length > 0 && (
        <div style={{ overflowX: 'auto', marginTop: 'var(--space-2)' }}>
          <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 'var(--fs-12)' }}>
            <thead>
              <tr>
                <th style={th}>Date</th><th style={th}>Trip</th><th style={th}>Venue</th><th style={th}>Fairs</th><th style={th}>Area</th>
                <th style={{ ...th, ...num }}>Rate (RM)</th><th style={th}>Ours</th><th style={{ ...th, ...num }}>Income (RM)</th>
              </tr>
            </thead>
            <tbody>
              {p.trips.map((t) => (
                <tr key={t.key}>
                  <td style={td}>{fmtDateOrDash(t.day)}</td>
                  <td style={td}>{t.kind === 'setup' ? 'Setup' : 'Dismantle'}</td>
                  <td style={td}>{t.venue || '—'}</td>
                  <td style={{ ...td, maxWidth: 320 }}>{t.fairs.map((f) => f.name).join(' · ')}</td>
                  <td style={td}>{t.areaLabel} <span style={soft}>({regionName(t.region)})</span></td>
                  <td style={{ ...td, ...num }}>{t.rateSen == null ? 'no rate' : rm2(t.rateSen)}</td>
                  <td style={td}>
                    <label style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}
                      title={t.outsourced ? 'An outsourced bill on this fair covers this trip' : 'Our own lorry, by the rule'}>
                      <input type="checkbox" checked={t.inHouse} disabled={save.isPending} onChange={() => flip(t)}
                        aria-label={`${t.kind} ${t.venue} ${t.day} ours`} />
                      {t.mark != null ? <span style={soft}>Finance</span> : t.outsourced ? <span style={soft}>outsourced</span> : null}
                    </label>
                  </td>
                  <td style={{ ...td, ...num }}>{rm2(t.amountSen)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/* ── The rate per trip, by area ────────────────────────────────────────────── */
function AreaRatesCard({ rates }: { rates: LogisticsAreaRate[] }) {
  return (
    <section style={card} aria-label="Rates per trip by area">
      <b style={{ fontSize: 'var(--fs-13)' }}>Setup / dismantle rate per trip, by area</b>
      <div style={soft}>Each setup or dismantle trip of ours earns its area&rsquo;s rate. Leave a rate empty for an area we do not price.</div>
      <div style={{ overflowX: 'auto', marginTop: 'var(--space-2)' }}>
        <table style={{ borderCollapse: 'collapse', fontSize: 'var(--fs-12)' }}>
          <thead><tr><th style={th}>Area</th><th style={th}>Region</th><th style={{ ...th, ...num }}>RM per trip</th><th style={th} /></tr></thead>
          <tbody>{rates.map((a) => <AreaRateLine key={a.key} a={a} />)}</tbody>
        </table>
      </div>
    </section>
  );
}

function AreaRateLine({ a }: { a: LogisticsAreaRate }) {
  const save = useSaveAreaRate();
  const shown = a.rateSen == null ? '' : String(a.rateSen / 100);
  const [text, setText] = useState(shown);
  useEffect(() => { setText(shown); }, [shown]);
  const dirty = text.trim() !== shown;
  const value = text.trim() === '' ? null : Number(text);
  const bad = value != null && (!Number.isFinite(value) || value < 0);
  return (
    <tr>
      <td style={td}>{a.label}</td>
      <td style={{ ...td, ...soft }}>{regionName(a.region)}</td>
      <td style={{ ...td, ...num }}>
        <input type="number" min={0} step={1} value={text} placeholder="no rate" onChange={(e) => setText(e.target.value)} aria-label={`${a.label} rate per trip`} style={input} />
      </td>
      <td style={{ ...td, whiteSpace: 'nowrap' }}>
        {dirty && <Button size="sm" disabled={bad || save.isPending} onClick={() => save.mutate({ area: a.key, rateRm: value })}>Save</Button>}
        {!dirty && !a.isDefault && (
          <Button size="sm" variant="ghost" disabled={save.isPending} onClick={() => save.mutate({ area: a.key, reset: true })}>
            Default ({a.defaultRateSen == null ? 'no rate' : `RM ${rm2(a.defaultRateSen)}`})
          </Button>
        )}
      </td>
    </tr>
  );
}

/* ── Upkeep and insurance & road tax, spread ───────────────────────────────── */
function SpreadsCard({ rows }: { rows: LogisticsSpreadRow[] }) {
  return (
    <section style={card} aria-label="Upkeep and road tax spread">
      <b style={{ fontSize: 'var(--fs-13)' }}>Upkeep and road tax &amp; insurance — each bill spread</b>
      <div style={soft}>A bill counts from the month it was paid, shared equally over its months. Upkeep stays in its own month until you give it more; insurance &amp; road tax is spread over 12.</div>
      {rows.length === 0
        ? <div style={{ ...soft, marginTop: 'var(--space-2)' }}>No upkeep or insurance bill reaches these months.</div>
        : (
          <div style={{ overflowX: 'auto', marginTop: 'var(--space-2)' }}>
            <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 'var(--fs-12)' }}>
              <thead>
                <tr>
                  <th style={th}>Date</th><th style={th}>Account</th><th style={th}>What</th><th style={{ ...th, ...num }}>Bill (RM)</th>
                  <th style={th}>Months</th><th style={{ ...th, ...num }}>Per month (RM)</th><th style={{ ...th, ...num }}>In these months (RM)</th>
                </tr>
              </thead>
              <tbody>{rows.map((r) => <SpreadLine key={r.lineId} r={r} />)}</tbody>
            </table>
          </div>
        )}
    </section>
  );
}

function SpreadLine({ r }: { r: LogisticsSpreadRow }) {
  const save = useSaveSpread();
  const [text, setText] = useState(String(r.months));
  useEffect(() => { setText(String(r.months)); }, [r.months]);
  const n = Number(text);
  const ok = Number.isInteger(n) && n >= 1 && n <= 36;
  const dirty = text !== String(r.months);
  return (
    <tr>
      <td style={td}>{fmtDateOrDash(r.day)}</td>
      <td style={td}><AccountCell code={r.accountCode} name={r.accountName} /></td>
      <td style={{ ...td, maxWidth: 320 }}>{r.notes ?? '—'}{r.docNo ? <span style={soft}> · {r.docNo}</span> : null}</td>
      <td style={{ ...td, ...num }}>{rm2(r.amountSen)}</td>
      <td style={{ ...td, whiteSpace: 'nowrap' }}>
        <input type="number" min={1} max={36} step={1} value={text} onChange={(e) => setText(e.target.value)} aria-label={`Months for ${r.notes ?? r.lineId}`} style={{ ...input, width: 56 }} />
        {' '}{dirty && <Button size="sm" disabled={!ok || save.isPending} onClick={() => save.mutate({ lineId: r.lineId, months: n })}>Save</Button>}
        {!dirty && !r.isDefault && <Button size="sm" variant="ghost" disabled={save.isPending} onClick={() => save.mutate({ lineId: r.lineId, months: null })}>Default</Button>}
        {!dirty && <span style={soft}> to {r.lastMonth}</span>}
      </td>
      <td style={{ ...td, ...num }}>{rm2(r.perMonthSen)}</td>
      <td style={{ ...td, ...num }}>{rm2(r.inRangeSen)}</td>
    </tr>
  );
}

/* ── What was billed extra ─────────────────────────────────────────────────── */
function IncomeCard({ p }: { p: LogisticsPnl }) {
  return (
    <section style={card} aria-label="Transport income billed">
      <b style={{ fontSize: 'var(--fs-13)' }}>Transport income billed — Other Debtor bills</b>
      <div style={soft}>
        Lines on an account the Chart of Accounts puts on a Transport Income row, in that row&rsquo;s region; a line worded &ldquo;LOGISTICS CHARGES&rdquo; or &ldquo;TRANSPORT CHARGES&rdquo; on another account counts under KL.
        The month is the one the line names (&ldquo;SEP&rsquo;26&rdquo;), else the bill&rsquo;s. A sales invoice&rsquo;s transport line is not counted here.
      </div>
      {p.income.length === 0
        ? <div style={{ ...soft, marginTop: 'var(--space-2)' }}>No transport line on an Other Debtor bill for these months.</div>
        : (
          <div style={{ overflowX: 'auto', marginTop: 'var(--space-2)' }}>
            <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 'var(--fs-12)' }}>
              <thead>
                <tr>
                  <th style={th}>Bill</th><th style={th}>Bill date</th><th style={th}>For</th><th style={th}>Billed to</th><th style={th}>Row</th>
                  <th style={th}>Region</th><th style={th}>Line</th><th style={th}>Account</th><th style={{ ...th, ...num }}>Amount (RM)</th>
                </tr>
              </thead>
              <tbody>
                {p.income.map((l) => (
                  <tr key={l.lineId}>
                    <td style={td}>{l.billNo}</td>
                    <td style={td}>{fmtDateOrDash(l.billDate)}</td>
                    <td style={td}>{l.month}</td>
                    <td style={td}>{l.debtorName}</td>
                    <td style={td}>{ROW_OF[l.row]}</td>
                    <td style={td}>{regionName(l.region)}{l.by === 'wording' ? <span style={soft}> (by its words)</span> : null}</td>
                    <td style={{ ...td, maxWidth: 320 }}>{l.description ?? '—'}</td>
                    <td style={td}><AccountCell code={l.accountCode} name={l.accountName} /></td>
                    <td style={{ ...td, ...num }}>{rm2(l.amountSen)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
    </section>
  );
}
