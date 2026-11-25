// ----------------------------------------------------------------------------
// department-queries — the Department P&L (owner 2026-11-19: an Operation report =
// his "Operation PNL - Auto" sheet, a G&A report = admin, IT, legal and HQ; 2026-11-25:
// each department by its own method, All their own P&Ls side by side). Server:
// backend/src/scm/routes/acc-departments.ts; which department an amount belongs
// to: backend/src/scm/lib/department-rows.ts (the Chart of Accounts' Department
// column and the salary journal's team lines). Money in sen.
// ----------------------------------------------------------------------------

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { writeFailedAs } from './mutation-error';

/** A department a company can have, or — an expense account no department claims yet — none. */
export type Department = 'ga' | 'exhibition' | 'showroom' | 'operation' | 'logistics';
export type DeptKey = Department | 'none';

/** The view a department opens: G&A its share, Operation the sheet, Logistics the
    Logistics P&L, any other its own P&L. */
export type DeptViewKind = 'ga' | 'operation' | 'logistics' | 'dept';
/** A department's own P&L: sales and cost of sales as booked, or from the orders (the Exhibition). */
export type DeptBasis = 'books' | 'orders';
/** The company's departments and the view each opens. */
export type DepartmentPlan = {
  departments: Array<{ key: Department; label: string; view: DeptViewKind; basis: DeptBasis | null }>;
  selling: Department;
};

/** A node of the P&L's own tree, each figure split by department (All) or by month (G&A). */
export type DeptNode = {
  kind: 'category' | 'account' | 'unassigned' | 'subtotal';
  id: string; label: string; code?: string; key?: string;
  amountSen: number; pct: number | null;
  cells?: Record<string, number>;
  children: DeptNode[];
};

export type DeptBlock = 'tradingIncome' | 'costOfSales' | 'otherIncome' | 'expenses' | 'taxation';
/** A department's own P&L in a few figures: what it earns by its own method, what that
    income costs directly, its other income, its expenses and its result. */
export type DeptSummary = { incomeSen: number; costSen: number; grossSen: number; otherIncomeSen: number; expensesSen: number; profitSen: number };
/** Every department's own P&L side by side (owner 2026-11-25), and their total. */
export type DepartmentsAll = DepartmentPlan & {
  from: string; to: string;
  gaShareBp: number;
  summary: Partial<Record<Department, DeptSummary>>;
  /** The departments added up — not the company's profit (the P&L is). */
  total: DeptSummary;
  /** Expense accounts no department claims yet: in no department's figures. */
  unassigned: { label: string; lines: Array<{ code: string; name: string; amountSen: number }> };
  /** Set when the fairs could not be read for the Logistics P&L. */
  logisticsProblem: string | null;
};

export type GaTeam = 'DIRECTOR OFFICE' | 'FINANCE' | 'HR' | 'IT' | 'MANAGEMENT' | 'OTHER';
export type DepartmentsGa = {
  from: string; to: string; months: string[]; shareBp: number;
  perMonth: Array<{ month: string; salesSen: number; shareSen: number; expenseSen: number; surplusSen: number }>;
  tree: DeptNode[];
  teams: Array<{ team: GaTeam; label: string; lines: Array<{ lineId: string; day: string; accountCode: string; notes: string | null; amountSen: number }> }>;
};

export type OpRegion = 'PG' | 'KL' | 'EM';
export type OpCells = Record<OpRegion, number>;
export type OpRowKind = 'line' | 'strong' | 'final';

/** How an amount behind an Operation figure was arrived at, where it is not simply its line's. */
export type OpHow =
  | { kind: 'shared'; wholeSen: number }
  | { kind: 'spread'; wholeSen: number; part: number; months: number }
  | { kind: 'dos'; count: number }
  | { kind: 'rate'; baseSen: number; bp: number }
  | { kind: 'transport'; baseSen: number }
  | { kind: 'logistics'; netSen: number; fairIncomeSen: number }
  | { kind: 'fair'; incomeSen: number; costSen: number };
/** One amount behind an Operation figure — a ledger line, an Other Debtor bill line, a fair or
    a figure of the Logistics cost report — and what it put in which region of which month.
    Every row but the results is its lines added up (the server folds them so). */
export type OpLine = {
  id: string; row: string; month: string; cells: OpCells;
  src: 'ledger' | 'bill' | 'fair' | 'figure';
  day: string | null; ref: string | null; accountCode: string | null; accountName: string | null;
  text: string | null; party: string | null; how: OpHow | null;
};
export type DepartmentsOperation = {
  from: string; to: string; months: string[]; incomeBp: number; logisticsIncomeBp: number;
  regions: Array<{ code: OpRegion; name: string }>;
  /** The sheet's rows in order: how each is drawn, which block it adds into, and whether it shows only when not nil. */
  rows: Array<{ key: string; label: string; kind: OpRowKind; group: 'head' | 'gross' | 'expense' | 'expense_total' | 'result'; optional?: boolean }>;
  perMonth: Array<{ month: string; rows: Partial<Record<string, OpCells>>; dos: OpCells }>;
  /** What every row but the results is made of: what a figure opens. */
  lines: OpLine[];
  income: Array<{ lineId: string; billNo: string; billDate: string; debtorName: string; description: string | null; accountCode: string; accountName: string | null; amountSen: number; month: string; key: string; region: OpRegion }>;
  manpower: Array<{ lineId: string; day: string; accountCode: string; accountName: string | null; notes: string | null; amountSen: number; row: string; region: OpRegion | null; cells: OpCells }>;
  spreads: Array<{
    lineId: string; kind: 'upkeep' | 'insurance'; accountCode: string; accountName: string | null; day: string; docNo: string | null; notes: string | null;
    amountSen: number; region: OpRegion; months: number; isDefault: boolean; perMonthSen: number; inRangeSen: number; lastMonth: string;
  }>;
  /** Set when the fairs could not be read — the Setup/Dismantle line is then not known. */
  logisticsProblem: string | null;
};

/** One department's own P&L month by month (the Exhibition P&L on its orders, the Showroom P&L). */
export type DepartmentView = {
  from: string; to: string; dept: Department; label: string; months: string[];
  basis: DeptBasis;
  /** On orders: the orders counted and how many are not delivered yet. */
  orders: { counted: number; notDelivered: number } | null;
  perMonth: Array<{ month: string; salesSen: number; costOfSalesSen: number; grossSen: number; otherIncomeSen: number; expensesSen: number; taxationSen: number; netSen: number }>;
  tree: Record<DeptBlock, DeptNode[]>;
};

/** One line behind a figure of a department's P&L or G&A: a ledger line, the stock
    engine's opening / closing stock, or a commission bill (the Exhibition's commission,
    in the month the bill pays for). `sen` in the figure's sign. */
export type DeptEntry = {
  id: string; month: string; day: string | null; accountCode: string; accountName: string | null;
  ref: string | null; text: string | null; dept: DeptKey; team: GaTeam | null; sen: number;
  source: 'ledger' | 'stock_opening' | 'stock_closing' | 'rest' | 'bill';
};
export type DeptLines = { lines: DeptEntry[]; totalSen: number };
/** Which figure: the view, its column's months, the department and block, and the accounts
    (a code, or team:<TEAM> on G&A) under the row. */
export type DeptLinesAsk =
  | { view: 'dept'; d: Department; block: DeptBlock; from: string; to: string; keys: string[] }
  | { view: 'ga'; from: string; to: string; keys: string[] };

const KEY = ['acc-events', 'departments'] as const;

export const deptLinesQuery = (ask: DeptLinesAsk): string => {
  const q = new URLSearchParams({ view: ask.view, from: ask.from, to: ask.to });
  if (ask.view === 'dept') {
    q.set('block', ask.block);
    q.set('d', ask.d);
  }
  q.set('keys', ask.keys.join(','));
  return q.toString();
};
/** The lines behind one figure, read when it is opened. */
export function useDepartmentLines(ask: DeptLinesAsk) {
  const qs = deptLinesQuery(ask);
  return useQuery({
    queryKey: [...KEY, 'lines', qs],
    queryFn: () => authedFetch<DeptLines>(`/acc-events/departments/lines?${qs}`),
    staleTime: 30_000,
  });
}

export function useDepartmentPlan() {
  return useQuery({
    queryKey: [...KEY, 'plan'],
    queryFn: () => authedFetch<DepartmentPlan>('/acc-events/departments/plan'),
    staleTime: 60_000,
  });
}
export function useDepartmentView(dept: string, from: string, to: string, enabled: boolean) {
  return useQuery({
    queryKey: [...KEY, 'dept', dept, from, to],
    queryFn: () => authedFetch<DepartmentView>(`/acc-events/departments/dept?d=${encodeURIComponent(dept)}&from=${from}&to=${to}`),
    staleTime: 30_000, enabled,
  });
}

export function useDepartmentsAll(from: string, to: string, enabled: boolean) {
  return useQuery({
    queryKey: [...KEY, 'all', from, to],
    queryFn: () => authedFetch<DepartmentsAll>(`/acc-events/departments/all?from=${from}&to=${to}`),
    staleTime: 30_000, enabled,
  });
}
export function useDepartmentsGa(from: string, to: string, enabled: boolean) {
  return useQuery({
    queryKey: [...KEY, 'ga', from, to],
    queryFn: () => authedFetch<DepartmentsGa>(`/acc-events/departments/ga?from=${from}&to=${to}`),
    staleTime: 30_000, enabled,
  });
}
export function useDepartmentsOperation(from: string, to: string, enabled: boolean) {
  return useQuery({
    queryKey: [...KEY, 'operation', from, to],
    queryFn: () => authedFetch<DepartmentsOperation>(`/acc-events/departments/operation?from=${from}&to=${to}`),
    staleTime: 30_000, enabled,
  });
}

/** G&A's share of the Performance sales, or Operation's income from the DOs' value, in percent. */
export function useSaveDepartmentRate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { dept: 'ga' | 'operation'; pct: number }) => authedFetch<{ ok: true }>('/acc-events/departments/rate', { method: 'PUT', body: JSON.stringify(body) }),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: KEY }); },
    onError: writeFailedAs('Rate not saved'),
  });
}

/** How many months one warehouse upkeep / insurance bill is spread over (the Logistics
    report's own store, keyed by the ledger line); null = its default again. */
export function useSaveOperationSpread() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { lineId: string; months: number | null }) => authedFetch<{ ok: true }>('/acc-events/logistics/spread', { method: 'PUT', body: JSON.stringify(body) }),
    onSuccess: async () => {
      await Promise.all([qc.invalidateQueries({ queryKey: KEY }), qc.invalidateQueries({ queryKey: ['acc-events', 'logistics-pnl'] })]);
    },
    onError: writeFailedAs('Spread not saved'),
  });
}
