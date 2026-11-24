/* The Cash Flow's forecast columns (steps 2 to 4 of the forecast port): the
   Forecast P&L as cash, the Capex & financing table, and the money already
   in hand from open orders and owed bills, each month a Cash
   Flow report of its own on the same tree, from GET
   /accounting/reports/cash-flow-forecast; the table itself from GET / PUT
   /accounting/reports/cash-flow-forecast/inputs (server half:
   backend/src/scm/routes/accounting-cashflow-forecast.ts). */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { retryUnlessClientError } from '../../../lib/retryPolicy';
import type { RpReport } from './rp-report-queries';

export type CashFlowForecast = {
  from: string; to: string; currentMonth: string;
  /** The range's months, then — when it reaches the current month — the later months the money reaches. */
  months: Array<{ month: string; future: boolean; report: RpReport }>;
  /** What the timings were measured over. */
  measured: { from: string; to: string };
  /** The customers' money by kind and delay after the order month, in % of what came in. */
  receiptMix: Array<{ kind: 'DEP' | 'BAL'; months: number; pct: number }>;
  /** Suppliers counted a month later for want of a usable payment term. */
  flagged: Array<{ id: string; code: string; name: string }>;
  /** Forecast lines left out as moving no cash. */
  nonCash: Array<{ code: string; name: string }>;
  /** The Orders & bills column (step 4): the current month as at its 1st, then each later month
      the open orders and owed bills reach; null when the range ends before the current month. */
  docs: {
    months: Array<{ month: string; future: boolean; report: RpReport }>;
    /** The day the current month's orders and bills are taken as at. */
    asAt: string;
    /** Open orders with no delivery date, by the year ordered: in no month. */
    undated: Array<{ year: string; orders: number; sen: number }>;
    /** Orders and bills expected after the last month shown. */
    beyond: { orders: number; orderSen: number; bills: number; billSen: number };
    /** Suppliers a bill of which was timed a month later for want of a payment term. */
    flagged: string[];
  } | null;
  /** The trade-finance plan in both forecasts (step 5); null without a facility or before the current month. */
  tf: {
    facilities: Array<{ code: string; lender: string; tenorDays: number; rateBp: number; owedNowSen: number; suppliers: string[] }>;
    /** The Forecast P&L's interest lines left out: the interest comes with each repayment. */
    interestLeftOut: Array<{ code: string; name: string }>;
  } | null;
};

export const cashFlowForecastPath = (from: string, to: string): string =>
  `/accounting/reports/cash-flow-forecast?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;

/** The months from..to (YYYY-MM); off while either is blank. */
export const useCashFlowForecast = (from: string, to: string) => useQuery({
  queryKey: ['report-rp-forecast', from, to],
  queryFn: () => authedFetch<CashFlowForecast>(cashFlowForecastPath(from, to)),
  enabled: Boolean(from && to),
  staleTime: 30_000,
  retry: retryUnlessClientError,
});

/* ── The Capex & financing table (step 3) ─────────────────────────────────── */

/** 'YYYY-MM' → account code → whole sen, + money in, − money out. */
export type KeyedInputs = Record<string, Record<string, number>>;
export type KeyableAccount = { code: string; name: string; group: { id: string; label: string } };
export type ForecastInputs = {
  currentMonth: string;
  /** The months the table shows: the current one and the eleven after it. */
  shown: string[];
  months: KeyedInputs;
  accounts: KeyableAccount[];
  /** Keyed in some month but no longer on the layout's funding block: to be cleared before a save. */
  notOffered: Array<{ code: string; name: string }>;
};

const INPUTS_KEY = 'cash-flow-forecast-inputs';
export const useForecastInputs = (enabled: boolean) => useQuery({
  queryKey: [INPUTS_KEY],
  queryFn: () => authedFetch<ForecastInputs>('/accounting/reports/cash-flow-forecast/inputs'),
  enabled,
  staleTime: 0,
  retry: retryUnlessClientError,
});

/** PUT the whole table: every month sent is kept as sent, everything else is cleared. */
export const useSaveForecastInputs = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (months: KeyedInputs) =>
      authedFetch<{ ok: boolean; months: KeyedInputs }>('/accounting/reports/cash-flow-forecast/inputs', { method: 'PUT', body: JSON.stringify({ months }) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: [INPUTS_KEY] });
      void qc.invalidateQueries({ queryKey: ['report-rp-forecast'] });
    },
  });
};

/* ── The Trade finance table (step 5) ─────────────────────────────────────── */

/** What a chosen supplier is due in a month: from bills the books owe, and from the Forecast P&L. */
export type TfDue = { billSen: number; forecastSen: number };
/** Month → supplier ids unticked by hand. */
export type TfOff = Record<string, string[]>;
export type TfMonth = { ym: string; drawSen: number; repaySen: number; interestSen: number; owedSen: number };
export type TfFacility = {
  code: string; name: string; lender: string;
  /** Finance's own tenor and rate per draw; null = the default. */
  tenorSet: number | null; rateSet: number | null;
  tenorDays: number; rateBp: number; defaultRateBp: number;
  interest: { code: string; name: string } | null;
  owedNowSen: number;
  /** The draws still owed, oldest first. */
  open: Array<{ date: string; sen: number }>;
  suppliers: string[];
  off: TfOff;
  /** Supplier id → month → what is due. */
  dues: Record<string, Record<string, TfDue>>;
  schedule: TfMonth[];
};
export type TradeFinance = {
  currentMonth: string;
  /** The months the table shows: the current one and the eleven after it. */
  shown: string[];
  facilities: TfFacility[];
  suppliers: Array<{ id: string; code: string; name: string; term: string | null }>;
};
/** Account code → the plan to keep. */
export type TfPlans = Record<string, { tenorDays: number | null; rateBp: number | null; suppliers: string[]; off: TfOff }>;

const TF_KEY = 'cash-flow-forecast-tf';
export const useTradeFinance = (enabled: boolean) => useQuery({
  queryKey: [TF_KEY],
  queryFn: () => authedFetch<TradeFinance>('/accounting/reports/cash-flow-forecast/tf'),
  enabled,
  staleTime: 0,
  retry: retryUnlessClientError,
});

/** PUT each facility's plan; the table and the forecast are read again. */
export const useSaveTradeFinance = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (facilities: TfPlans) =>
      authedFetch<{ ok: boolean }>('/accounting/reports/cash-flow-forecast/tf', { method: 'PUT', body: JSON.stringify({ facilities }) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: [TF_KEY] });
      void qc.invalidateQueries({ queryKey: ['report-rp-forecast'] });
    },
  });
};
