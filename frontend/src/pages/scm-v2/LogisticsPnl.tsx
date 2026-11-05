// ----------------------------------------------------------------------------
// LogisticsPnl — the Logistics cost tab's P&L view: the owner's own Logistic Cost
// Report ("Logistic - Auto" sheet), built from the books (owner 2026-10-29, 做 —
// 「不要我填」), in the report style he approved on 2026-11-05: regions across the
// top (or a Total and one column per month), a % beside every figure of that
// column's Delivery Order value (「我的 percentage 是除 DO 的」 — Penang ÷ its DO
// value; no other base). Income now carries "Transport Income (1% of fair
// sales)", its rate Finance's own like the DO's 3%.
// Under it, everything it counted, each with the one thing Finance keeps on it:
//   • the setup / dismantle trips — a Finance list by region, tick or untick
//     one; the rate per trip by area (「我要自己能维护」);
//   • the upkeep and insurance bills, each spread over its own months;
//   • the Other Debtor bill lines counted as transport income.
// Server: backend/src/scm/routes/acc-logistics-pnl.ts.
// ----------------------------------------------------------------------------

import { useEffect, useMemo, useState } from 'react';
import { fmtDateOrDash } from '../../vendor/shared/format';
import {
  useSaveAreaRate, useSaveFairIncomeRate, useSaveIncomeRate, useSaveSpread, useSaveTripMark,
  type LogisticsAreaRate, type LogisticsMonth, type LogisticsPnl, type LogisticsSetupTrip, type LogisticsSpreadRow,
} from '../../vendor/scm/lib/logistics-queries';
import { FinanceGrid, fmtMoney, gridFlag, gridMuted, gridPill, gridTick, type GridColumn, type GridRow } from './reports/FinanceGrid';
import { ReportExports, ReportHeaderActions, ReportTiles, type ReportTile } from './reports/reportParts';
import { REGIONS, cellsBy, gridSheet, logisticsColumns, pctOf, regionName } from './logisticsColumns';
import type { ViewProps } from './LogisticsCost';
import s from './Logistics.module.css';

const ROW_OF: Record<string, string> = { houzs: 'Houzs', conts: 'The Conts', hookka: 'Hookka', '2990': '2990' };
const whole = (sen: number | null): string => {
  if (sen == null) return '—';
  const text = Math.round(Math.abs(sen) / 100).toLocaleString('en-US');
  return sen < 0 ? `(${text})` : text;
};
const pctText = (part: number, base: number) => (base > 0 ? `${((part / base) * 100).toFixed(1)}%` : '—');

const INCOME = ['do_income', 'ti_houzs', 'ti_conts', 'ti_hookka', 'sd_income', 'fair_income', 'ti_2990'];
const IN_HOUSE = ['petrol', 'upkeep', 'instalment', 'roadtax', 'manpower', 'other_lorry'];

export function PnlView({ p, mode, split, showPct, period, months }: ViewProps) {
  const byMonth = useMemo(() => new Map(p.perMonth.map((m) => [m.month, m] as const)), [p]);
  const { columns, scopes } = useMemo(() => logisticsColumns(months, mode, split, showPct ? 172 : 120), [months, mode, split, showPct]);

  const rows = useMemo<GridRow[]>(() => {
    const label = (key: string) => p.perMonth.flatMap((m) => m.rows).find((r) => r.key === key)?.label ?? key;
    const has = (key: string) => p.perMonth.some((m) => m.rows.some((r) => r.key === key));
    const money = (key: string) => cellsBy(scopes, byMonth, (m: LogisticsMonth, r) => m.rows.find((x) => x.key === key)?.sen[r] ?? 0);
    const doValue = money('do_value');
    const line = (key: string): GridRow => { const cells = money(key); return { id: key, label: label(key), cells, pct: pctOf(cells, doValue) }; };
    const group = (id: string, name: string, totalLabel: string, kids: GridRow[], totalKey: string): GridRow => {
      const cells = money(totalKey);
      return { id, label: name, totalLabel, kids, cells, pct: pctOf(cells, doValue) };
    };
    const income = group('income', 'INCOME', 'TOTAL INCOME', INCOME.map(line), 'total_income');
    const inHouse = { ...group('inhouse', 'In-house', 'Total In-house Expenses', IN_HOUSE.filter((k) => k !== 'other_lorry' || has(k)).map(line), 'inhouse_total'), kind: 'group' as const };
    const expense = group('expense', 'EXPENSE', 'TOTAL EXPENSE', [line('outsource'), inHouse], 'total_expense');
    const net = money('net');
    const dos = cellsBy(scopes, byMonth, (m, r) => m.dos[r]);
    const perDo = (sen: Record<string, number>) => Object.fromEntries(Object.keys(sen).map((k) => [k, dos[k] ? Math.round(sen[k]! / dos[k]!) : null]));
    const otherIncome = Object.fromEntries(Object.keys(net).map((k) => [k, (income.cells[k] as number) - (money('do_income')[k] ?? 0)]));
    const expenseCells = expense.cells as Record<string, number>;
    return [
      { id: 'do_value', label: 'Delivery Order', kind: 'strong', cells: doValue, pct: pctOf(doValue, doValue) },
      { id: 'dos', label: 'DOs', kind: 'ratio', int: true, cells: dos },
      income, expense,
      { id: 'net', label: 'NET PROFIT', kind: 'final', cells: net, pct: pctOf(net, doValue) },
      { id: 'cost_per_do', label: 'Cost per DO', kind: 'ratio', cells: perDo(expenseCells) },
      { id: 'net_cost_per_do', label: 'Net cost per DO (after other income)', kind: 'ratio', cells: perDo(Object.fromEntries(Object.keys(net).map((k) => [k, expenseCells[k]! - otherIncome[k]!]))) },
    ];
  }, [p, byMonth, scopes]);

  const row = (k: string) => p.rows.find((r) => r.key === k) ?? null;
  const income = row('total_income')?.totalSen ?? 0;
  const expense = row('total_expense')?.totalSen ?? 0;
  const net = row('net')?.totalSen ?? 0;
  const doValue = row('do_value')?.totalSen ?? 0;
  const tiles: ReportTile[] = [
    { key: 'income', label: 'Total income', value: whole(income), sub: `${pctText(income, doValue)} of DO value` },
    { key: 'expense', label: 'Total expense', value: whole(expense), sub: `${pctText(expense, doValue)} of DO value` },
    { key: 'net', label: 'Net profit', value: whole(net), tone: net < 0 ? 'late' : 'good', sub: net < 0 ? '▼ logistics cost more than it earned' : '▲ logistics earned more than it cost' },
    { key: 'perDo', label: 'Cost per DO', value: whole(row('cost_per_do')?.totalSen ?? null), sub: `${p.dos.total.toLocaleString('en-US')} DOs` },
  ];
  const sheet = () => gridSheet({ title: 'Logistics cost · P&L', subtitle: `${period} · in-house costs sit in KL, as on the sheet · RM`, period, nameLabel: 'Account', columns, rows, showPct });

  return (
    <>
      <ReportHeaderActions><ReportExports sheet={sheet} fileBase={`logistics-pnl-${months[0] ?? ''}-${months.at(-1) ?? ''}`} /></ReportHeaderActions>
      <ReportTiles tiles={tiles} label="P&L totals" />
      <div className={s.rates}>
        <RateBox bp={p.doIncomeBp} what="DO value" useSave={useSaveIncomeRate} />
        <RateBox bp={p.fairIncomeBp} what="fair sales" useSave={useSaveFairIncomeRate} />
      </div>
      <FinanceGrid storageKey={`logistics-pnl|${mode}|${split ? 1 : 0}|${showPct ? 1 : 0}`} nameColumn={{ label: 'Account', width: 330 }} columns={columns} rows={rows} showPct={showPct}
        title="Logistic cost report" subtitle={`${period} · RM`} ariaLabel="Logistics P&L" drillKey={`${months.join()}|${mode}|${split}`}
        foot={<span>
          Every % is of the Delivery Order value in its column. In-house costs sit in KL, as on the sheet.
          {p.ownTrips > 0 ? ` In-house cost per trip: RM ${whole(p.inHousePerTripSen)} over ${p.ownTrips.toLocaleString('en-US')} trips of our lorries.` : ''}
          {' '}Which account feeds which row: Chart of Accounts › Logistics column.
        </span>} />
      <TripsList p={p} />
      <AreaRatesList rates={p.areaRates} />
      <SpreadsList rows={p.spreads} />
      <IncomeList p={p} />
    </>
  );
}

/** A share Finance keeps: of the DOs' value, or of the fairs' sales. */
function RateBox({ bp, what, useSave }: { bp: number; what: string; useSave: () => { mutate: (b: { pct: number }) => void; isPending: boolean } }) {
  const save = useSave();
  const [text, setText] = useState(String(bp / 100));
  useEffect(() => { setText(String(bp / 100)); }, [bp]);
  const value = Number(text);
  const dirty = text.trim() !== '' && Number.isFinite(value) && Math.round(value * 100) !== bp;
  return (
    <span className={s.rate}>
      Transport income = {what} ×
      <input type="number" min={0} max={100} step={0.01} value={text} onChange={(e) => setText(e.target.value)} aria-label={`Transport income percent of ${what}`} className={s.input} style={{ width: 64 }} />
      %
      {dirty && <button type="button" className={`${s.btn} ${s.btnSolid}`} disabled={save.isPending} onClick={() => save.mutate({ pct: value })}>{save.isPending ? 'Saving…' : 'Save'}</button>}
    </span>
  );
}

/* ── Set/Dismantle Income (in-house) · the trips — a Finance list ──────────── */
const TRIP_COLUMNS: GridColumn[] = [
  { key: 'date', label: 'Date', kind: 'text', width: 100 },
  { key: 'trip', label: 'Trip', kind: 'center', width: 96 },
  { key: 'fair', label: 'Fair', kind: 'text', width: 140 },
  { key: 'venue', label: 'Venue', kind: 'text', width: 220 },
  { key: 'booths', label: 'Booths', kind: 'text', width: 230 },
  { key: 'area', label: 'Area', kind: 'text', width: 120 },
  { key: 'bill', label: 'Bill', kind: 'center', width: 90 },
  { key: 'rate', label: 'Rate', kind: 'money', width: 90 },
  { key: 'ours', label: 'Ours', kind: 'center', width: 64 },
  { key: 'income', label: 'Income', kind: 'money', width: 110 },
];
/** "[AKEMI] HOMEDEC @ KLCC" → "HOMEDEC"; the brand, the booths cell's. */
const fairWord = (name: string) => name.replace(/^\s*\[[^\]]*\]\s*/, '').replace(/\s*@.*$/, '').trim() || name;
const brandOf = (name: string) => /^\s*\[([^\]]+)\]/.exec(name)?.[1]?.trim() ?? fairWord(name);

function TripsList({ p }: { p: LogisticsPnl }) {
  const save = useSaveTripMark();
  /* A tick that lands back on the rule is stored as the rule, never as a mark. */
  const flip = (t: LogisticsSetupTrip) => {
    const next = !t.inHouse;
    save.mutate({ tripKey: t.key, inHouse: next === !t.outsourced ? null : next });
  };
  const rows = useMemo<GridRow[]>(() => {
    const out: GridRow[] = [];
    for (const g of REGIONS) {
      const list = p.trips.filter((t) => t.region === g.code);
      if (list.length === 0) continue;
      out.push({ id: `rg:${g.code}`, label: g.name, kind: 'block', cells: {} });
      for (const t of list) {
        const fairs = [...new Set(t.fairs.map((f) => fairWord(f.name)))].join(', ');
        const booths = t.fairs.map((f) => brandOf(f.name));
        out.push({
          id: t.key, label: t.key,
          cells: {
            date: { node: fmtDateOrDash(t.day), text: fmtDateOrDash(t.day), sort: t.day },
            trip: gridPill(t.kind === 'setup' ? 'Setup' : 'Dismantle', t.kind === 'dismantle'),
            fair: { node: fairs, text: fairs, title: t.fairs.map((f) => f.name).join('\n') },
            venue: { node: t.venue || '—', text: t.venue, title: t.venue },
            booths: { node: <><span className={gridMuted}>{booths.length} ·</span> {booths.join(', ')}</>, text: `${booths.length} · ${booths.join(', ')}`, title: booths.join(', '), sort: booths.length },
            area: { node: t.areaLabel, text: t.areaLabel },
            bill: t.outsourced ? gridPill('3PL bill') : { node: <span className={gridMuted}>-</span>, text: '' },
            rate: t.rateSen == null ? gridFlag('no rate') : t.rateSen,
            ours: {
              node: <input type="checkbox" className={gridTick} checked={t.inHouse} disabled={save.isPending} onChange={() => flip(t)}
                aria-label={`Ours: ${t.day} ${t.kind} ${t.venue}`} title={t.mark != null ? 'Set by Finance' : t.outsourced ? 'An outsourced bill covers this trip' : 'Our own lorry, by the rule'} />,
              text: t.inHouse ? 'Yes' : '', sort: t.inHouse ? 1 : 0,
            },
            income: t.amountSen,
          },
        });
      }
      const ours = list.filter((t) => t.inHouse).length;
      out.push({ id: `sub:${g.code}`, label: `Total ${g.name} · ${ours} of ${list.length} trips ours`, kind: 'sub', span: true, cells: { income: list.reduce((x, t) => x + t.amountSen, 0) } });
    }
    out.push({ id: 'total', label: 'Total Set/Dismantle Income', kind: 'final', span: true, cells: { income: p.trips.reduce((x, t) => x + t.amountSen, 0) } });
    return out;
  }, [p.trips, save.isPending]); // eslint-disable-line react-hooks/exhaustive-deps -- flip reads save, which isPending tracks
  const ours = p.trips.filter((t) => t.inHouse);
  const noRate = ours.filter((t) => t.rateSen == null).length;
  return (
    <>
      <h3 className={s.listTitle}>Set/Dismantle Income (in-house) · the trips <span className={s.hint}>{ours.length} of {p.trips.length} trips ours{noRate > 0 ? ` · ${noRate} in an area with no rate (not counted)` : ''}</span></h3>
      {p.tripsProblem && <p className={s.problem}>The fairs could not be read — {p.tripsProblem}. No trip is counted.</p>}
      {p.trips.length > 0 && (
        <FinanceGrid storageKey="logistics-trips" nameColumn={null} columns={TRIP_COLUMNS} rows={rows} title="Set/Dismantle Income (in-house) · the trips" ariaLabel="Setup and dismantle trips"
          foot={<span>One setup trip on a fair&rsquo;s first day and one dismantle trip on its last; booths at one venue on one day share a trip. A trip an outsourced bill covers is not ours: tick it if our lorry went anyway, untick one we did not do. The fair&rsquo;s own books carry the same charge.</span>} />
      )}
    </>
  );
}

/* ── The rate per trip, by area ────────────────────────────────────────────── */
function AreaRatesList({ rates }: { rates: LogisticsAreaRate[] }) {
  const rows: GridRow[] = rates.map((a) => ({
    id: a.key, label: a.label,
    cells: {
      region: { node: regionName(a.region), text: regionName(a.region) },
      rate: { node: <AreaRateInput a={a} />, text: a.rateSen == null ? 'no rate' : fmtMoney(a.rateSen), sort: a.rateSen ?? -1 },
    },
  }));
  return (
    <>
      <h3 className={s.listTitle}>Setup / dismantle rate per trip, by area <span className={s.hint}>Leave a rate empty for an area we do not price.</span></h3>
      <FinanceGrid storageKey="logistics-area-rates" nameColumn={{ label: 'Area', width: 180 }} title="Setup / dismantle rate per trip, by area" ariaLabel="Rates per trip by area"
        columns={[{ key: 'region', label: 'Region', kind: 'text', width: 120 }, { key: 'rate', label: 'Rate per trip', kind: 'text', width: 300 }]} rows={rows} />
    </>
  );
}

function AreaRateInput({ a }: { a: LogisticsAreaRate }) {
  const save = useSaveAreaRate();
  const shown = a.rateSen == null ? '' : String(a.rateSen / 100);
  const [text, setText] = useState(shown);
  useEffect(() => { setText(shown); }, [shown]);
  const dirty = text.trim() !== shown;
  const value = text.trim() === '' ? null : Number(text);
  const bad = value != null && (!Number.isFinite(value) || value < 0);
  return (
    <span className={s.inline}>
      <input type="number" min={0} step={1} value={text} placeholder="no rate" onChange={(e) => setText(e.target.value)} aria-label={`${a.label} rate per trip`} className={s.input} />
      {dirty && <button type="button" className={`${s.btn} ${s.btnSolid}`} disabled={bad || save.isPending} onClick={() => save.mutate({ area: a.key, rateRm: value })}>Save</button>}
      {!dirty && !a.isDefault && (
        <button type="button" className={s.btn} disabled={save.isPending} onClick={() => save.mutate({ area: a.key, reset: true })}>
          Default ({a.defaultRateSen == null ? 'no rate' : fmtMoney(a.defaultRateSen)})
        </button>
      )}
    </span>
  );
}

/* ── Upkeep and insurance & road tax, spread ───────────────────────────────── */
const SPREAD_COLUMNS: GridColumn[] = [
  { key: 'account', label: 'Account', kind: 'text', width: 220 },
  { key: 'what', label: 'What', kind: 'text', width: 260 },
  { key: 'bill', label: 'Bill', kind: 'money', width: 110 },
  { key: 'months', label: 'Months', kind: 'text', width: 230 },
  { key: 'per', label: 'Per month', kind: 'money', width: 110 },
  { key: 'here', label: 'In these months', kind: 'money', width: 130 },
];
function SpreadsList({ rows }: { rows: LogisticsSpreadRow[] }) {
  const grid: GridRow[] = rows.map((r) => ({
    id: r.lineId, label: fmtDateOrDash(r.day),
    cells: {
      account: { node: `${r.accountCode} · ${r.accountName ?? ''}`, text: `${r.accountCode} ${r.accountName ?? ''}`, title: r.accountName ?? undefined },
      what: { node: `${r.notes ?? '—'}${r.docNo ? ` · ${r.docNo}` : ''}`, text: r.notes ?? '', title: r.notes ?? undefined },
      bill: r.amountSen,
      months: { node: <SpreadInput r={r} />, text: String(r.months), sort: r.months },
      per: r.perMonthSen,
      here: r.inRangeSen,
    },
  }));
  return (
    <>
      <h3 className={s.listTitle}>Upkeep and road tax &amp; insurance · each bill spread <span className={s.hint}>Upkeep stays in its own month until you give it more; insurance &amp; road tax is spread over 12.</span></h3>
      {rows.length === 0 ? <p className={s.hint}>No upkeep or insurance bill reaches these months.</p> : (
        <FinanceGrid storageKey="logistics-spreads" nameColumn={{ label: 'Date', width: 110 }} columns={SPREAD_COLUMNS} rows={grid} title="Upkeep and road tax & insurance · each bill spread" ariaLabel="Upkeep and road tax spread" />
      )}
    </>
  );
}

function SpreadInput({ r }: { r: LogisticsSpreadRow }) {
  const save = useSaveSpread();
  const [text, setText] = useState(String(r.months));
  useEffect(() => { setText(String(r.months)); }, [r.months]);
  const n = Number(text);
  const ok = Number.isInteger(n) && n >= 1 && n <= 36;
  const dirty = text !== String(r.months);
  return (
    <span className={s.inline}>
      <input type="number" min={1} max={36} step={1} value={text} onChange={(e) => setText(e.target.value)} aria-label={`Months for ${r.notes ?? r.lineId}`} className={s.input} style={{ width: 56 }} />
      {dirty && <button type="button" className={`${s.btn} ${s.btnSolid}`} disabled={!ok || save.isPending} onClick={() => save.mutate({ lineId: r.lineId, months: n })}>Save</button>}
      {!dirty && !r.isDefault && <button type="button" className={s.btn} disabled={save.isPending} onClick={() => save.mutate({ lineId: r.lineId, months: null })}>Default</button>}
      {!dirty && <span className={gridMuted}>to {r.lastMonth}</span>}
    </span>
  );
}

/* ── What was billed extra ─────────────────────────────────────────────────── */
const INCOME_COLUMNS: GridColumn[] = [
  { key: 'date', label: 'Bill date', kind: 'text', width: 100 },
  { key: 'for', label: 'For', kind: 'text', width: 80 },
  { key: 'to', label: 'Billed to', kind: 'text', width: 200 },
  { key: 'row', label: 'Row', kind: 'text', width: 90 },
  { key: 'region', label: 'Region', kind: 'text', width: 150 },
  { key: 'line', label: 'Line', kind: 'text', width: 260 },
  { key: 'account', label: 'Account', kind: 'text', width: 200 },
  { key: 'amount', label: 'Amount', kind: 'money', width: 110 },
];
function IncomeList({ p }: { p: LogisticsPnl }) {
  const t = (x: string | null | undefined) => ({ node: x ?? '—', text: x ?? '', title: x ?? undefined });
  const rows: GridRow[] = p.income.map((l) => ({
    id: l.lineId, label: l.billNo,
    cells: {
      date: t(fmtDateOrDash(l.billDate)), for: t(l.month), to: t(l.debtorName), row: t(ROW_OF[l.row]),
      region: t(`${regionName(l.region)}${l.by === 'wording' ? ' (by its words)' : ''}`), line: t(l.description),
      account: t(`${l.accountCode} · ${l.accountName ?? ''}`), amount: l.amountSen,
    },
  }));
  return (
    <>
      <h3 className={s.listTitle}>Transport income billed · Other Debtor bills <span className={s.hint}>The month is the one the line names (SEP&rsquo;26), else the bill&rsquo;s.</span></h3>
      {rows.length === 0 ? <p className={s.hint}>No transport line on an Other Debtor bill for these months.</p> : (
        <FinanceGrid storageKey="logistics-income-lines" nameColumn={{ label: 'Bill', width: 150 }} columns={INCOME_COLUMNS} rows={rows} title="Transport income billed · Other Debtor bills" ariaLabel="Transport income billed" />
      )}
    </>
  );
}
