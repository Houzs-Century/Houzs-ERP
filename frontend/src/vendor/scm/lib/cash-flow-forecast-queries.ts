import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { retryUnlessClientError } from '../../../lib/retryPolicy';
import type { RpReport } from './rp-report-queries';

export type CashFlowForecast = {
  from: string; to: string; currentMonth: string;
  months: Array<{ month: string; future: boolean; report: RpReport }>;
  measured: { from: string; to: string };
  receiptMix: Array<{ kind: 'DEP' | 'BAL'; months: number; pct: number }>;
  flagged: Array<{ id: string; code: string; name: string }>;
  nonCash: Array<{ code: string; name: string }>;
  docs: {
    months: Array<{ month: string; future: boolean; report: RpReport }>;
    asAt: string;
    undated: Array<{ year: string; orders: number; sen: number }>;
    beyond: { orders: number; orderSen: number; bills: number; billSen: number };
    flagged: string[];
  } | null;
  tf: {
    facilities: Array<{ code: string; lender: string; tenorDays: number; rateBp: number; owedNowSen: number; suppliers: string[] }>;
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


/** 'YYYY-MM' → account code → whole sen, + money in, − money out. */
export type KeyedInputs = Record<string, Record<string, number>>;
export type KeyableAccount = { code: string; name: string; group: { id: string; label: string } };
export type ForecastInputs = {
  currentMonth: string;
  shown: string[];
  months: KeyedInputs;
  accounts: KeyableAccount[];
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


/** What a chosen supplier is due in a month: from bills the books owe, and from the Forecast P&L. */
export type TfDue = { billSen: number; forecastSen: number };
/** Month → supplier ids unticked by hand. */
export type TfOff = Record<string, string[]>;
export type TfMonth = { ym: string; drawSen: number; repaySen: number; interestSen: number; owedSen: number };
export type TfFacility = {
  code: string; name: string; lender: string;
  tenorSet: number | null; rateSet: number | null;
  tenorDays: number; rateBp: number; defaultRateBp: number;
  interest: { code: string; name: string } | null;
  owedNowSen: number;
  open: Array<{ date: string; sen: number }>;
  suppliers: string[];
  off: TfOff;
  dues: Record<string, Record<string, TfDue>>;
  schedule: TfMonth[];
};
export type TradeFinance = {
  currentMonth: string;
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
