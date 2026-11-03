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
//
// The owner's redesign (batch 6 §5.11): the four figures as the report's tiles,
// the P&L and each setting as a Finance card, Excel · PDF · Print in the header
// from the P&L as shown. Every setting and its Save stays.
// ----------------------------------------------------------------------------

import { useEffect, useState } from 'react';
import { fmtDateOrDash } from '../../vendor/shared/format';
import { AMOUNT_COLUMN, PCT_COLUMN, type ReportSheet, type SheetRow, type SheetRowKind } from '../../vendor/scm/lib/report-sheet';
import { AccountCell } from './JournalEntryCards';
import {
  useLogisticsPnl, useSaveAreaRate, useSaveIncomeRate, useSaveSpread, useSaveTripMark,
  type LogisticsAreaRate, type LogisticsPnl, type LogisticsPnlRow, type LogisticsSetupTrip, type LogisticsSpreadRow, type PnlRegion,
} from '../../vendor/scm/lib/logistics-queries';
import { ReportExports, ReportHeaderActions, ReportMessage, ReportTiles, type ReportTile } from './reports/reportParts';
import s from './Logistics.module.css';

const REGIONS: Array<{ code: PnlRegion; name: string }> = [
  { code: 'PG', name: 'Penang' }, { code: 'KL', name: 'KL' }, { code: 'EM', name: 'SBH & SWK' }, { code: 'SG', name: 'SGD' },
];
const ROW_OF: Record<string, string> = { houzs: 'Houzs', conts: 'The Conts', hookka: 'Hookka', '2990': '2990' };
const regionName = (code: PnlRegion): string => REGIONS.find((r) => r.code === code)!.name;

/** Whole ringgit, a negative in brackets — the P&L reads like the owner's sheet. */
const whole = (sen: number | null): string => {
  if (sen == null) return '—';
  const text = Math.round(Math.abs(sen) / 100).toLocaleString('en-MY');
  return sen < 0 ? `(${text})` : text;
};
/** Ringgit and sen, for a bill or a rate. */
const rm2 = (sen: number | null): string => (sen == null ? '—' : (sen / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const pctOf = (part: number | null, whole_: number): string => (part == null || whole_ <= 0 ? '' : `${((part / whole_) * 100).toFixed(1)}%`);

/* Rows the sheet groups, set in from their heading; rows it closes with, in bold. */
const INCOME_LINES = new Set(['ti_houzs', 'ti_conts', 'ti_hookka', 'sd_income', 'ti_2990']);
const IN_HOUSE_LINES = new Set(['petrol', 'upkeep', 'instalment', 'roadtax', 'manpower', 'other_lorry']);
const BOLD = new Set(['total_income', 'total_expense', 'net']);
const PER_DO = new Set(['cost_per_do', 'net_cost_per_do']);
const headingOf = (key: string): string | null => (key === 'ti_houzs' ? 'Income' : key === 'petrol' ? 'In-house expense' : null);

/** The P&L as the screen shows it, for Excel and PDF: the four regions, Total, % of DO value. */
export function logisticsPnlSheet(p: LogisticsPnl, period: string): ReportSheet {
  const doValue = p.rows.find((r) => r.key === 'do_value');
  const rows: SheetRow[] = [];
  for (const r of p.rows) {
    const heading = headingOf(r.key);
    if (heading) rows.push({ kind: 'block', depth: 0, label: heading, cells: [] });
    const per = PER_DO.has(r.key);
    const kind: SheetRowKind = r.key === 'net' ? 'net' : BOLD.has(r.key) ? 'total' : per ? 'memo' : 'row';
    rows.push({
      kind, depth: INCOME_LINES.has(r.key) || IN_HOUSE_LINES.has(r.key) ? 1 : 0, label: r.label,
      cells: [...REGIONS.map((g) => r.sen[g.code] ?? null), r.totalSen, per || !doValue || r.totalSen == null || (doValue.totalSen ?? 0) <= 0 ? null : (r.totalSen / doValue.totalSen!) * 100],
    });
  }
  return {
    title: 'Logistics cost · P&L', subtitle: `${period} · in-house costs sit in KL, as on the sheet · RM`, meta: [{ label: 'Months', value: period }],
    tables: [{ columns: [...REGIONS.map((g) => AMOUNT_COLUMN(g.name)), AMOUNT_COLUMN('Total'), PCT_COLUMN('% of DO value')], rows }],
    fmt: (sen) => whole(sen),
  };
}

export function PnlView({ from, to, period }: { from: string; to: string; period: string }) {
  const q = useLogisticsPnl(from, to);
  const p = q.data;
  const row = (k: string) => p?.rows.find((r) => r.key === k) ?? null;
  const income = row('total_income')?.totalSen ?? 0;
  const expense = row('total_expense')?.totalSen ?? 0;
  const net = row('net')?.totalSen ?? 0;
  const perDo = row('cost_per_do')?.totalSen ?? null;
  const doValue = row('do_value')?.totalSen ?? 0;
  const tiles: ReportTile[] = [
    { key: 'income', label: 'Total income', value: p ? whole(income) : '', sub: p ? `${pctOf(income, doValue) || '—'} of DO value` : '' },
    { key: 'expense', label: 'Total expense', value: p ? whole(expense) : '', sub: p ? `${pctOf(expense, doValue) || '—'} of DO value` : '' },
    {
      key: 'net', label: 'Net profit', value: p ? whole(net) : '', tone: !p ? 'plain' : net < 0 ? 'late' : 'good',
      sub: p ? (net < 0 ? '▼ logistics cost more than it earned' : '▲ logistics earned more than it cost') : '',
    },
    { key: 'perDo', label: 'Cost per DO', value: p ? whole(perDo) : '', sub: p ? `${p.dos.total.toLocaleString('en-MY')} DOs` : '' },
  ];
  return (
    <>
      <ReportHeaderActions>
        <ReportExports sheet={() => (p ? logisticsPnlSheet(p, period) : null)} fileBase={`logistics-pnl-${from.slice(0, 7)}-${to.slice(0, 7)}`} />
      </ReportHeaderActions>
      {q.isError ? (
        <ReportMessage tone="error">The P&amp;L could not be read — {q.error instanceof Error ? q.error.message : String(q.error)}</ReportMessage>
      ) : (
        <>
          <ReportTiles tiles={tiles} label="P&L totals" pending={!p} />
          {p ? <PnlTable p={p} /> : q.isLoading && (
            <div className={s.skeleton} aria-label="Reading the books">
              {[0, 1, 2, 3].map((i) => <div key={i} className={`skeleton ${s.skeletonBar}`} style={{ width: `${92 - i * 12}%` }} />)}
            </div>
          )}
          {p && (
            <>
              <TripsCard p={p} />
              <AreaRatesCard rates={p.areaRates} />
              <SpreadsCard rows={p.spreads} />
              <IncomeCard p={p} />
            </>
          )}
        </>
      )}
    </>
  );
}

/* ── The P&L ───────────────────────────────────────────────────────────────── */
function PnlTable({ p }: { p: LogisticsPnl }) {
  const doValue = p.rows.find((r) => r.key === 'do_value')!;
  return (
    <section className={s.card} aria-label="Logistics P&L">
      <div className={s.cardHead}>
        <h3 className={s.cardTitle}>Logistic cost report (RM)</h3>
        <span className={s.hint}>{p.months.length === 1 ? p.months[0] : `${p.months[0]} to ${p.months[p.months.length - 1]}`} · in-house costs sit in KL, as on the sheet</span>
        <span className={s.grow} />
        <IncomeRateBox bp={p.doIncomeBp} />
      </div>
      <div className={s.scroll}>
        <table className={s.table}>
          <thead>
            <tr>
              <th>Category</th>
              {REGIONS.map((r) => <th key={r.code} className={s.num}>{r.name}</th>)}
              <th className={s.num}>Total</th>
              <th className={s.num}>% of DO value</th>
            </tr>
          </thead>
          <tbody>
            {p.rows.map((r) => (
              <PnlLine key={r.key} r={r} doValue={doValue} heading={headingOf(r.key)} dos={r.key === 'do_value' ? p.dos : null} />
            ))}
          </tbody>
        </table>
      </div>
      <p className={s.hint}>
        {p.ownTrips > 0
          ? `In-house cost per trip: RM ${whole(p.inHousePerTripSen)} — ${p.ownTrips} trip${p.ownTrips === 1 ? '' : 's'} of our lorries (one lorry, one day).`
          : 'No trip of our lorries is recorded in these months, so there is no in-house cost per trip — pick the lorry on the DOs in Delivery Planning.'}
        {' '}Which account feeds which row: Chart of Accounts › Logistics column.
      </p>
    </section>
  );
}

function PnlLine({ r, doValue, heading, dos }: { r: LogisticsPnlRow; doValue: LogisticsPnlRow; heading: string | null; dos: LogisticsPnl['dos'] | null }) {
  const indent = INCOME_LINES.has(r.key) || IN_HOUSE_LINES.has(r.key);
  const bold = BOLD.has(r.key);
  const per = PER_DO.has(r.key);
  const tone = r.key === 'net' && r.totalSen != null ? (r.totalSen < 0 ? s.loss : s.gain) : '';
  const rowClass = [bold ? s.bold : '', r.key === 'net' ? s.final : ''].filter(Boolean).join(' ') || undefined;
  return (
    <>
      {heading && <tr className={s.heading}><td colSpan={7}>{heading}</td></tr>}
      <tr className={rowClass}>
        <td className={per ? s.muted : undefined} style={indent ? { paddingLeft: 22 } : undefined}>{r.label}</td>
        {REGIONS.map((g) => (
          <td key={g.code} className={`${s.num} ${per ? s.muted : tone}`} title={per ? undefined : pctOf(r.sen[g.code], doValue.sen[g.code] ?? 0) || undefined}>{whole(r.sen[g.code])}</td>
        ))}
        <td className={`${s.num} ${per ? s.muted : tone}`}>{whole(r.totalSen)}</td>
        <td className={`${s.num} ${s.muted}`}>{per ? '' : pctOf(r.totalSen, doValue.totalSen ?? 0)}</td>
      </tr>
      {dos && (
        <tr>
          <td className={s.muted}>DOs</td>
          {REGIONS.map((g) => <td key={g.code} className={`${s.num} ${s.muted}`}>{dos[g.code].toLocaleString('en-MY')}</td>)}
          <td className={`${s.num} ${s.muted}`}>{dos.total.toLocaleString('en-MY')}</td>
          <td />
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
    <span className={s.rate}>
      Transport income = DO value ×
      <input type="number" min={0} max={100} step={0.01} value={text} onChange={(e) => setText(e.target.value)} aria-label="Transport income percent of DO value" className={s.input} style={{ width: 64 }} />
      %
      {dirty && <button type="button" className={`${s.btn} ${s.btnSolid}`} disabled={save.isPending} onClick={() => save.mutate({ pct: value })}>{save.isPending ? 'Saving…' : 'Save'}</button>}
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
    <section className={s.card} aria-label="Setup and dismantle trips">
      <div className={s.cardHead}><h3 className={s.cardTitle}>Set/Dismantle Income (in-house) — the trips</h3></div>
      <p className={s.hint}>
        Each fair is one setup trip on its first day and one dismantle trip on its last; booths at one venue on one day share the trip.
        A trip an outsourced bill covers is not ours — tick it if our lorry went anyway, untick one we did not do.
        {' '}{ours.length} of {p.trips.length} trip{p.trips.length === 1 ? '' : 's'} ours{noRate > 0 ? ` · ${noRate} in an area with no rate (not counted)` : ''}.
      </p>
      {p.tripsProblem && <p className={s.problem}>The fairs could not be read — {p.tripsProblem}. No trip is counted.</p>}
      {p.trips.length > 0 && (
        <div className={s.scroll}>
          <table className={s.table}>
            <thead>
              <tr>
                <th>Date</th><th>Trip</th><th>Venue</th><th>Fairs</th><th>Area</th>
                <th className={s.num}>Rate (RM)</th><th>Ours</th><th className={s.num}>Income (RM)</th>
              </tr>
            </thead>
            <tbody>
              {p.trips.map((t) => (
                <tr key={t.key}>
                  <td>{fmtDateOrDash(t.day)}</td>
                  <td>{t.kind === 'setup' ? 'Setup' : 'Dismantle'}</td>
                  <td>{t.venue || '—'}</td>
                  <td style={{ maxWidth: 320 }}>{t.fairs.map((f) => f.name).join(' · ')}</td>
                  <td>{t.areaLabel} <span className={s.muted}>({regionName(t.region)})</span></td>
                  <td className={s.num}>{t.rateSen == null ? 'no rate' : rm2(t.rateSen)}</td>
                  <td>
                    <label style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}
                      title={t.outsourced ? 'An outsourced bill on this fair covers this trip' : 'Our own lorry, by the rule'}>
                      <input type="checkbox" className={s.tick} checked={t.inHouse} disabled={save.isPending} onChange={() => flip(t)}
                        aria-label={`${t.kind} ${t.venue} ${t.day} ours`} />
                      {t.mark != null ? <span className={s.muted}>Finance</span> : t.outsourced ? <span className={s.muted}>outsourced</span> : null}
                    </label>
                  </td>
                  <td className={s.num}>{rm2(t.amountSen)}</td>
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
    <section className={s.card} aria-label="Rates per trip by area">
      <div className={s.cardHead}><h3 className={s.cardTitle}>Setup / dismantle rate per trip, by area</h3></div>
      <p className={s.hint}>Each setup or dismantle trip of ours earns its area&rsquo;s rate. Leave a rate empty for an area we do not price.</p>
      <div className={s.scroll}>
        <table className={s.table} style={{ width: 'auto' }}>
          <thead><tr><th>Area</th><th>Region</th><th className={s.num}>RM per trip</th><th /></tr></thead>
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
      <td>{a.label}</td>
      <td className={s.muted}>{regionName(a.region)}</td>
      <td className={s.num}>
        <input type="number" min={0} step={1} value={text} placeholder="no rate" onChange={(e) => setText(e.target.value)} aria-label={`${a.label} rate per trip`} className={s.input} />
      </td>
      <td style={{ whiteSpace: 'nowrap' }}>
        {dirty && <button type="button" className={`${s.btn} ${s.btnSolid}`} disabled={bad || save.isPending} onClick={() => save.mutate({ area: a.key, rateRm: value })}>Save</button>}
        {!dirty && !a.isDefault && (
          <button type="button" className={s.btn} disabled={save.isPending} onClick={() => save.mutate({ area: a.key, reset: true })}>
            Default ({a.defaultRateSen == null ? 'no rate' : `RM ${rm2(a.defaultRateSen)}`})
          </button>
        )}
      </td>
    </tr>
  );
}

/* ── Upkeep and insurance & road tax, spread ───────────────────────────────── */
function SpreadsCard({ rows }: { rows: LogisticsSpreadRow[] }) {
  return (
    <section className={s.card} aria-label="Upkeep and road tax spread">
      <div className={s.cardHead}><h3 className={s.cardTitle}>Upkeep and road tax &amp; insurance — each bill spread</h3></div>
      <p className={s.hint}>A bill counts from the month it was paid, shared equally over its months. Upkeep stays in its own month until you give it more; insurance &amp; road tax is spread over 12.</p>
      {rows.length === 0
        ? <p className={s.hint}>No upkeep or insurance bill reaches these months.</p>
        : (
          <div className={s.scroll}>
            <table className={s.table}>
              <thead>
                <tr>
                  <th>Date</th><th>Account</th><th>What</th><th className={s.num}>Bill (RM)</th>
                  <th>Months</th><th className={s.num}>Per month (RM)</th><th className={s.num}>In these months (RM)</th>
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
      <td>{fmtDateOrDash(r.day)}</td>
      <td><AccountCell code={r.accountCode} name={r.accountName} /></td>
      <td style={{ maxWidth: 320 }}>{r.notes ?? '—'}{r.docNo ? <span className={s.muted}> · {r.docNo}</span> : null}</td>
      <td className={s.num}>{rm2(r.amountSen)}</td>
      <td style={{ whiteSpace: 'nowrap' }}>
        <input type="number" min={1} max={36} step={1} value={text} onChange={(e) => setText(e.target.value)} aria-label={`Months for ${r.notes ?? r.lineId}`} className={s.input} style={{ width: 56 }} />
        {' '}{dirty && <button type="button" className={`${s.btn} ${s.btnSolid}`} disabled={!ok || save.isPending} onClick={() => save.mutate({ lineId: r.lineId, months: n })}>Save</button>}
        {!dirty && !r.isDefault && <button type="button" className={s.btn} disabled={save.isPending} onClick={() => save.mutate({ lineId: r.lineId, months: null })}>Default</button>}
        {!dirty && <span className={s.muted}> to {r.lastMonth}</span>}
      </td>
      <td className={s.num}>{rm2(r.perMonthSen)}</td>
      <td className={s.num}>{rm2(r.inRangeSen)}</td>
    </tr>
  );
}

/* ── What was billed extra ─────────────────────────────────────────────────── */
function IncomeCard({ p }: { p: LogisticsPnl }) {
  return (
    <section className={s.card} aria-label="Transport income billed">
      <div className={s.cardHead}><h3 className={s.cardTitle}>Transport income billed — Other Debtor bills</h3></div>
      <p className={s.hint}>
        Lines on an account the Chart of Accounts puts on a Transport Income row, in that row&rsquo;s region; a line worded &ldquo;LOGISTICS CHARGES&rdquo; or &ldquo;TRANSPORT CHARGES&rdquo; on another account counts under KL.
        The month is the one the line names (&ldquo;SEP&rsquo;26&rdquo;), else the bill&rsquo;s. A sales invoice&rsquo;s transport line is not counted here.
      </p>
      {p.income.length === 0
        ? <p className={s.hint}>No transport line on an Other Debtor bill for these months.</p>
        : (
          <div className={s.scroll}>
            <table className={s.table}>
              <thead>
                <tr>
                  <th>Bill</th><th>Bill date</th><th>For</th><th>Billed to</th><th>Row</th>
                  <th>Region</th><th>Line</th><th>Account</th><th className={s.num}>Amount (RM)</th>
                </tr>
              </thead>
              <tbody>
                {p.income.map((l) => (
                  <tr key={l.lineId}>
                    <td>{l.billNo}</td>
                    <td>{fmtDateOrDash(l.billDate)}</td>
                    <td>{l.month}</td>
                    <td>{l.debtorName}</td>
                    <td>{ROW_OF[l.row]}</td>
                    <td>{regionName(l.region)}{l.by === 'wording' ? <span className={s.muted}> (by its words)</span> : null}</td>
                    <td style={{ maxWidth: 320 }}>{l.description ?? '—'}</td>
                    <td><AccountCell code={l.accountCode} name={l.accountName} /></td>
                    <td className={s.num}>{rm2(l.amountSen)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
    </section>
  );
}
