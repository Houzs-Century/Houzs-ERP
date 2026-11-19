// ----------------------------------------------------------------------------
// DepartmentPnl — the Department P&L tab (owner 2026-11-19: an Operation report =
// his "Operation PNL - Auto" sheet, a G&A report = admin, IT, legal and HQ, and
// 「我要可以看全部的，也要可以看单独部门的」; nothing in no department). Each company
// has its own departments (its plan: Houzs — Exhibition, Operation, Logistics, G&A;
// 2990 — Showroom, G&A). Report style (FinanceGrid — the statement look), all from
// the books:
//   • All departments — the whole P&L on its own tree, each figure split across the
//     company's departments, Total = the P&L; an expense account no department
//     claims yet is named under the table, its figure in Total only;
//   • G&A — its share of the Performance sales against what it booked (the HQ
//     teams' payroll lines, the accounts and folds the plan gives G&A), the surplus;
//   • Operation — the owner's sheet by region (Penang | KL | SBH & SWK), or a
//     Total and one column per month; a % of the Delivery Order value beside;
//   • every other department its own P&L month by month — the Exhibition P&L (the
//     fairs' sales less their cost and what Exhibition booked), the Showroom P&L.
// Logistics is its own report (Logistics cost) and has no view here.
// Server: backend/src/scm/routes/acc-departments.ts. The view lives in the URL.
// ----------------------------------------------------------------------------

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { monthEnd, monthStart } from '../../lib/dateRangePresets';
import { fmtDateOrDash } from '../../vendor/shared/format';
import {
  useDepartmentPlan, useDepartmentView, useDepartmentsAll, useDepartmentsGa, useDepartmentsOperation, useSaveDepartmentRate, useSaveOperationSpread,
  type DepartmentView, type DepartmentsAll, type DepartmentsGa, type DepartmentsOperation, type DeptBlock, type DeptNode, type OpRegion,
} from '../../vendor/scm/lib/department-queries';
import { FinanceGrid, fmtMoney, gridMuted, type GridColumn, type GridRow } from './reports/FinanceGrid';
import { FinanceDateRange } from './reports/FinanceDateRange';
import {
  ReportExports, ReportHeaderActions, ReportMessage, ReportSwitch, ReportTiles, ReportTool, ReportToolbar, Segmented, useReportSubtitle,
  type ReportTile,
} from './reports/reportParts';
import { monthName } from './reports/statementColumns';
import { useReportRange } from './reports/useReportRange';
import { gridSheet, pctOf } from './logisticsColumns';
import s from './Logistics.module.css';

type Mode = 'single' | 'months';
const MODES: ReadonlyArray<{ value: Mode; label: string }> = [{ value: 'single', label: 'Whole range' }, { value: 'months', label: 'By month' }];

/** A tile's money: whole ringgit, a negative in brackets. */
const whole = (sen: number | null): string => {
  if (sen == null) return '—';
  const text = Math.round(Math.abs(sen) / 100).toLocaleString('en-US');
  return sen < 0 ? `(${text})` : text;
};
const pctText = (part: number, base: number) => (base !== 0 ? `${((part / base) * 100).toFixed(1)}%` : '—');
const short = (m: string) => monthName(`${m}-01`);
const rateText = (bp: number) => (bp / 100).toFixed(2).replace(/\.?0+$/, '');

export const DepartmentPnlTab = () => {
  const r = useReportRange();
  const [params, setParams] = useSearchParams();
  const plan = useDepartmentPlan();
  /* All, then each department of the company that has a view of its own. */
  const views = useMemo(() => [
    { value: 'all', label: 'All departments', kind: 'all' as const },
    ...(plan.data?.departments ?? []).filter((d) => d.view != null).map((d) => ({ value: d.key as string, label: d.label, kind: d.view! })),
  ], [plan.data]);
  /* A department the address names waits for the plan; anything else is All. */
  const wanted = params.get('dv');
  const current = views.find((v) => v.value === wanted) ?? (plan.data || !wanted ? views[0]! : null);
  const kind = current?.kind ?? null;
  const mode: Mode = params.get('dm') === 'months' ? 'months' : 'single';
  const split = params.get('dsplit') === '1';
  const showPct = params.get('dpct') !== '0';
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
  useReportSubtitle(`${period}${partMonths ? ' · whole months' : ''}${current ? ` · ${current.label}` : ''} · RM`);

  const all = useDepartmentsAll(from, to, kind === 'all');
  const ga = useDepartmentsGa(from, to, kind === 'ga');
  const op = useDepartmentsOperation(from, to, kind === 'operation');
  const dept = useDepartmentView(current?.value ?? '', from, to, kind === 'dept');
  const q = kind === 'all' ? all : kind === 'ga' ? ga : kind === 'operation' ? op : kind === 'dept' ? dept : plan;
  const pctLabel = kind === 'ga' ? '% of Performance sales' : kind === 'operation' ? '% of DO' : '% of sales';

  return (
    <>
      <ReportToolbar>
        <FinanceDateRange label="Months" />
        <ReportTool label="Department"><Segmented options={views} value={current?.value ?? 'all'} onChange={(v) => setParam('dv', v === 'all' ? null : v)} label="Department" /></ReportTool>
        {kind != null && kind !== 'all' && <ReportTool label="Show"><Segmented options={MODES} value={mode} onChange={(v) => setParam('dm', v === 'single' ? null : v)} label="Whole range or by month" /></ReportTool>}
        {kind != null && kind !== 'all' && <ReportSwitch on={showPct} onChange={(v) => setParam('dpct', v ? null : '0')}>{pctLabel}</ReportSwitch>}
        {kind === 'operation' && mode === 'months' && <ReportSwitch on={split} onChange={(v) => setParam('dsplit', v ? '1' : null)}>Split each month by region</ReportSwitch>}
      </ReportToolbar>
      {!r.usable && <ReportMessage>Pick dates.</ReportMessage>}
      {plan.isError && <ReportMessage tone="error">The departments could not be read — {plan.error instanceof Error ? plan.error.message : String(plan.error)}</ReportMessage>}
      {q.isError && <ReportMessage tone="error">The report could not be read — {q.error instanceof Error ? q.error.message : String(q.error)}</ReportMessage>}
      {q.isLoading && <ReportTiles tiles={['Income', 'Expenses', 'Result'].map((label) => ({ key: label, label, value: '' }))} label="Department totals" pending />}
      {kind === 'all' && all.data && <AllView p={all.data} period={period} />}
      {kind === 'ga' && ga.data && <GaView p={ga.data} mode={mode} showPct={showPct} period={period} />}
      {kind === 'operation' && op.data && <OperationView p={op.data} mode={mode} split={split} showPct={showPct} period={period} />}
      {kind === 'dept' && dept.data && <DeptView p={dept.data} mode={mode} showPct={showPct} period={period} />}
    </>
  );
};

/* ── A node of the P&L's tree as a grid row ───────────────────────────────── */
function nodeRows(nodes: readonly DeptNode[], cellsOf: (n: DeptNode) => Record<string, number>): GridRow[] {
  return nodes.map((n) => (n.children.length > 0
    ? { id: n.id, label: n.label, kids: nodeRows(n.children, cellsOf), totalLabel: `Total ${n.label}`, cells: cellsOf(n) }
    : { id: n.id, label: n.label, cells: cellsOf(n) }));
}

/* ── All departments ──────────────────────────────────────────────────────── */
function AllView({ p, period }: { p: DepartmentsAll; period: string }) {
  const columns = useMemo<GridColumn[]>(() => [
    ...p.columns.map((c) => ({ key: c.key, label: c.label, kind: 'money' as const, width: 150 })),
    { key: 'T', label: 'Total', sub: 'the P&L', kind: 'money', width: 150, total: true, edge: true },
  ], [p.columns]);
  const rows = useMemo<GridRow[]>(() => {
    const depts = p.columns.map((c) => c.key);
    const cellsOf = (n: DeptNode): Record<string, number> => ({ ...Object.fromEntries(depts.map((k) => [k, n.cells?.[k] ?? 0])), T: n.amountSen });
    const block = (b: DeptBlock): Record<string, number> => ({ ...Object.fromEntries(depts.map((k) => [k, p.blockTotals[b][k] ?? 0])), T: sumBlock(p, b) });
    const minus = (a: Record<string, number>, b: Record<string, number>): Record<string, number> =>
      Object.fromEntries(Object.keys(a).map((k) => [k, (a[k] ?? 0) - (b[k] ?? 0)]));
    const plus = (a: Record<string, number>, b: Record<string, number>): Record<string, number> =>
      Object.fromEntries(Object.keys(a).map((k) => [k, (a[k] ?? 0) + (b[k] ?? 0)]));
    const group = (b: DeptBlock, label: string, totalLabel: string): GridRow =>
      ({ id: b, label, totalLabel, kind: 'block', kids: nodeRows(p.tree[b], cellsOf), cells: block(b) });
    const gross = minus(block('tradingIncome'), block('costOfSales'));
    const beforeTax = minus(plus(gross, block('otherIncome')), block('expenses'));
    const net = minus(beforeTax, block('taxation'));
    const expenses = group('expenses', 'EXPENSES', 'Total expenses');
    /* An expense account no department claims yet: named, its figure in Total only. */
    const noneSen = p.unassigned.lines.reduce((x, l) => x + l.amountSen, 0);
    if (noneSen !== 0) {
      expenses.kids = [...(expenses.kids ?? []), {
        id: 'unassigned', label: `${p.unassigned.label} — set its Department on the Chart of Accounts`, kind: 'warn',
        cells: { ...Object.fromEntries(depts.map((k) => [k, null])), T: noneSen },
      }];
    }
    const out: GridRow[] = [
      group('tradingIncome', 'TRADING INCOME', 'Total trading income'),
      group('costOfSales', 'COST OF SALES', 'Total cost of sales'),
      { id: 'gross', label: 'GROSS PROFIT', kind: 'strong', cells: gross },
      group('otherIncome', 'OTHER INCOME', 'Total other income'),
      expenses,
      { id: 'pbt', label: 'PROFIT BEFORE TAXATION', kind: 'strong', cells: beforeTax },
      group('taxation', 'TAXATION', 'Total taxation'),
      { id: 'net', label: 'NET PROFIT / (LOSS)', kind: 'final', cells: net },
    ];
    return out.filter((x) => !x.kids || x.kids.length > 0);
  }, [p]);
  const t = p.totals;
  const tiles: ReportTile[] = [
    ...p.columns.map((c) => {
      const sen = p.blockTotals.expenses[c.key] ?? 0;
      return { key: c.key, label: `${c.label} expenses`, value: whole(sen), sub: `${pctText(sen, t.expensesSen)} of all expenses` };
    }),
    { key: 'net', label: 'Net profit', value: whole(t.netProfitSen), tone: t.netProfitSen < 0 ? 'late' : 'good', sub: 'as the P&L' },
  ];
  const sheet = () => gridSheet({ title: 'Department P&L · all departments', subtitle: `${period} · RM`, period, nameLabel: 'Account', columns, rows, showPct: false });
  return (
    <>
      <ReportHeaderActions><ReportExports sheet={sheet} fileBase={`department-pnl-all-${p.from.slice(0, 7)}-${p.to.slice(0, 7)}`} /></ReportHeaderActions>
      <ReportTiles tiles={tiles} label="Department totals" />
      {p.unassigned.lines.length > 0 && (
        <ReportMessage tone="error">
          {p.unassigned.label}: {p.unassigned.lines.map((l) => `${l.code} · ${l.name} (${fmtMoney(l.amountSen)})`).join('; ')} — give each a Department (or a Logistics row) on the Chart of Accounts.
        </ReportMessage>
      )}
      <FinanceGrid layoutKey="department-pnl-all" nameColumn={{ label: 'Account', width: 420 }} columns={columns} rows={rows}
        title="Department P&L · all departments" subtitle={`${period} · RM`} ariaLabel="Department P&L, all departments" drillKey={`${p.from}|${p.to}`}
        foot={<span>
          Every figure as booked, by journal date — Total is the P&L. A payroll account splits by the salary journal&rsquo;s team lines (a line
          naming no team is the selling department&rsquo;s); a job ad by the post it names; an Other Debtor recharge by its words (OPERATION /
          WAREHOUSE CHARGES to Operation, LOGISTICS CHARGES to Logistics); sales and cost of sales are the selling department&rsquo;s; every other
          account by the Chart of Accounts&rsquo; Department and Logistics columns, a department this company does not have counting where its
          plan puts it. The G&amp;A and Operation views add their shares of sales and spread insurance and upkeep over months.
          {p.stock.closingProvisional ? ' The closing stock is provisional until the month is closed.' : ''}
        </span>} />
    </>
  );
}
const sumBlock = (p: DepartmentsAll, b: DeptBlock): number => p.tree[b].reduce((x, n) => x + n.amountSen, 0);

/* ── G&A ──────────────────────────────────────────────────────────────────── */
function GaView({ p, mode, showPct, period }: { p: DepartmentsGa; mode: Mode; showPct: boolean; period: string }) {
  const columns = useMemo<GridColumn[]>(() => {
    const span = p.months.length === 1 ? short(p.months[0]!) : `${short(p.months[0]!)} – ${short(p.months[p.months.length - 1]!)}`;
    const total: GridColumn = { key: 'T', label: 'Total', sub: span, kind: 'money', width: showPct ? 172 : 130, total: true, edge: mode === 'months' };
    return mode === 'single' ? [total] : [total, ...p.months.map((m) => ({ key: m, label: short(m), kind: 'money' as const, width: showPct ? 172 : 120 }))];
  }, [p.months, mode, showPct]);
  const rows = useMemo<GridRow[]>(() => {
    const scope = (key: string): string[] => (key === 'T' ? p.months : [key]);
    const keys = columns.map((c) => c.key);
    const by = (f: (m: DepartmentsGa['perMonth'][number]) => number): Record<string, number> =>
      Object.fromEntries(keys.map((k) => [k, p.perMonth.filter((m) => scope(k).includes(m.month)).reduce((x, m) => x + f(m), 0)]));
    const cellsOf = (n: DeptNode): Record<string, number> => Object.fromEntries(keys.map((k) => [k, scope(k).reduce((x, m) => x + (n.cells?.[m] ?? 0), 0)]));
    const sales = by((m) => m.salesSen);
    const share = by((m) => m.shareSen);
    const expense = by((m) => m.expenseSen);
    const surplus = by((m) => m.surplusSen);
    return [
      { id: 'sales', label: 'Performance sales', kind: 'strong', cells: sales, pct: pctOf(sales, sales) },
      { id: 'share', label: `G&A share (${rateText(p.shareBp)}% of Performance sales)`, cells: share, pct: pctOf(share, sales) },
      { id: 'expenses', label: 'G&A EXPENSES', totalLabel: 'Total G&A expenses', kind: 'block', kids: withPct(nodeRows(p.tree, cellsOf), sales), cells: expense, pct: pctOf(expense, sales) },
      { id: 'surplus', label: 'SURPLUS / (DEFICIT)', kind: 'final', cells: surplus, pct: pctOf(surplus, sales) },
    ];
  }, [p, columns]);
  const tot = (f: (m: DepartmentsGa['perMonth'][number]) => number) => p.perMonth.reduce((x, m) => x + f(m), 0);
  const sales = tot((m) => m.salesSen); const share = tot((m) => m.shareSen); const expense = tot((m) => m.expenseSen); const surplus = tot((m) => m.surplusSen);
  const tiles: ReportTile[] = [
    { key: 'sales', label: 'Performance sales', value: whole(sales), sub: 'orders by SO date' },
    { key: 'share', label: 'G&A share', value: whole(share), sub: `${rateText(p.shareBp)}% of Performance sales` },
    { key: 'expense', label: 'G&A expenses', value: whole(expense), sub: `${pctText(expense, sales)} of Performance sales` },
    { key: 'surplus', label: 'Surplus / (deficit)', value: whole(surplus), tone: surplus < 0 ? 'late' : 'good', sub: surplus < 0 ? '▼ G&A spent more than its share' : '▲ G&A spent within its share' },
  ];
  const sheet = () => gridSheet({ title: 'Department P&L · G&A', subtitle: `${period} · RM`, period, nameLabel: 'Account', columns, rows, showPct });
  return (
    <>
      <ReportHeaderActions><ReportExports sheet={sheet} fileBase={`department-pnl-ga-${p.from.slice(0, 7)}-${p.to.slice(0, 7)}`} /></ReportHeaderActions>
      <ReportTiles tiles={tiles} label="G&A totals" />
      <div className={s.rates}><RateBox dept="ga" bp={p.shareBp} what="G&A share = Performance sales ×" /></div>
      <FinanceGrid layoutKey={`department-pnl-ga|${mode}|${showPct ? 1 : 0}`} nameColumn={{ label: 'Account', width: 380 }} columns={columns} rows={rows} showPct={showPct}
        title="Department P&L · G&A" subtitle={`${period} · RM`} ariaLabel="Department P&L, G&A" drillKey={`${p.from}|${p.to}|${mode}`}
        foot={<span>
          G&amp;A = admin, IT, legal and HQ: the payroll lines of the Director office, Finance, HR, IT, Management and Other teams (the salary
          journal&rsquo;s own words), and every account the Chart of Accounts&rsquo; Department column gives G&amp;A — by journal date. Every % is of the
          column&rsquo;s Performance sales (the Performance P&amp;L&rsquo;s own: orders by SO date, delivered or not).
        </span>} />
      <TeamsList p={p} />
    </>
  );
}
const withPct = (rows: GridRow[], base: Record<string, number>): GridRow[] =>
  rows.map((r) => ({ ...r, pct: pctOf(r.cells, base), ...(r.kids ? { kids: withPct(r.kids, base) } : {}) }));

const TEAM_COLUMNS: GridColumn[] = [
  { key: 'team', label: 'Team', kind: 'text', width: 170 },
  { key: 'account', label: 'Account', kind: 'text', width: 110 },
  { key: 'line', label: 'Line', kind: 'text', width: 360 },
  { key: 'amount', label: 'Amount', kind: 'money', width: 120 },
];
function TeamsList({ p }: { p: DepartmentsGa }) {
  const rows: GridRow[] = p.teams.flatMap((t) => t.lines.map((l) => ({
    id: l.lineId, label: fmtDateOrDash(l.day),
    cells: {
      team: { node: t.label, text: t.label }, account: { node: l.accountCode, text: l.accountCode },
      line: { node: l.notes ?? '—', text: l.notes ?? '', title: l.notes ?? undefined }, amount: l.amountSen,
    },
  })));
  return (
    <>
      <h3 className={s.listTitle}>HQ payroll lines counted <span className={s.hint}>A salary-journal line counts for the team its words name (FINANCE - SALARY - OCT2026).</span></h3>
      {rows.length === 0 ? <p className={s.hint}>No HQ team&rsquo;s payroll line in these months.</p> : (
        <FinanceGrid layoutKey="department-pnl-ga-teams" nameColumn={{ label: 'Date', width: 124 }} columns={TEAM_COLUMNS} rows={rows} title="HQ payroll lines counted" ariaLabel="HQ payroll lines counted" />
      )}
    </>
  );
}

/* ── One department's own P&L (Exhibition, Showroom) ──────────────────────── */
function DeptView({ p, mode, showPct, period }: { p: DepartmentView; mode: Mode; showPct: boolean; period: string }) {
  const columns = useMemo<GridColumn[]>(() => {
    const span = p.months.length === 1 ? short(p.months[0]!) : `${short(p.months[0]!)} – ${short(p.months[p.months.length - 1]!)}`;
    const total: GridColumn = { key: 'T', label: 'Total', sub: span, kind: 'money', width: showPct ? 172 : 130, total: true, edge: mode === 'months' };
    return mode === 'single' ? [total] : [total, ...p.months.map((m) => ({ key: m, label: short(m), kind: 'money' as const, width: showPct ? 172 : 120 }))];
  }, [p.months, mode, showPct]);
  const rows = useMemo<GridRow[]>(() => {
    const scope = (key: string): string[] => (key === 'T' ? p.months : [key]);
    const keys = columns.map((c) => c.key);
    const by = (f: (m: DepartmentView['perMonth'][number]) => number): Record<string, number> =>
      Object.fromEntries(keys.map((k) => [k, p.perMonth.filter((m) => scope(k).includes(m.month)).reduce((x, m) => x + f(m), 0)]));
    const cellsOf = (n: DeptNode): Record<string, number> => Object.fromEntries(keys.map((k) => [k, scope(k).reduce((x, m) => x + (n.cells?.[m] ?? 0), 0)]));
    const sales = by((m) => m.salesSen);
    const group = (b: DeptBlock, label: string, totalLabel: string, cells: Record<string, number>): GridRow =>
      ({ id: b, label, totalLabel, kind: 'block', kids: withPct(nodeRows(p.tree[b], cellsOf), sales), cells, pct: pctOf(cells, sales) });
    const gross = by((m) => m.grossSen);
    const net = by((m) => m.netSen);
    const out: GridRow[] = [
      group('tradingIncome', 'SALES', 'Total sales', sales),
      group('costOfSales', 'COST OF SALES', 'Total cost of sales', by((m) => m.costOfSalesSen)),
      { id: 'gross', label: 'GROSS PROFIT', kind: 'strong', cells: gross, pct: pctOf(gross, sales) },
      group('otherIncome', 'OTHER INCOME', 'Total other income', by((m) => m.otherIncomeSen)),
      group('expenses', `${p.label.toUpperCase()} EXPENSES`, `Total ${p.label} expenses`, by((m) => m.expensesSen)),
      group('taxation', 'TAXATION', 'Total taxation', by((m) => m.taxationSen)),
      { id: 'net', label: `${p.label.toUpperCase()} PROFIT / (LOSS)`, kind: 'final', cells: net, pct: pctOf(net, sales) },
    ];
    return out.filter((x) => !x.kids || x.kids.length > 0);
  }, [p, columns]);
  const tot = (f: (m: DepartmentView['perMonth'][number]) => number) => p.perMonth.reduce((x, m) => x + f(m), 0);
  const sales = tot((m) => m.salesSen); const gross = tot((m) => m.grossSen); const expenses = tot((m) => m.expensesSen); const net = tot((m) => m.netSen);
  const tiles: ReportTile[] = [
    { key: 'sales', label: 'Sales', value: whole(sales), sub: 'as booked' },
    { key: 'gross', label: 'Gross profit', value: whole(gross), sub: `${pctText(gross, sales)} of sales` },
    { key: 'expenses', label: `${p.label} expenses`, value: whole(expenses), sub: `${pctText(expenses, sales)} of sales` },
    { key: 'net', label: `${p.label} profit`, value: whole(net), tone: net < 0 ? 'late' : 'good', sub: `${pctText(net, sales)} of sales` },
  ];
  const title = `Department P&L · ${p.label}`;
  const sheet = () => gridSheet({ title, subtitle: `${period} · RM`, period, nameLabel: 'Account', columns, rows, showPct });
  return (
    <>
      <ReportHeaderActions><ReportExports sheet={sheet} fileBase={`department-pnl-${p.dept}-${p.from.slice(0, 7)}-${p.to.slice(0, 7)}`} /></ReportHeaderActions>
      <ReportTiles tiles={tiles} label={`${p.label} totals`} />
      <FinanceGrid layoutKey={`department-pnl-dept|${mode}|${showPct ? 1 : 0}`} nameColumn={{ label: 'Account', width: 380 }} columns={columns} rows={rows} showPct={showPct}
        title={title} subtitle={`${period} · RM`} ariaLabel={`Department P&L, ${p.label}`} drillKey={`${p.dept}|${p.from}|${p.to}|${mode}`}
        foot={<span>
          The {p.label} column of All departments, month by month: the books by journal date — sales and cost of sales as the P&amp;L has them,
          less what the {p.label} department booked. Every % is of the column&rsquo;s sales.
        </span>} />
    </>
  );
}

/* ── Operation ────────────────────────────────────────────────────────────── */
type OpRegionCol = DepartmentsOperation['regions'][number];
type Scope = { months: string[]; regions: OpRegion[] };

/** Single month = the sheet's regions across the top and a Total; By month = a Total, then
    one column per month, or each month's regions and its total. The regions are the server's. */
function opColumns(regions: readonly OpRegionCol[], months: readonly string[], mode: Mode, split: boolean, width: number): { columns: GridColumn[]; scopes: Map<string, Scope> } {
  const scopes = new Map<string, Scope>();
  const columns: GridColumn[] = [];
  const add = (c: GridColumn, sc: Scope) => { columns.push(c); scopes.set(c.key, sc); };
  const all = [...months];
  const codes = regions.map((r) => r.code);
  const span = all.length === 1 ? short(all[0]!) : `${short(all[0]!)} – ${short(all[all.length - 1]!)}`;
  if (mode === 'single') {
    for (const r of regions) add({ key: r.code, label: r.name, kind: 'money', width }, { months: all, regions: [r.code] });
    add({ key: 'T', label: 'Total', sub: span, kind: 'money', width, total: true }, { months: all, regions: codes });
    return { columns, scopes };
  }
  add({ key: 'T:all', label: 'Total', sub: `${all.length} month${all.length === 1 ? '' : 's'}`, kind: 'money', width, total: true, edge: true }, { months: all, regions: codes });
  for (const m of all) {
    if (!split) { add({ key: m, label: short(m), kind: 'money', width }, { months: [m], regions: codes }); continue; }
    for (const r of regions) add({ key: `${m}:${r.code}`, label: r.name, group: short(m), kind: 'money', width }, { months: [m], regions: [r.code] });
    add({ key: `${m}:T`, label: 'Total', group: short(m), kind: 'money', width, total: true, edge: true }, { months: [m], regions: codes });
  }
  return { columns, scopes };
}

function OperationView({ p, mode, split, showPct, period }: { p: DepartmentsOperation; mode: Mode; split: boolean; showPct: boolean; period: string }) {
  const { columns, scopes } = useMemo(() => opColumns(p.regions, p.months, mode, split, showPct ? 172 : 120), [p.regions, p.months, mode, split, showPct]);
  const codes = useMemo(() => p.regions.map((r) => r.code), [p.regions]);
  const byMonth = useMemo(() => new Map(p.perMonth.map((m) => [m.month, m] as const)), [p]);
  const rows = useMemo<GridRow[]>(() => {
    const label = (k: string) => p.rows.find((x) => x.key === k)?.label ?? k;
    const money = (k: string): Record<string, number> => {
      const out: Record<string, number> = {};
      for (const [key, sc] of scopes) {
        let v = 0;
        for (const m of sc.months) { const mm = byMonth.get(m); if (mm) for (const r of sc.regions) v += mm.rows[k]?.[r] ?? 0; }
        out[key] = v;
      }
      return out;
    };
    const doValue = money('do_value');
    const line = (k: string, kind?: GridRow['kind']): GridRow => { const cells = money(k); return { id: k, label: label(k), kind, cells, pct: pctOf(cells, doValue) }; };
    const has = (k: string) => p.perMonth.some((m) => codes.some((r) => (m.rows[k]?.[r] ?? 0) !== 0));
    const shown = p.rows.filter((x) => !x.optional || has(x.key));
    const out: GridRow[] = [];
    const total = p.rows.find((x) => x.group === 'expense_total');
    for (const x of shown) {
      if (x.group === 'expense_total') continue;
      if (x.group === 'expense') {
        if (out.some((r) => r.id === 'warehouse')) continue;
        const cells = money(total?.key ?? 'total_expense');
        out.push({
          id: 'warehouse', label: 'Expense:- Warehouse', totalLabel: total?.label ?? 'Total', kind: 'block',
          kids: shown.filter((k) => k.group === 'expense').map((k) => line(k.key)), cells, pct: pctOf(cells, doValue),
        });
        continue;
      }
      out.push(line(x.key, x.kind === 'line' ? undefined : x.kind));
    }
    return out;
  }, [p, scopes, byMonth, codes]);
  const total = (k: string) => p.perMonth.reduce((x, m) => x + codes.reduce((y, r) => y + (m.rows[k]?.[r] ?? 0), 0), 0);
  const doValue = total('do_value');
  const tiles: ReportTile[] = [
    { key: 'do', label: 'Delivery Order', value: whole(doValue), sub: `${p.perMonth.reduce((x, m) => x + codes.reduce((y, r) => y + m.dos[r], 0), 0).toLocaleString('en-US')} DOs` },
    { key: 'gross', label: 'Gross profit', value: whole(total('gross')), sub: `${pctText(total('gross'), doValue)} of DO value` },
    { key: 'exp', label: 'Warehouse expenses', value: whole(total('total_expense')), sub: `${pctText(total('total_expense'), doValue)} of DO value` },
    { key: 'net', label: 'Net after logistics & setup/dismantle', value: whole(total('net_after')), tone: total('net_after') < 0 ? 'late' : 'good', sub: `${pctText(total('net_after'), doValue)} of DO value` },
  ];
  const sheet = () => gridSheet({ title: 'Department P&L · Operation', subtitle: `${period} · RM`, period, nameLabel: 'Category', columns, rows, showPct });
  return (
    <>
      <ReportHeaderActions><ReportExports sheet={sheet} fileBase={`department-pnl-operation-${p.from.slice(0, 7)}-${p.to.slice(0, 7)}`} /></ReportHeaderActions>
      <ReportTiles tiles={tiles} label="Operation totals" />
      <div className={s.rates}>
        <RateBox dept="operation" bp={p.incomeBp} what="Operation income = DO value ×" />
        <span className={s.rate}>(-) Logistic Expense = the Logistics cost report&rsquo;s Transport Income ({rateText(p.logisticsIncomeBp)}% of DO), set there.</span>
      </div>
      {p.logisticsProblem && <ReportMessage>The fairs could not be read — {p.logisticsProblem}. Profit / (Loss) From Setup/Dismantle counts no fair.</ReportMessage>}
      <FinanceGrid layoutKey={`department-pnl-operation|${mode}|${split ? 1 : 0}|${showPct ? 1 : 0}`} nameColumn={{ label: 'Category', width: 400 }} columns={columns} rows={rows} showPct={showPct}
        title="Operation cost" subtitle={`${period} · RM`} ariaLabel="Department P&L, Operation" drillKey={`${p.from}|${p.to}|${mode}|${split}`}
        foot={<span>
          Every % is of the Delivery Order value in its column; KL carries Singapore. Warehouse rows: the Chart of Accounts&rsquo; Department column (each
          account&rsquo;s row and region). Manpower: the salary journal&rsquo;s LOGISTIC (ADMIN), WAREHOUSE OPERATIONS, PROCUREMENT and OPERATION
          STOREKEEPER lines — a line naming its region (PG / KL / SBH) is that region&rsquo;s, else shared by the month&rsquo;s DO value. Income: the
          WAREHOUSE CHARGES and OPERATION CHARGES lines on Other Debtor bills, in the month they name. From Logistics = the Logistics cost
          report&rsquo;s net less its fair income; From Setup/Dismantle = each fair&rsquo;s transport income less its setup and dismantle transport.
        </span>} />
      <ManpowerList p={p} />
      <OpIncomeList p={p} />
      <OpSpreadsList p={p} />
    </>
  );
}

const regionNameOf = (p: DepartmentsOperation, r: OpRegion) => p.regions.find((x) => x.code === r)?.name ?? r;
const text = (x: string | null | undefined) => ({ node: x ?? '—', text: x ?? '', title: x ?? undefined });

const MANPOWER_COLUMNS: GridColumn[] = [
  { key: 'row', label: 'Row', kind: 'text', width: 250 },
  { key: 'line', label: 'Line', kind: 'text', width: 330 },
  { key: 'region', label: 'Region', kind: 'text', width: 340 },
  { key: 'amount', label: 'Amount', kind: 'money', width: 120 },
];
function ManpowerList({ p }: { p: DepartmentsOperation }) {
  const label = (k: string) => p.rows.find((x) => x.key === k)?.label ?? k;
  const rows: GridRow[] = p.manpower.map((l) => ({
    id: l.lineId, label: fmtDateOrDash(l.day),
    cells: {
      row: text(label(l.row)), line: text(l.notes),
      region: text(l.region ? regionNameOf(p, l.region) : `by DO value · ${p.regions.filter((r) => l.cells[r.code] !== 0).map((r) => `${r.name} ${fmtMoney(l.cells[r.code])}`).join(' · ')}`),
      amount: l.amountSen,
    },
  }));
  return (
    <>
      <h3 className={s.listTitle}>Warehouse manpower · the salary journal&rsquo;s lines <span className={s.hint}>Write the region in the line (OPERATION STOREKEEPER PG SALARY) to put it in that region.</span></h3>
      {rows.length === 0 ? <p className={s.hint}>No warehouse team&rsquo;s payroll line in these months.</p> : (
        <FinanceGrid layoutKey="department-pnl-op-manpower" nameColumn={{ label: 'Date', width: 124 }} columns={MANPOWER_COLUMNS} rows={rows} title="Warehouse manpower" ariaLabel="Warehouse manpower lines" />
      )}
    </>
  );
}

const OP_INCOME_COLUMNS: GridColumn[] = [
  { key: 'date', label: 'Bill date', kind: 'text', width: 100 },
  { key: 'for', label: 'For', kind: 'text', width: 80 },
  { key: 'to', label: 'Billed to', kind: 'text', width: 200 },
  { key: 'row', label: 'Row', kind: 'text', width: 200 },
  { key: 'region', label: 'Region', kind: 'text', width: 110 },
  { key: 'line', label: 'Line', kind: 'text', width: 260 },
  { key: 'amount', label: 'Amount', kind: 'money', width: 110 },
];
function OpIncomeList({ p }: { p: DepartmentsOperation }) {
  const label = (k: string) => p.rows.find((x) => x.key === k)?.label ?? k;
  const rows: GridRow[] = p.income.map((l) => ({
    id: l.lineId, label: l.billNo,
    cells: {
      date: text(fmtDateOrDash(l.billDate)), for: text(l.month), to: text(l.debtorName), row: text(label(l.key)),
      region: text(regionNameOf(p, l.region)), line: text(l.description), amount: l.amountSen,
    },
  }));
  return (
    <>
      <h3 className={s.listTitle}>Operation income billed · Other Debtor bills <span className={s.hint}>Bill WAREHOUSE CHARGES - NOV&rsquo;26 or OPERATION CHARGES - NOV&rsquo;26; the month is the one the line names.</span></h3>
      {rows.length === 0 ? <p className={s.hint}>No WAREHOUSE or OPERATION CHARGES line on an Other Debtor bill for these months.</p> : (
        <FinanceGrid layoutKey="department-pnl-op-income" nameColumn={{ label: 'Bill', width: 150 }} columns={OP_INCOME_COLUMNS} rows={rows} title="Operation income billed" ariaLabel="Operation income billed" />
      )}
    </>
  );
}

const SPREAD_COLUMNS: GridColumn[] = [
  { key: 'account', label: 'Account', kind: 'text', width: 240 },
  { key: 'what', label: 'What', kind: 'text', width: 260 },
  { key: 'bill', label: 'Bill', kind: 'money', width: 110 },
  { key: 'months', label: 'Months', kind: 'text', width: 230 },
  { key: 'per', label: 'Per month', kind: 'money', width: 110 },
  { key: 'here', label: 'In these months', kind: 'money', width: 130 },
];
function OpSpreadsList({ p }: { p: DepartmentsOperation }) {
  const rows: GridRow[] = p.spreads.map((r) => ({
    id: r.lineId, label: fmtDateOrDash(r.day),
    cells: {
      account: text(`${r.accountCode} · ${r.accountName ?? ''}`),
      what: text(`${r.notes ?? '—'}${r.docNo ? ` · ${r.docNo}` : ''}`),
      bill: r.amountSen,
      months: { node: <SpreadInput r={r} />, text: String(r.months), sort: r.months },
      per: r.perMonthSen, here: r.inRangeSen,
    },
  }));
  return (
    <>
      <h3 className={s.listTitle}>Warehouse upkeep and insurance · each bill spread <span className={s.hint}>Upkeep stays in its own month until you give it more; insurance is spread over 12.</span></h3>
      {rows.length === 0 ? <p className={s.hint}>No warehouse upkeep or insurance bill reaches these months.</p> : (
        <FinanceGrid layoutKey="department-pnl-op-spreads" nameColumn={{ label: 'Date', width: 124 }} columns={SPREAD_COLUMNS} rows={rows} title="Warehouse upkeep and insurance" ariaLabel="Warehouse upkeep and insurance spread" />
      )}
    </>
  );
}

function SpreadInput({ r }: { r: DepartmentsOperation['spreads'][number] }) {
  const save = useSaveOperationSpread();
  const [value, setValue] = useState(String(r.months));
  useEffect(() => { setValue(String(r.months)); }, [r.months]);
  const n = Number(value);
  const ok = Number.isInteger(n) && n >= 1 && n <= 36;
  const dirty = value !== String(r.months);
  return (
    <span className={s.inline}>
      <input type="number" min={1} max={36} step={1} value={value} onChange={(e) => setValue(e.target.value)} aria-label={`Months for ${r.notes ?? r.lineId}`} className={s.input} style={{ width: 56 }} />
      {dirty && <button type="button" className={`${s.btn} ${s.btnSolid}`} disabled={!ok || save.isPending} onClick={() => save.mutate({ lineId: r.lineId, months: n })}>Save</button>}
      {!dirty && !r.isDefault && <button type="button" className={s.btn} disabled={save.isPending} onClick={() => save.mutate({ lineId: r.lineId, months: null })}>Default</button>}
      {!dirty && <span className={gridMuted}>to {r.lastMonth}</span>}
    </span>
  );
}

/** A rate Finance keeps: G&A's share of the Performance sales, Operation's income from the DOs' value. */
function RateBox({ dept, bp, what }: { dept: 'ga' | 'operation'; bp: number; what: ReactNode }) {
  const save = useSaveDepartmentRate();
  const [value, setValue] = useState(String(bp / 100));
  useEffect(() => { setValue(String(bp / 100)); }, [bp]);
  const n = Number(value);
  const dirty = value.trim() !== '' && Number.isFinite(n) && Math.round(n * 100) !== bp;
  const ok = Number.isFinite(n) && n >= 0 && n <= 100 && Math.round(n * 100) === n * 100;
  return (
    <span className={s.rate}>
      {what}
      <input type="number" min={0} max={100} step={0.01} value={value} onChange={(e) => setValue(e.target.value)} aria-label={dept === 'ga' ? 'G&A share percent' : 'Operation income percent'} className={s.input} style={{ width: 64 }} />
      %
      {dirty && <button type="button" className={`${s.btn} ${s.btnSolid}`} disabled={!ok || save.isPending} onClick={() => save.mutate({ dept, pct: n })}>{save.isPending ? 'Saving…' : 'Save'}</button>}
    </span>
  );
}
