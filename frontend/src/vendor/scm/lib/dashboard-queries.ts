/* The Financial Dashboard (owner 2026-09-21): one read of the periods the
   cards draw — the statements' actuals beside the forecast, per month or
   quarter. The server half is backend/src/scm/routes/accounting-dashboard.ts;
   every actual figure there is the report's own builder, so a card can never
   disagree with its report. */
import { useQuery } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { retryUnlessClientError } from '../../../lib/retryPolicy';
import type { LaidNode } from './report-layout';

export type Granularity = 'month' | 'quarter';

/** The P&L's totals as the Income Statement card reads them; staff cost = the layout's Salary & related group. */
export type DashboardFigures = {
  salesSen: number; costOfSalesSen: number; grossProfitSen: number; otherIncomeSen: number;
  expensesSen: number; staffCostSen: number; otherExpensesSen: number;
  profitBeforeTaxSen: number; taxationSen: number; netProfitSen: number;
};
export type DashboardPerformance = {
  groups: Array<{ key: string; label: string; salesSen: number; cogsSen: number; gpSen: number; gpPct: number | null }>;
  salesSen: number; cogsSen: number; gpSen: number; totalGpPct: number | null;
};
export type CostStructureGroup = { key: string; label: string; spendSen: number; purchaseSen: number; closingStockSen: number };
/** Performance vs forecast per product group (owner 2026-09-22): the ledger's actual through the group's sales accounts, the Performance P&L's sales and cost by SO date, the forecast through the same accounts — a side the period lacks is null, never 0. */
export type CompareTotals = {
  actualSalesSen: number | null;
  performanceSalesSen: number | null; performanceCostSen: number | null; performanceGpSen: number | null; performanceGpPct: number | null;
  forecastSalesSen: number | null; forecastCostSen: number | null; forecastGpSen: number | null; forecastGpPct: number | null;
};
export type CompareGroup = CompareTotals & { key: string; label: string };
export type DashboardCompare = { groups: CompareGroup[]; totals: CompareTotals };
export type DashboardCashFlow = { inSen: number; outSen: number; netSen: number; openingSen: number; closingSen: number; tree: LaidNode[] };
export type BalanceSummary = {
  assetsSen: number; liabilitiesSen: number; equitySen: number; earningsSen: number;
  currentAssetsSen: number; currentLiabilitiesSen: number; inventorySen: number;
  debtToAssetPct: number | null; checkSen: number;
};
export type Ratios = {
  grossMarginPct: number | null; netMarginPct: number | null;
  currentRatio: number | null; quickRatio: number | null;
  roePct: number | null; roaPct: number | null;
};
export type DashboardPeriod = {
  key: string; label: string; from: string; to: string; months: string[];
  /** Not finished as of today — the running month, a quarter not yet ended, or a future period. */
  partial: boolean;
  actual: DashboardFigures | null;
  forecast: DashboardFigures | null;
  performance: DashboardPerformance | null;
  compare: DashboardCompare | null;
  costStructure: { groups: CostStructureGroup[] } | null;
  cashFlow: DashboardCashFlow | null;
  balanceSheet: BalanceSummary | null;
  ratios: Ratios;
  stock: { closingProvisional: boolean };
};
export type DashboardPayload = {
  granularity: Granularity;
  today: string;
  window: { from: string; to: string };
  forecastMonths: string[];
  groups: { performance: Array<{ key: string; label: string }>; compare: Array<{ key: string; label: string }>; costStructure: Array<{ key: string; label: string }> };
  periods: DashboardPeriod[];
  cached?: boolean;
};

export type DashboardParams = { granularity: Granularity; periods?: number | null; from?: string | null; to?: string | null };

export const dashboardPath = (p: DashboardParams): string => {
  const q = new URLSearchParams();
  q.set('granularity', p.granularity);
  if (p.periods) q.set('periods', String(p.periods));
  if (p.from && p.to) { q.set('from', p.from); q.set('to', p.to); }
  return `/accounting/dashboard?${q.toString()}`;
};

export const useFinanceDashboard = (p: DashboardParams) => useQuery({
  queryKey: ['finance-dashboard', p.granularity, p.periods ?? null, p.from ?? null, p.to ?? null],
  queryFn: () => authedFetch<DashboardPayload>(dashboardPath(p)),
  staleTime: 30_000,
  retry: retryUnlessClientError,
});
