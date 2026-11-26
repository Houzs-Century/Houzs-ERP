// ----------------------------------------------------------------------------
// DepartmentPnl — the Department P&L tab (owner 2026-11-19: an Operation report =
// his "Operation PNL - Auto" sheet, a G&A report = admin, IT, legal and HQ, and
// 「我要可以看全部的，也要可以看单独部门的」; 2026-11-25: his three categories — each P&L
// Actual (the sales invoices), Performance (the sales orders) or Forecast — the
// P&L picker above choosing, here `dbasis`, Performance when absent). Each company
// has its own departments (its plan: Houzs — Exhibition, Operation, Logistics and
// its branch Setup & dismantle, G&A; 2990 — Showroom, G&A). The selling department
// pays the others a rate of its sales excluding service: G&A 5%, Operation 7% (3% of
// it on to Logistics), Setup & dismantle 1%. Report style (FinanceGrid):
//   • All departments — every department's own P&L in a few figures side by side,
//     and their total, in which what they pay each other comes out even; an expense
//     account no department claims yet is named above the table;
//   • the Exhibition (Showroom) P&L — its sales and cost of sales (Performance: the
//     orders' own by product group), its own expenses (Performance: commission at the
//     month's bills, merchandise in place of the terminal charges; the fair transport
//     is Setup & dismantle's), what it pays the other departments, its profit;
//   • G&A — its share of the sales against what it booked, the surplus;
//   • Operation, Logistics, Setup & dismantle — what each is paid less its real cost
//     (DepartmentPnlUnits.tsx); Operation also its sheet by DO and region.
// A figure opens the lines behind it under its line (owner 2026-11-20:「我希望这里
// 点开也能看」; DepartmentPnlLines.tsx), adding up to it; a charge opens its months at
// the rate. What only adds up the rows above opens nothing; on All a figure says
// where it comes from and opens its department's own P&L.
// Server: backend/src/scm/routes/acc-departments.ts. The view lives in the URL.
// ----------------------------------------------------------------------------

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { monthEnd, monthStart } from '../../lib/dateRangePresets';
import { fmtDateOrDash } from '../../vendor/shared/format';
import {
  useDepartmentPlan, useDepartmentUnit, useDepartmentView, useDepartmentsAll, useDepartmentsGa, useDepartmentsOperation, useSaveDepartmentRate, useSaveOperationSpread,
  type ChargeRates, type DepartmentPlan, type DepartmentUnit, type DepartmentView, type DepartmentsAll, type DepartmentsGa, type DepartmentsOperation,
  type DeptBasis, type DeptBlock, type DeptColumnKey, type DeptNode, type DeptSummary, type DeptViewKind, type OpLine, type OpRegion, type RateKey,
} from '../../vendor/scm/lib/department-queries';
import { DeptLinesPanel, DrillPanel } from './DepartmentPnlLines';
import { RatePanel, UnitReport, opDrillRow, opLedger, regionNameOf } from './DepartmentPnlUnits';
import { FinanceGrid, fmtMoney, gridMuted, type GridColumn, type GridRow } from './reports/FinanceGrid';
import { FinanceDateRange } from './reports/FinanceDateRange';
import {
  ReportExports, ReportHeaderActions, ReportMessage, ReportSwitch, ReportTiles, ReportTool, ReportToolbar, Segmented, useReportSubtitle,
  type ReportTile,
} from './reports/reportParts';
import { monthName } from './reports/statementColumns';
import { useReportRange } from './reports/useReportRange';
import { gridSheet, pctOf } from './logisticsColumns';
import { BASIS_WORDS, MODES, datesOf, monthColumns, pctText, rateText, scopeOf, short, spanText, whole, type Mode } from './departmentPnlParts';
import s from './Logistics.module.css';

type DeptChoice = { value: string; label: string; kind: 'all' | DeptViewKind };

/** All, then each department of the company; Logistics' branch, Setup & dismantle, after Logistics. */
export function departmentChoices(plan: DepartmentPlan | undefined): DeptChoice[] {
  const out: DeptChoice[] = [{ value: 'all', label: 'All departments', kind: 'all' }];
  for (const d of plan?.departments ?? []) {
    out.push({ value: d.key, label: d.label, kind: d.view });
    for (const b of plan?.branches ?? []) if (b.under === d.key) out.push({ value: b.key, label: b.label, kind: 'setupDismantle' });
  }
  return out;
}

/** The basis the address names (the P&L picker's): Actual, else Performance. */
export const basisOfParams = (params: URLSearchParams): DeptBasis => (params.get('dbasis') === 'actual' ? 'actual' : 'performance');

const OP_VIEWS: ReadonlyArray<{ value: 'pnl' | 'sheet'; label: string }> = [{ value: 'pnl', label: 'P&L' }, { value: 'sheet', label: 'Sheet by DO & region' }];
const RATE_LABEL: Record<RateKey, string> = { ga: 'G&A share percent', operation: 'Operation percent', merchandise: 'Merchandise percent' };

export const DepartmentPnlTab = () => {
  const [params, setParams] = useSearchParams();
  const plan = useDepartmentPlan();
  const views = useMemo(() => departmentChoices(plan.data), [plan.data]);
  /* A department the address names waits for the plan; anything else is All. */
  const wanted = params.get('dv');
  const current = views.find((v) => v.value === wanted) ?? (plan.data || !wanted ? views[0]! : null);
  const setParam = (k: string, v: string | null) => setParams((prev) => {
    const n = new URLSearchParams(prev);
    if (v == null) n.delete(k); else n.set(k, v);
    return n;
  }, { replace: true });
  const basis = basisOfParams(params);
  const r = useReportRange();
  const kind = current?.kind ?? null;
  const mode: Mode = params.get('dm') === 'months' ? 'months' : 'single';
  const split = params.get('dsplit') === '1';
  const showPct = params.get('dpct') !== '0';
  const sheetView = kind === 'operation' && params.get('dop') === 'sheet';

  /* Whole months: the range widens to its months' first and last days. */
  const from = r.usable ? monthStart(r.from) : monthStart(r.today);
  const to = r.usable ? monthEnd(r.to) : monthEnd(r.today);
  const period = from.slice(0, 7) === to.slice(0, 7) ? monthName(from) : `${monthName(from)} – ${monthName(to)}`;
  const partMonths = r.usable && (r.from !== from || r.to !== to);
  useReportSubtitle(`${period}${partMonths ? ' · whole months' : ''} · ${BASIS_WORDS[basis].name}${current ? ` · ${current.label}` : ''} · RM`);

  const unitKind = kind === 'operation' || kind === 'logistics' || kind === 'setupDismantle' ? kind : null;
  const all = useDepartmentsAll(basis, from, to, kind === 'all');
  const ga = useDepartmentsGa(basis, from, to, kind === 'ga');
  const dept = useDepartmentView(current?.value ?? '', basis, from, to, kind === 'dept');
  const unit = useDepartmentUnit(unitKind ?? 'operation', basis, from, to, unitKind != null && !sheetView);
  const op = useDepartmentsOperation(from, to, sheetView);
  const q = kind === 'all' ? all : kind === 'ga' ? ga : kind === 'dept' ? dept : sheetView ? op : unitKind ? unit : plan;
  const openDept = (key: DeptColumnKey) => setParam('dv', key);

  return (
    <>
      <ReportToolbar>
        <FinanceDateRange label="Months" />
        <ReportTool label="Department"><Segmented options={views} value={current?.value ?? 'all'} onChange={(v) => setParam('dv', v === 'all' ? null : v)} label="Department" /></ReportTool>
        {kind === 'operation' && <ReportTool label="View"><Segmented options={OP_VIEWS} value={sheetView ? 'sheet' : 'pnl'} onChange={(v) => setParam('dop', v === 'pnl' ? null : v)} label="Operation P&L or its sheet" /></ReportTool>}
        {kind != null && kind !== 'all' && <ReportTool label="Show"><Segmented options={MODES} value={mode} onChange={(v) => setParam('dm', v === 'single' ? null : v)} label="Whole range or by month" /></ReportTool>}
        {kind != null && kind !== 'all' && <ReportSwitch on={showPct} onChange={(v) => setParam('dpct', v ? null : '0')}>{sheetView ? '% of DO' : '% of sales'}</ReportSwitch>}
        {sheetView && mode === 'months' && <ReportSwitch on={split} onChange={(v) => setParam('dsplit', v ? '1' : null)}>Split each month by region</ReportSwitch>}
      </ReportToolbar>
      {!r.usable && <ReportMessage>Pick dates.</ReportMessage>}
      {plan.isError && <ReportMessage tone="error">The departments could not be read — {plan.error instanceof Error ? plan.error.message : String(plan.error)}</ReportMessage>}
      {q.isError && <ReportMessage tone="error">The report could not be read — {q.error instanceof Error ? q.error.message : String(q.error)}</ReportMessage>}
      {q.isLoading && <ReportTiles tiles={['Income', 'Expenses', 'Result'].map((label) => ({ key: label, label, value: '' }))} label="Department totals" pending />}
      {kind === 'all' && all.data && <AllView p={all.data} period={period} onOpen={openDept} />}
      {kind === 'ga' && ga.data && <GaView p={ga.data} mode={mode} showPct={showPct} period={period} />}
      {kind === 'dept' && dept.data && <DeptView p={dept.data} mode={mode} showPct={showPct} period={period} />}
      {unitKind && !sheetView && unit.data && <UnitReport p={unit.data} basis={basis} mode={mode} showPct={showPct} period={period} tools={<UnitRates p={unit.data} />} />}
      {sheetView && op.data && <OperationView p={op.data} mode={mode} split={split} showPct={showPct} period={period} />}
    </>
  );
};

/** The rates a unit's view shows: Operation's own Finance keeps here; Logistics' and Setup & dismantle's are the Logistics cost report's. */
function UnitRates({ p }: { p: DepartmentUnit }) {
  const r = p.rates;
  return (
    <div className={s.rates}>
      {p.unit === 'operation' && <RateBox dept="operation" bp={r.operationBp} what="Operation = sales excluding service ×" />}
      <span className={s.rate}>
        {p.unit === 'setupDismantle'
          ? `Setup & dismantle is paid ${rateText(r.setupDismantleBp)}% of the sales excluding service — the Logistics cost report's fair rate, set there.`
          : `Operation passes ${rateText(r.logisticsBp)}% of the sales excluding service on to Logistics — the Logistics cost report's rate, set there.`}
      </span>
    </div>
  );
}

/* ── A node of the P&L's tree as a grid row ───────────────────────────────── */
type DetailOf = (keys: string[], title: string) => GridRow['detail'];
function nodeRows(nodes: readonly DeptNode[], cellsOf: (n: DeptNode) => Record<string, number>, detailOf: DetailOf | null): GridRow[] {
  return nodes.map((n) => (n.children.length > 0
    ? { id: n.id, label: n.label, kids: nodeRows(n.children, cellsOf, detailOf), totalLabel: `Total ${n.label}`, cells: cellsOf(n), detail: detailOf?.(leafKeys(n), n.label) }
    : { id: n.id, label: n.label, cells: cellsOf(n), detail: detailOf?.(leafKeys(n), n.label) }));
}
/** The accounts under a node — an account's code; on G&A a team's team:<TEAM>. */
const leafKeys = (n: DeptNode): string[] => (n.kind === 'account' ? [n.key ?? n.code ?? n.id] : n.children.flatMap(leafKeys));
const withPct = (rows: GridRow[], base: Record<string, number>): GridRow[] =>
  rows.map((r) => ({ ...r, pct: pctOf(r.cells, base), ...(r.kids ? { kids: withPct(r.kids, base) } : {}) }));

/* ── All departments: every department's own P&L, side by side ─────────────── */
type AllColumn = { key: DeptColumnKey; label: string; view: DeptViewKind };
/** All's columns: the departments in the company's order, Logistics' branch after Logistics. */
const allColumns = (p: DepartmentsAll): AllColumn[] =>
  departmentChoices(p).filter((c): c is DeptChoice & { kind: DeptViewKind } => c.kind !== 'all').map((c) => ({ key: c.value as DeptColumnKey, label: c.label, view: c.kind }));
const SUMMARY_ROWS: ReadonlyArray<{ key: keyof DeptSummary; label: string; kind?: GridRow['kind']; optional?: boolean }> = [
  { key: 'incomeSen', label: 'Income' },
  { key: 'costSen', label: 'Cost of sales' },
  { key: 'grossSen', label: 'GROSS PROFIT', kind: 'strong' },
  { key: 'otherIncomeSen', label: 'Other income', optional: true },
  { key: 'expensesSen', label: 'Expenses' },
  { key: 'chargesSen', label: 'Paid to other departments', optional: true },
  { key: 'profitSen', label: 'PROFIT / (LOSS)', kind: 'final' },
];

/** Where a column's figures come from, under its name. */
function subOf(c: AllColumn, p: DepartmentsAll): string {
  const r = p.rates;
  if (c.view === 'ga') return `${rateText(r.gaBp)}% of sales`;
  if (c.view === 'operation') return `${rateText(r.operationBp)}% of sales, ${rateText(r.logisticsBp)}% on to Logistics`;
  if (c.view === 'logistics') return `${rateText(r.logisticsBp)}% from Operation`;
  if (c.view === 'setupDismantle') return `${rateText(r.setupDismantleBp)}% of sales`;
  return c.key === p.selling ? BASIS_WORDS[p.basis].sales : 'as booked';
}

/** What the selling department pays, in words. */
const paysText = (r: ChargeRates, sd: boolean, ga: boolean, op: boolean): string => [
  ga ? `G&A ${rateText(r.gaBp)}%` : null, op ? `Operation ${rateText(r.operationBp)}%` : null, sd ? `Setup & dismantle ${rateText(r.setupDismantleBp)}%` : null,
].filter(Boolean).join(', ');

/** How one figure of All is arrived at, in a sentence. */
function howText(c: AllColumn, row: keyof DeptSummary, p: DepartmentsAll): string {
  const r = p.rates;
  const sales = BASIS_WORDS[p.basis].sales;
  const has = (v: DeptViewKind) => allColumns(p).some((x) => x.view === v);
  if (row === 'grossSen') return 'Income less cost of sales.';
  if (row === 'profitSen') return c.view === 'ga' ? "G&A's surplus or deficit: its share less what it booked." : 'Gross profit and other income, less expenses and what it pays the other departments.';
  if (c.view === 'ga') {
    return row === 'incomeSen' ? `G&A's share: ${rateText(r.gaBp)}% of the selling department's sales excluding service (${sales}).`
      : "What G&A booked: the HQ teams' pay and the accounts the Chart of Accounts gives G&A.";
  }
  if (c.view === 'operation') {
    return row === 'incomeSen' ? `${rateText(r.operationBp)}% of the sales excluding service (${sales}), and the WAREHOUSE / OPERATION CHARGES billed.`
      : row === 'chargesSen' ? `The ${rateText(r.logisticsBp)}% of the sales it passes on to Logistics.`
        : 'The warehouse rows of the Operation sheet, every region added up (upkeep and insurance spread over their months).';
  }
  if (c.view === 'logistics') {
    return row === 'incomeSen' ? `${rateText(r.logisticsBp)}% of the sales from Operation, the transport charges billed${has('setupDismantle') ? ' and the in-house setup and dismantle trips' : ''}.`
      : "The Logistics cost report's delivery cost: 3PL, our lorries, the drivers' and helpers' pay.";
  }
  if (c.view === 'setupDismantle') {
    return row === 'incomeSen' ? `${rateText(r.setupDismantleBp)}% of the selling department's sales excluding service.` : 'The fair transport accounts as booked, and the in-house trips paid to Logistics.';
  }
  const perf = p.basis === 'performance';
  if (row === 'incomeSen') return perf ? "The sales orders dated in these months (not draft or cancelled), delivered or not: the Performance P&L's own sales." : 'Sales as booked: the sales invoices.';
  if (row === 'costSen') return perf ? "Each order line's own cost: the Performance P&L's own cost of sales." : 'Cost of sales as booked.';
  if (row === 'chargesSen') return `${paysText(r, has('setupDismantle'), has('ga'), has('operation'))} of its sales excluding service.`;
  if (row === 'expensesSen') {
    return `What the ${c.label} department booked, by journal date${perf ? ", its commission at the month's commission bills and merchandise at its rate in place of the terminal charges" : ''}${has('setupDismantle') ? '; the fair transport is Setup & dismantle’s' : ''}.`;
  }
  return `Other income booked for the ${c.label} department.`;
}

/** What a figure of All opens: where it comes from, and its department's own P&L. */
function AllFigure({ c, row, how, onOpen, onClose }: { c: AllColumn; row: string; how: string; onOpen: (key: DeptColumnKey) => void; onClose: () => void }) {
  return (
    <div role="region" aria-label={`${c.label} · ${row}`} className={s.rates}>
      <span className={s.rate}>{how}</span>
      <button type="button" className={`${s.btn} ${s.btnSolid}`} onClick={() => onOpen(c.key)}>Open the {c.label} P&amp;L</button>
      <button type="button" className={s.btn} onClick={onClose} aria-label="Close">Close</button>
    </div>
  );
}

function AllView({ p, period, onOpen }: { p: DepartmentsAll; period: string; onOpen: (key: DeptColumnKey) => void }) {
  const cols = useMemo(() => allColumns(p), [p]);
  const columns = useMemo<GridColumn[]>(() => [
    ...cols.map((c) => ({ key: c.key, label: c.label, sub: subOf(c, p), kind: 'money' as const, width: 190 })),
    { key: 'T', label: 'Total', sub: 'departments added up', kind: 'money', width: 170, total: true, edge: true },
  ], [cols, p]);
  const rows = useMemo<GridRow[]>(() => SUMMARY_ROWS
    .filter((r) => !r.optional || cols.some((c) => (p.summary[c.key]?.[r.key] ?? 0) !== 0))
    .map((r): GridRow => ({
      id: r.key, label: r.label, kind: r.kind,
      cells: { ...Object.fromEntries(cols.map((c) => [c.key, p.summary[c.key]?.[r.key] ?? 0])), T: p.total[r.key] },
      detail: (colKey, close) => {
        const c = cols.find((x) => x.key === colKey);
        if (!c || (p.summary[c.key]?.[r.key] ?? 0) === 0) return null;
        return <AllFigure c={c} row={r.label} how={howText(c, r.key, p)} onOpen={onOpen} onClose={close} />;
      },
    })), [p, cols, onOpen]);
  const tiles: ReportTile[] = [
    ...cols.map((c): ReportTile => {
      const sen = p.summary[c.key]?.profitSen ?? 0;
      return { key: c.key, label: `${c.label} profit`, value: whole(sen), tone: sen < 0 ? 'late' : 'good', sub: subOf(c, p) };
    }),
    { key: 'total', label: 'Departments added up', value: whole(p.total.profitSen), tone: p.total.profitSen < 0 ? 'late' : 'good', sub: 'what they pay each other comes out even' },
  ];
  const words = BASIS_WORDS[p.basis];
  const title = `Department P&L · all departments · ${words.name}`;
  const selling = cols.find((c) => c.key === p.selling)?.label ?? 'selling';
  const sheet = () => gridSheet({ title, subtitle: `${period} · RM`, period, nameLabel: 'Line', columns, rows, showPct: false });
  return (
    <>
      <ReportHeaderActions><ReportExports sheet={sheet} fileBase={`department-pnl-all-${p.basis}-${p.from.slice(0, 7)}-${p.to.slice(0, 7)}`} /></ReportHeaderActions>
      <ReportTiles tiles={tiles} label="Department totals" />
      {p.unassigned.lines.length > 0 && (
        <ReportMessage tone="error">
          {p.unassigned.label}: {p.unassigned.lines.map((l) => `${l.code} · ${l.name} (${fmtMoney(l.amountSen)})`).join('; ')} — give each a Department (or a Logistics row) on the Chart of Accounts; until then it counts in no department.
        </ReportMessage>
      )}
      {p.logisticsProblem && <ReportMessage>The fairs could not be read — {p.logisticsProblem}. The in-house setup and dismantle trips count none.</ReportMessage>}
      <FinanceGrid layoutKey="department-pnl-all|own" nameColumn={{ label: 'Line', width: 220 }} columns={columns} rows={rows}
        title={title} subtitle={`${period} · RM`} ariaLabel="Department P&L, all departments" drillKey={`${p.basis}|${p.from}|${p.to}`}
        foot={<span>
          {words.name}: the {selling} department on its {words.sales}, paying the others a rate of its sales excluding service
          {' '}({paysText(p.rates, cols.some((c) => c.view === 'setupDismantle'), cols.some((c) => c.view === 'ga'), cols.some((c) => c.view === 'operation'))}); Operation
          passes {rateText(p.rates.logisticsBp)}% on to Logistics. Each department is what it is paid less its real cost. Total adds the departments up:
          what they pay each other comes out even. Click a figure for where it comes from; pick a department above for its own P&amp;L and the lines
          behind each figure.
        </span>} />
    </>
  );
}

/* ── G&A ──────────────────────────────────────────────────────────────────── */
function GaView({ p, mode, showPct, period }: { p: DepartmentsGa; mode: Mode; showPct: boolean; period: string }) {
  const columns = useMemo(() => monthColumns(p.months, mode, showPct), [p.months, mode, showPct]);
  const words = BASIS_WORDS[p.basis];
  const rows = useMemo<GridRow[]>(() => {
    const scope = scopeOf(p.months);
    const keys = columns.map((c) => c.key);
    const by = (f: (m: DepartmentsGa['perMonth'][number]) => number): Record<string, number> =>
      Object.fromEntries(keys.map((k) => [k, p.perMonth.filter((m) => scope(k).includes(m.month)).reduce((x, m) => x + f(m), 0)]));
    const cellsOf = (n: DeptNode): Record<string, number> => Object.fromEntries(keys.map((k) => [k, scope(k).reduce((x, m) => x + (n.cells?.[m] ?? 0), 0)]));
    const detailOf: DetailOf = (accounts, title) => (colKey, close) => (
      <DeptLinesPanel title={title} sub={colKey === 'T' ? `Total · ${spanText(p.months)}` : short(colKey)} onClose={close}
        ask={{ view: 'ga', basis: p.basis, ...datesOf(scope(colKey)), keys: accounts }} />
    );
    const sales = by((m) => m.salesSen);
    const share = by((m) => m.shareSen);
    const expense = by((m) => m.expenseSen);
    const surplus = by((m) => m.surplusSen);
    return [
      { id: 'sales', label: `Sales excluding service (${words.sales})`, kind: 'strong', cells: sales, pct: pctOf(sales, sales) },
      { id: 'share', label: `G&A share (${rateText(p.shareBp)}% of sales excluding service)`, cells: share, pct: pctOf(share, sales) },
      {
        id: 'expenses', label: 'G&A EXPENSES', totalLabel: 'Total G&A expenses', kind: 'block', kids: withPct(nodeRows(p.tree, cellsOf, detailOf), sales),
        cells: expense, pct: pctOf(expense, sales), detail: detailOf(p.tree.flatMap(leafKeys), 'Total G&A expenses'),
      },
      { id: 'surplus', label: 'SURPLUS / (DEFICIT)', kind: 'final', cells: surplus, pct: pctOf(surplus, sales) },
    ];
  }, [p, columns, words]);
  const tot = (f: (m: DepartmentsGa['perMonth'][number]) => number) => p.perMonth.reduce((x, m) => x + f(m), 0);
  const sales = tot((m) => m.salesSen); const share = tot((m) => m.shareSen); const expense = tot((m) => m.expenseSen); const surplus = tot((m) => m.surplusSen);
  const tiles: ReportTile[] = [
    { key: 'sales', label: 'Sales excluding service', value: whole(sales), sub: words.sales },
    { key: 'share', label: 'G&A share', value: whole(share), sub: `${rateText(p.shareBp)}% of sales excluding service` },
    { key: 'expense', label: 'G&A expenses', value: whole(expense), sub: `${pctText(expense, sales)} of sales` },
    { key: 'surplus', label: 'Surplus / (deficit)', value: whole(surplus), tone: surplus < 0 ? 'late' : 'good', sub: surplus < 0 ? '▼ G&A spent more than its share' : '▲ G&A spent within its share' },
  ];
  const title = `Department P&L · G&A · ${words.name}`;
  const sheet = () => gridSheet({ title, subtitle: `${period} · RM`, period, nameLabel: 'Account', columns, rows, showPct });
  return (
    <>
      <ReportHeaderActions><ReportExports sheet={sheet} fileBase={`department-pnl-ga-${p.basis}-${p.from.slice(0, 7)}-${p.to.slice(0, 7)}`} /></ReportHeaderActions>
      <ReportTiles tiles={tiles} label="G&A totals" />
      <div className={s.rates}><RateBox dept="ga" bp={p.shareBp} what="G&A share = sales excluding service ×" /></div>
      <FinanceGrid layoutKey={`department-pnl-ga|${mode}|${showPct ? 1 : 0}`} nameColumn={{ label: 'Account', width: 380 }} columns={columns} rows={rows} showPct={showPct}
        title={title} subtitle={`${period} · RM`} ariaLabel="Department P&L, G&A" drillKey={`${p.basis}|${p.from}|${p.to}|${mode}`}
        foot={<span>
          G&amp;A = admin, IT, legal and HQ: the payroll lines of the Director office, Finance, HR, IT, Management and Other teams (the salary
          journal&rsquo;s own words), and every account the Chart of Accounts&rsquo; Department column gives G&amp;A — by journal date. Its share is a rate
          of the selling department&rsquo;s sales excluding service ({words.sales}), and every % is of the column&rsquo;s. Click an expense for the lines behind it.
        </span>} />
      <TeamsList p={p} />
    </>
  );
}

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

/* ── One department's own P&L (the Exhibition, the Showroom) ──────────────── */
/** The rate each charge row is at. */
const chargeRateOf = (r: ChargeRates, id: string): number => (id === 'charge:ga' ? r.gaBp : id === 'charge:operation' ? r.operationBp : r.setupDismantleBp);

function DeptView({ p, mode, showPct, period }: { p: DepartmentView; mode: Mode; showPct: boolean; period: string }) {
  /* Performance: sales and cost of sales are the orders' own; they open no ledger line. */
  const fromOrders = p.orders != null;
  const words = BASIS_WORDS[p.basis];
  const columns = useMemo(() => monthColumns(p.months, mode, showPct), [p.months, mode, showPct]);
  const rows = useMemo<GridRow[]>(() => {
    const scope = scopeOf(p.months);
    const keys = columns.map((c) => c.key);
    const by = (f: (m: DepartmentView['perMonth'][number]) => number): Record<string, number> =>
      Object.fromEntries(keys.map((k) => [k, p.perMonth.filter((m) => scope(k).includes(m.month)).reduce((x, m) => x + f(m), 0)]));
    const cellsOf = (n: DeptNode): Record<string, number> => Object.fromEntries(keys.map((k) => [k, scope(k).reduce((x, m) => x + (n.cells?.[m] ?? 0), 0)]));
    const sales = by((m) => m.salesSen);
    const sub = (colKey: string) => (colKey === 'T' ? `Total · ${spanText(p.months)}` : short(colKey));
    const detailIn = (b: DeptBlock): DetailOf => (accounts, title) => (colKey, close) => (
      <DeptLinesPanel title={title} sub={sub(colKey)} onClose={close}
        ask={{ view: 'dept', basis: p.basis, d: p.dept, block: b, ...datesOf(scope(colKey)), keys: accounts }} />
    );
    const opens = (b: DeptBlock) => !(fromOrders && (b === 'tradingIncome' || b === 'costOfSales'));
    const group = (b: DeptBlock, label: string, totalLabel: string, cells: Record<string, number>): GridRow => ({
      id: b, label, totalLabel, kind: 'block', kids: withPct(nodeRows(p.tree[b], cellsOf, opens(b) ? detailIn(b) : null), sales), cells, pct: pctOf(cells, sales),
      ...(opens(b) ? { detail: detailIn(b)(p.tree[b].flatMap(leafKeys), totalLabel) } : {}),
    });
    const base = Object.fromEntries(p.perMonth.map((m) => [m.month, m.baseSen ?? 0]));
    const charges = by((m) => m.chargesSen);
    const gross = by((m) => m.grossSen);
    const net = by((m) => m.netSen);
    const out: GridRow[] = [
      group('tradingIncome', fromOrders ? 'SALES (SALES ORDERS BY SO DATE)' : 'SALES', 'Total sales', sales),
      group('costOfSales', fromOrders ? "COST OF SALES (THE ORDERS' OWN)" : 'COST OF SALES', 'Total cost of sales', by((m) => m.costOfSalesSen)),
      { id: 'gross', label: 'GROSS PROFIT', kind: 'strong', cells: gross, pct: pctOf(gross, sales) },
      group('otherIncome', 'OTHER INCOME', 'Total other income', by((m) => m.otherIncomeSen)),
      group('expenses', `${p.label.toUpperCase()} EXPENSES`, `Total ${p.label} expenses`, by((m) => m.expensesSen)),
      group('taxation', 'TAXATION', 'Total taxation', by((m) => m.taxationSen)),
      {
        id: 'charges', label: 'PAID TO OTHER DEPARTMENTS', totalLabel: 'Total paid to other departments', kind: 'block', cells: charges, pct: pctOf(charges, sales),
        kids: p.charges.map((n): GridRow => {
          const cells = cellsOf(n);
          return {
            id: n.id, label: n.label, cells, pct: pctOf(cells, sales),
            detail: (colKey, close) => <RatePanel title={n.label} sub={sub(colKey)} bp={chargeRateOf(p.rates, n.id)} months={scope(colKey)} base={base} cells={n.cells ?? {}} onClose={close} />,
          };
        }),
      },
      { id: 'net', label: `${p.label.toUpperCase()} PROFIT / (LOSS)`, kind: 'final', cells: net, pct: pctOf(net, sales) },
    ];
    return out.filter((x) => !x.kids || x.kids.length > 0);
  }, [p, columns, fromOrders]);
  const tot = (f: (m: DepartmentView['perMonth'][number]) => number) => p.perMonth.reduce((x, m) => x + f(m), 0);
  const sales = tot((m) => m.salesSen); const gross = tot((m) => m.grossSen); const charges = tot((m) => m.chargesSen); const net = tot((m) => m.netSen);
  const counted = p.orders?.counted ?? 0;
  const tiles: ReportTile[] = [
    { key: 'sales', label: 'Sales', value: whole(sales), sub: fromOrders ? `${counted.toLocaleString('en-US')} order${counted === 1 ? '' : 's'} by SO date` : words.sales },
    { key: 'gross', label: 'Gross profit', value: whole(gross), sub: `${pctText(gross, sales)} of sales` },
    { key: 'charges', label: 'Paid to other departments', value: whole(charges), sub: `${pctText(charges, sales)} of sales` },
    { key: 'net', label: `${p.label} profit`, value: whole(net), tone: net < 0 ? 'late' : 'good', sub: `${pctText(net, sales)} of sales` },
  ];
  const title = `Department P&L · ${p.label} · ${words.name}`;
  const sheet = () => gridSheet({ title, subtitle: `${period} · RM`, period, nameLabel: 'Account', columns, rows, showPct });
  const pays = p.charges.length > 0;
  return (
    <>
      <ReportHeaderActions><ReportExports sheet={sheet} fileBase={`department-pnl-${p.dept}-${p.basis}-${p.from.slice(0, 7)}-${p.to.slice(0, 7)}`} /></ReportHeaderActions>
      <ReportTiles tiles={tiles} label={`${p.label} totals`} />
      {(pays || (p.basis === 'performance' && p.merchandiseAccounts.length > 0)) && (
        <div className={s.rates}>
          {pays && <span className={s.rate}>Pays the other departments a rate of its sales excluding service — set under G&amp;A, Operation and the Logistics cost report.</span>}
          {p.basis === 'performance' && p.merchandiseAccounts.length > 0 && (
            <RateBox dept="merchandise" bp={p.rates.merchandiseBp} what={`Merchandise (in place of ${p.merchandiseAccounts.join(', ')}) = sales excluding service ×`} />
          )}
        </div>
      )}
      <FinanceGrid layoutKey={`department-pnl-dept|${mode}|${showPct ? 1 : 0}`} nameColumn={{ label: 'Account', width: 380 }} columns={columns} rows={rows} showPct={showPct}
        title={title} subtitle={`${period} · RM`} ariaLabel={`Department P&L, ${p.label}`} drillKey={`${p.dept}|${p.basis}|${p.from}|${p.to}|${mode}`}
        foot={fromOrders ? <span>
          Sales and cost of sales are the Performance P&amp;L&rsquo;s own: the sales orders dated in each month (not draft or cancelled), delivered or
          not, each line&rsquo;s own cost{p.orders ? ` — ${p.orders.counted.toLocaleString('en-US')} orders, ${p.orders.notDelivered.toLocaleString('en-US')} not yet delivered` : ''}.
          Expenses: what the {p.label} department booked, by journal date, its commission at the month&rsquo;s commission bills and merchandise at its rate
          in place of the terminal charges. Paid to other departments: each a rate of the sales excluding service. Every % is of the column&rsquo;s sales.
          Click a figure for the lines behind it.
        </span> : <span>
          The books by journal date, month by month: sales and cost of sales as booked, less what the {p.label} department booked{pays ? ' and what it pays the other departments, each a rate of its sales excluding service' : ''}.
          Every % is of the column&rsquo;s sales. Click a figure for the lines behind it.
        </span>} />
    </>
  );
}

/* ── Operation's sheet, by DO and region (the owner's "Operation PNL - Auto") ────────────────────────────────────────────────────────── */
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
  const span = spanText(all);
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
  const linesOf = useMemo(() => {
    const out = new Map<string, OpLine[]>();
    for (const l of p.lines) out.set(l.row, [...(out.get(l.row) ?? []), l]);
    return out;
  }, [p.lines]);
  const rows = useMemo<GridRow[]>(() => {
    const label = (k: string) => p.rows.find((x) => x.key === k)?.label ?? k;
    /* A figure opens the lines its row adds up in its column's months and regions; the
       results (Gross, Net) add up rows and have none. */
    const detailOf = (rowKeys: readonly string[], title: string): GridRow['detail'] => (colKey, close) => {
      const sc = scopes.get(colKey);
      if (!sc) return null;
      const picked = rowKeys.flatMap((k) => linesOf.get(k) ?? []).filter((l) => sc.months.includes(l.month))
        .map((l) => ({ l, sen: sc.regions.reduce((x, r) => x + l.cells[r], 0) })).filter((x) => x.sen !== 0);
      if (picked.length === 0) return null;
      return (
        <DrillPanel title={title} sub={scopeText(p, sc)} onClose={close} ledger={opLedger(picked.map((x) => x.l), sc.months)}
          rows={picked.map(({ l, sen }) => opDrillRow(p, l, sen, sc.regions, rowKeys.length > 1 ? label(l.row) : null))} />
      );
    };
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
    const line = (k: string, kind?: GridRow['kind']): GridRow => {
      const cells = money(k);
      return { id: k, label: label(k), kind, cells, pct: pctOf(cells, doValue), detail: detailOf([k], label(k)) };
    };
    const has = (k: string) => p.perMonth.some((m) => codes.some((r) => (m.rows[k]?.[r] ?? 0) !== 0));
    const shown = p.rows.filter((x) => !x.optional || has(x.key));
    const out: GridRow[] = [];
    const total = p.rows.find((x) => x.group === 'expense_total');
    for (const x of shown) {
      if (x.group === 'expense_total') continue;
      if (x.group === 'expense') {
        if (out.some((r) => r.id === 'warehouse')) continue;
        const cells = money(total?.key ?? 'total_expense');
        const expense = shown.filter((k) => k.group === 'expense');
        out.push({
          id: 'warehouse', label: 'Expense:- Warehouse', totalLabel: total?.label ?? 'Total', kind: 'block',
          kids: expense.map((k) => line(k.key)), cells, pct: pctOf(cells, doValue), detail: detailOf(expense.map((k) => k.key), total?.label ?? 'Total'),
        });
        continue;
      }
      out.push(line(x.key, x.kind === 'line' ? undefined : x.kind));
    }
    return out;
  }, [p, scopes, byMonth, codes, linesOf]);
  const total = (k: string) => p.perMonth.reduce((x, m) => x + codes.reduce((y, r) => y + (m.rows[k]?.[r] ?? 0), 0), 0);
  const doValue = total('do_value');
  const tiles: ReportTile[] = [
    { key: 'do', label: 'Delivery Order', value: whole(doValue), sub: `${p.perMonth.reduce((x, m) => x + codes.reduce((y, r) => y + m.dos[r], 0), 0).toLocaleString('en-US')} DOs` },
    { key: 'gross', label: 'Gross profit', value: whole(total('gross')), sub: `${pctText(total('gross'), doValue)} of DO value` },
    { key: 'exp', label: 'Warehouse expenses', value: whole(total('total_expense')), sub: `${pctText(total('total_expense'), doValue)} of DO value` },
    { key: 'net', label: 'Net after logistics & setup/dismantle', value: whole(total('net_after')), tone: total('net_after') < 0 ? 'late' : 'good', sub: `${pctText(total('net_after'), doValue)} of DO value` },
  ];
  const sheet = () => gridSheet({ title: 'Operation sheet · by DO and region', subtitle: `${period} · RM`, period, nameLabel: 'Category', columns, rows, showPct });
  return (
    <>
      <ReportHeaderActions><ReportExports sheet={sheet} fileBase={`department-pnl-operation-${p.from.slice(0, 7)}-${p.to.slice(0, 7)}`} /></ReportHeaderActions>
      <ReportTiles tiles={tiles} label="Operation totals" />
      <div className={s.rates}>
        <RateBox dept="operation" bp={p.incomeBp} what="Operation income = DO value ×" />
        <span className={s.rate}>(-) Logistic Expense = the Logistics cost report&rsquo;s Transport Income ({rateText(p.logisticsIncomeBp)}% of DO), set under Logistics.</span>
      </div>
      {p.logisticsProblem && <ReportMessage>The fairs could not be read — {p.logisticsProblem}. Profit / (Loss) From Setup/Dismantle counts no fair.</ReportMessage>}
      <FinanceGrid layoutKey={`department-pnl-operation|${mode}|${split ? 1 : 0}|${showPct ? 1 : 0}`} nameColumn={{ label: 'Category', width: 400 }} columns={columns} rows={rows} showPct={showPct}
        title="Operation sheet · by DO and region" subtitle={`${period} · RM`} ariaLabel="Operation sheet, by DO and region" drillKey={`${p.from}|${p.to}|${mode}|${split}`}
        foot={<span>
          Every % is of the Delivery Order value in its column; KL carries Singapore. Warehouse rows: the Chart of Accounts&rsquo; Department column (each
          account&rsquo;s row and region). Manpower: the salary journal&rsquo;s LOGISTIC (ADMIN), WAREHOUSE OPERATIONS, PROCUREMENT and OPERATION
          STOREKEEPER lines — a line naming its region (PG / KL / SBH) is that region&rsquo;s, else shared by the month&rsquo;s DO value. Income: the
          WAREHOUSE CHARGES and OPERATION CHARGES lines on Other Debtor bills, in the month they name. From Logistics = the Logistics cost
          report&rsquo;s net less its fair income; From Setup/Dismantle = each fair&rsquo;s transport income less its setup and dismantle transport.
          Click a figure for the lines behind it; Gross Profit and the Net rows add up the rows above.
        </span>} />
      <ManpowerList p={p} />
      <OpIncomeList p={p} />
      <OpSpreadsList p={p} />
    </>
  );
}

/** A column of the sheet in words: its months, and its regions when not all of them. */
const scopeText = (p: DepartmentsOperation, sc: Scope): string =>
  `${spanText(sc.months)}${sc.regions.length < p.regions.length ? ` · ${sc.regions.map((r) => regionNameOf(p, r)).join(', ')}` : ''}`;

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

/** A rate Finance keeps: G&A's share, Operation's (of the sales, and on its sheet of the DOs' value),
    merchandise's — each kept once, whichever view saves it. */
function RateBox({ dept, bp, what }: { dept: RateKey; bp: number; what: ReactNode }) {
  const save = useSaveDepartmentRate();
  const [value, setValue] = useState(String(bp / 100));
  useEffect(() => { setValue(String(bp / 100)); }, [bp]);
  const n = Number(value);
  const dirty = value.trim() !== '' && Number.isFinite(n) && Math.round(n * 100) !== bp;
  const ok = Number.isFinite(n) && n >= 0 && n <= 100 && Math.round(n * 100) === n * 100;
  return (
    <span className={s.rate}>
      {what}
      <input type="number" min={0} max={100} step={0.01} value={value} onChange={(e) => setValue(e.target.value)} aria-label={RATE_LABEL[dept]} className={s.input} style={{ width: 64 }} />
      %
      {dirty && <button type="button" className={`${s.btn} ${s.btnSolid}`} disabled={!ok || save.isPending} onClick={() => save.mutate({ dept, pct: n })}>{save.isPending ? 'Saving…' : 'Save'}</button>}
    </span>
  );
}
