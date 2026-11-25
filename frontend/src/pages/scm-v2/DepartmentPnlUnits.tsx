// ----------------------------------------------------------------------------
// DepartmentPnlUnits — Operation, Logistics and Setup & dismantle in the Department
// P&L (owner 2026-11-25): what each is paid less its real cost, month by month, on
// the basis the page is on (Actual: the sales invoices; Performance: the orders):
//   • Operation — 7% of the selling department's sales excluding service and what
//     Finance bills for warehousing, less the 3% it passes on to Logistics (「还是这样
//     算7% 再减3%」) and the warehouse: its sheet's rows, every region added up;
//   • Logistics — the 3% from Operation, Finance's transport recharges and the
//     in-house setup / dismantle trips, less the delivery cost: the Logistics cost
//     report's rows (3PL, our lorries, the drivers' and helpers' pay);
//   • Setup & dismantle, Logistics' branch (「logistics report 的再分支」) — 1% of the
//     sales, less the fair transport as booked and the in-house trips it pays
//     Logistics for. Never the booth setup, which stays the Exhibition's.
// A charge opens its months at the rate; Operation's rows open the sheet's lines;
// Setup & dismantle's accounts their ledger lines. Server: GET /departments/unit.
// ----------------------------------------------------------------------------

import { useMemo, type ReactNode } from 'react';
import type { DepartmentUnit, DeptBasis, OpLine, OpRegion } from '../../vendor/scm/lib/department-queries';
import { DeptLinesPanel, DrillPanel, type DrillLedger, type DrillRow } from './DepartmentPnlLines';
import { FinanceGrid, fmtMoney, type GridRow } from './reports/FinanceGrid';
import { ReportExports, ReportHeaderActions, ReportMessage, ReportTiles, type ReportTile } from './reports/reportParts';
import { gridSheet, pctOf } from './logisticsColumns';
import { BASIS_WORDS, datesOf, monthColumns, pctText, rateText, scopeOf, short, spanText, whole, type Mode } from './departmentPnlParts';

/* ── The Operation sheet's lines as a panel prints them (the sheet and the unit share them) ── */

type RegionsOf = { regions: ReadonlyArray<{ code: OpRegion; name: string }>; logisticsIncomeBp: number };
export const regionNameOf = (p: Pick<RegionsOf, 'regions'>, r: OpRegion) => p.regions.find((x) => x.code === r)?.name ?? r;

/** The General ledger of the ledger lines opened: their accounts, from the earliest (a spread bill's own date). */
export const opLedger = (lines: readonly OpLine[], months: readonly string[]): DrillLedger => {
  const gl = lines.filter((l) => l.src === 'ledger' && l.accountCode);
  if (gl.length === 0) return null;
  const d = datesOf(months);
  return { codes: [...new Set(gl.map((l) => l.accountCode!))], from: gl.reduce((x, l) => (l.day && l.day < x ? l.day : x), d.from), to: d.to };
};

/** One Operation line as the panel prints it: what it is, where, how its amount was worked out. */
export function opDrillRow(p: RegionsOf, l: OpLine, sen: number, regions: readonly OpRegion[], row: string | null): DrillRow {
  const touched = regions.filter((r) => l.cells[r] !== 0);
  const where = touched.length > 1 && touched.length === p.regions.length ? 'All regions' : touched.map((r) => regionNameOf(p, r)).join(', ');
  let account = l.accountCode ? `${l.accountCode}${l.accountName ? ` · ${l.accountName}` : ''}` : null;
  /* Who was billed, then the bill line's words; a fair's name, then its venue. */
  let text = l.party && l.text ? (l.src === 'fair' ? `${l.text} · ${l.party}` : `${l.party} · ${l.text}`) : (l.text ?? l.party);
  let how: string | null = null;
  const h = l.how;
  if (h?.kind === 'shared') how = `DO-value share of the line ${fmtMoney(h.wholeSen)}`;
  else if (h?.kind === 'spread') how = `${short(l.month)}: month ${h.part}/${h.months} of the bill ${fmtMoney(h.wholeSen)}`;
  else if (h?.kind === 'fair') how = `Income ${fmtMoney(h.incomeSen)} less setup & dismantle ${fmtMoney(h.costSen)}`;
  else if (h?.kind === 'dos') { account = 'Logistics cost report'; text = `${h.count.toLocaleString('en-US')} delivery order${h.count === 1 ? '' : 's'}`; }
  else if (h?.kind === 'rate') text = `${rateText(h.bp)}% of the DO value ${fmtMoney(h.baseSen)}`;
  else if (h?.kind === 'transport') { account = 'Logistics cost report'; text = `Transport Income: ${rateText(p.logisticsIncomeBp)}% of the DO value ${fmtMoney(h.baseSen)}`; }
  else if (h?.kind === 'logistics') { account = 'Logistics cost report'; text = `Net ${fmtMoney(h.netSen)} less fair income ${fmtMoney(h.fairIncomeSen)}`; }
  return { id: l.id, day: l.day, month: l.month, row, region: where || null, ref: l.ref, account, text, how, sen };
}

/* ── A charge: each month's sales excluding service, at the rate ──────────── */

/** What a charge opens: each month of the column, its sales excluding service and the rate of it. */
export function RatePanel({ title, sub, bp, months, base, cells, onClose }: {
  title: string; sub: string; bp: number; months: readonly string[];
  base: Readonly<Record<string, number>>; cells: Readonly<Record<string, number>>; onClose: () => void;
}) {
  const rows: DrillRow[] = months.filter((m) => (cells[m] ?? 0) !== 0).map((m) => ({
    id: `rate:${m}`, day: null, month: m, row: null, region: null, ref: null, account: null,
    text: `${rateText(bp)}% of the month's sales excluding service, ${fmtMoney(base[m] ?? 0)}`, how: null, sen: cells[m] ?? 0,
  }));
  return <DrillPanel title={title} sub={sub} rows={rows} ledger={null} onClose={onClose} />;
}

/* ── One unit ─────────────────────────────────────────────────────────────── */

/** The note under a unit's table: where each of its figures comes from. */
function footOf(p: DepartmentUnit): ReactNode {
  if (p.unit === 'operation') return <>
    Operation is paid {rateText(p.rates.operationBp)}% of the selling department&rsquo;s sales excluding service and keeps what Finance bills for
    warehousing (WAREHOUSE and OPERATION CHARGES on Other Debtor bills); it pays Logistics {rateText(p.rates.logisticsBp)}% of the sales.
    Expenses are the warehouse rows of the Operation sheet (by DO, by region), every region added up. Every % is of the column&rsquo;s sales
    excluding service. Click a figure for the lines behind it.
  </>;
  if (p.unit === 'logistics') return <>
    Logistics is paid {rateText(p.rates.logisticsBp)}% of the selling department&rsquo;s sales excluding service by Operation, what Finance bills
    for transport and, where Setup &amp; dismantle pays for them, the in-house setup and dismantle trips. Expenses are the Logistics cost
    report&rsquo;s own rows: outsourced 3PL, our lorries&rsquo; running cost and the drivers&rsquo; and helpers&rsquo; pay — the report (by DO, by
    region and trip) has the lines behind each. Every % is of the column&rsquo;s sales excluding service.
  </>;
  return <>
    Setup &amp; dismantle, Logistics&rsquo; branch, is paid {rateText(p.rates.setupDismantleBp)}% of the selling department&rsquo;s sales excluding
    service for the fairs&rsquo; setup and dismantle transport. Expenses: the fair transport accounts as booked, and the in-house trips it pays
    Logistics for (the Logistics cost report&rsquo;s Setup &amp; Dismantle trips, at the area&rsquo;s rate). The booth setup stays in the
    Exhibition&rsquo;s own expenses. Click an account for its lines.
  </>;
}

/** The rate each charge row is at, keyed by the unit's own row keys. */
const rateOfRow = (p: DepartmentUnit, key: string): number | null => {
  if (key === 'from_selling') return p.unit === 'operation' ? p.rates.operationBp : p.unit === 'setupDismantle' ? p.rates.setupDismantleBp : null;
  if (key === 'from_operation' || key === 'to_logistics') return p.rates.logisticsBp;
  return null;
};

export function UnitReport({ p, basis, mode, showPct, period, tools }: {
  p: DepartmentUnit; basis: DeptBasis; mode: Mode; showPct: boolean; period: string;
  /** Above the table: the rate Finance keeps, a note. */
  tools: ReactNode;
}) {
  const columns = useMemo(() => monthColumns(p.months, mode, showPct), [p.months, mode, showPct]);
  const rows = useMemo<GridRow[]>(() => {
    const scope = scopeOf(p.months);
    const keys = columns.map((c) => c.key);
    const sumOf = (cells: Readonly<Record<string, number>>): Record<string, number> =>
      Object.fromEntries(keys.map((k) => [k, scope(k).reduce((x, m) => x + (cells[m] ?? 0), 0)]));
    const base = sumOf(p.base);
    const linesOf = new Map<string, OpLine[]>();
    for (const l of p.lines) linesOf.set(l.row, [...(linesOf.get(l.row) ?? []), l]);
    const ctx = { regions: p.regions, logisticsIncomeBp: p.rates.logisticsBp };
    const codes = p.regions.map((r) => r.code);
    const detailOf = (r: DepartmentUnit['rows'][number]): GridRow['detail'] => (colKey, close) => {
      const months = scope(colKey);
      const sub = colKey === 'T' ? `Total · ${spanText(p.months)}` : short(colKey);
      const bp = rateOfRow(p, r.key);
      if (bp != null) return <RatePanel title={r.label} sub={sub} bp={bp} months={months} base={p.base} cells={r.cells} onClose={close} />;
      if (p.unit === 'setupDismantle' && r.key !== 'in_house') {
        return <DeptLinesPanel title={r.label} sub={sub} onClose={close} ask={{ view: 'sd', basis, ...datesOf(months), keys: [r.key] }} />;
      }
      const picked = (linesOf.get(r.key) ?? []).filter((l) => months.includes(l.month))
        .map((l) => ({ l, sen: codes.reduce((x, c) => x + l.cells[c], 0) })).filter((x) => x.sen !== 0);
      if (picked.length === 0) return null;
      return <DrillPanel title={r.label} sub={sub} onClose={close} ledger={opLedger(picked.map((x) => x.l), months)} rows={picked.map(({ l, sen }) => opDrillRow(ctx, l, sen, codes, null))} />;
    };
    const line = (r: DepartmentUnit['rows'][number]): GridRow => {
      const cells = sumOf(r.cells);
      return { id: r.key, label: r.label, cells, pct: pctOf(cells, base), detail: detailOf(r) };
    };
    const per = (f: (m: DepartmentUnit['perMonth'][number]) => number) => sumOf(Object.fromEntries(p.perMonth.map((m) => [m.month, f(m)])));
    const income = per((m) => m.incomeSen);
    const expense = per((m) => m.expenseSen);
    const paid = per((m) => m.paidSen);
    const net = per((m) => m.netSen);
    const out: GridRow[] = [
      { id: 'base', label: `Sales excluding service (${BASIS_WORDS[basis].sales})`, kind: 'strong', cells: base, pct: pctOf(base, base) },
      { id: 'income', label: 'INCOME', totalLabel: 'Total income', kind: 'block', kids: p.rows.filter((r) => r.group === 'income').map(line), cells: income, pct: pctOf(income, base) },
      { id: 'expense', label: 'EXPENSES', totalLabel: 'Total expenses', kind: 'block', kids: p.rows.filter((r) => r.group === 'expense').map(line), cells: expense, pct: pctOf(expense, base) },
      {
        id: 'paid', label: 'PAID TO OTHER DEPARTMENTS', totalLabel: 'Total paid to other departments', kind: 'block',
        kids: p.rows.filter((r) => r.group === 'paid').map(line), cells: paid, pct: pctOf(paid, base),
      },
      { id: 'net', label: `${p.label.toUpperCase()} PROFIT / (LOSS)`, kind: 'final', cells: net, pct: pctOf(net, base) },
    ];
    return out.filter((r) => !r.kids || r.kids.length > 0);
  }, [p, columns, basis]);
  const tot = (f: (m: DepartmentUnit['perMonth'][number]) => number) => p.perMonth.reduce((x, m) => x + f(m), 0);
  const base = Object.values(p.base).reduce((a, b) => a + b, 0);
  const income = tot((m) => m.incomeSen); const expense = tot((m) => m.expenseSen); const net = tot((m) => m.netSen);
  const tiles: ReportTile[] = [
    { key: 'base', label: 'Sales excluding service', value: whole(base), sub: BASIS_WORDS[basis].sales },
    { key: 'income', label: `${p.label} income`, value: whole(income), sub: `${pctText(income, base)} of sales` },
    { key: 'expense', label: `${p.label} expenses`, value: whole(expense), sub: `${pctText(expense, base)} of sales` },
    { key: 'net', label: `${p.label} profit`, value: whole(net), tone: net < 0 ? 'late' : 'good', sub: `${pctText(net, base)} of sales` },
  ];
  const title = `Department P&L · ${p.label} · ${BASIS_WORDS[basis].name}`;
  const sheet = () => gridSheet({ title, subtitle: `${period} · RM`, period, nameLabel: 'Line', columns, rows, showPct });
  return (
    <>
      <ReportHeaderActions><ReportExports sheet={sheet} fileBase={`department-pnl-${p.unit}-${basis}-${p.from.slice(0, 7)}-${p.to.slice(0, 7)}`} /></ReportHeaderActions>
      <ReportTiles tiles={tiles} label={`${p.label} totals`} />
      {tools}
      {p.logisticsProblem && p.unit !== 'operation' && <ReportMessage>The fairs could not be read — {p.logisticsProblem}. The in-house setup and dismantle trips count none.</ReportMessage>}
      <FinanceGrid layoutKey={`department-pnl-unit|${p.unit}|${mode}|${showPct ? 1 : 0}`} nameColumn={{ label: 'Line', width: 400 }} columns={columns} rows={rows} showPct={showPct}
        title={title} subtitle={`${period} · RM`} ariaLabel={`Department P&L, ${p.label}`} drillKey={`${p.unit}|${basis}|${p.from}|${p.to}|${mode}`}
        foot={<span>{footOf(p)}</span>} />
    </>
  );
}
