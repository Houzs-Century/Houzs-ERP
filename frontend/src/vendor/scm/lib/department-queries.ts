// ----------------------------------------------------------------------------
// department-queries — the Department P&L (owner 2026-11-19: an Operation report =
// his "Operation PNL - Auto" sheet, a G&A report = admin, IT, legal and HQ, and
// every account split across the departments). Server:
// backend/src/scm/routes/acc-departments.ts; which department an amount belongs
// to: backend/src/scm/lib/department-rows.ts (the Chart of Accounts' Department
// column and the salary journal's team lines). Money in sen.
// ----------------------------------------------------------------------------

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { writeFailedAs } from './mutation-error';

export type DeptKey = 'ga' | 'operation' | 'logistics' | 'none';

/** A node of the P&L's own tree, each figure split by department (All) or by month (G&A). */
export type DeptNode = {
  kind: 'category' | 'account' | 'unassigned' | 'subtotal';
  id: string; label: string; code?: string; key?: string;
  amountSen: number; pct: number | null;
  cells?: Record<string, number>;
  children: DeptNode[];
};

export type DeptBlock = 'tradingIncome' | 'costOfSales' | 'otherIncome' | 'expenses' | 'taxation';
export type DepartmentsAll = {
  from: string; to: string;
  columns: Array<{ key: DeptKey; label: string }>;
  tree: Record<DeptBlock, DeptNode[]>;
  blockTotals: Record<DeptBlock, Partial<Record<DeptKey, number>>>;
  totals: {
    tradingIncomeSen: number; costOfSalesSen: number; grossProfitSen: number; otherIncomeSen: number;
    expensesSen: number; profitBeforeTaxSen: number; taxationSen: number; netProfitSen: number;
  };
  baseSen: number | null;
  stock: { closingProvisional: boolean; asOf: string };
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
export type DepartmentsOperation = {
  from: string; to: string; months: string[]; incomeBp: number; logisticsIncomeBp: number;
  regions: Array<{ code: OpRegion; name: string }>;
  /** The sheet's rows in order: how each is drawn, which block it adds into, and whether it shows only when not nil. */
  rows: Array<{ key: string; label: string; kind: OpRowKind; group: 'head' | 'gross' | 'expense' | 'expense_total' | 'result'; optional?: boolean }>;
  perMonth: Array<{ month: string; rows: Partial<Record<string, OpCells>>; dos: OpCells }>;
  income: Array<{ lineId: string; billNo: string; billDate: string; debtorName: string; description: string | null; accountCode: string; accountName: string | null; amountSen: number; month: string; key: string; region: OpRegion }>;
  manpower: Array<{ lineId: string; day: string; accountCode: string; accountName: string | null; notes: string | null; amountSen: number; row: string; region: OpRegion | null; cells: OpCells }>;
  spreads: Array<{
    lineId: string; kind: 'upkeep' | 'insurance'; accountCode: string; accountName: string | null; day: string; docNo: string | null; notes: string | null;
    amountSen: number; region: OpRegion; months: number; isDefault: boolean; perMonthSen: number; inRangeSen: number; lastMonth: string;
  }>;
  /** Set when the fairs could not be read — the Setup/Dismantle line is then not known. */
  logisticsProblem: string | null;
};

const KEY = ['acc-events', 'departments'] as const;

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
