// ----------------------------------------------------------------------------
// logistics-queries — the Logistics cost report (owner 2026-10-29: 物流报告 按
// 地区、每趟、setup & dismantle —「都需要」; our own lorries OVERALL —「trip 除
// 成本」). Server: backend/src/scm/routes/acc-logistics.ts; the arithmetic:
// backend/src/scm/lib/logistics-cost.ts. Money in sen.
// ----------------------------------------------------------------------------

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { writeFailedAs } from './mutation-error';

export type LogisticsRegionRow = { code: string; name: string; dos: number; valueSen: number; ownSen: number; threeplSen: number; totalSen: number };
export type LogisticsTripRow = {
  kind: 'own' | '3pl'; day: string; who: string; ref: string | null;
  dos: number; doNumbers: string[]; regions: string[]; amountSen: number | null;
};
export type LogisticsMonthRow = { month: string; ownCostSen: number; trips: number; perTripSen: number | null; accounts: Array<{ code: string; name: string | null; sen: number }> };
export type LogisticsEventRow = { id: number; code: string | null; name: string; startDate: string | null; endDate: string | null; setupSen: number; transportSen: number; totalSen: number };
export type LogisticsReport = {
  from: string; to: string;
  months: LogisticsMonthRow[];
  regions: LogisticsRegionRow[];
  trips: LogisticsTripRow[];
  events: LogisticsEventRow[];
  gaps: {
    dosNoDeliverer: number;
    dosOutsideNoBill: number;
    unlistedPlates: string[];
    openLines: { count: number; sen: number };
    eventLinesNoFair: { count: number; sen: number };
    monthsWithoutTrips: string[];
  };
  totals: { dos: number; valueSen: number; ownSen: number; threeplSen: number; totalSen: number; setupSen: number; transportSen: number };
  /** The accounts the own-lorry cost was read from, and whether they are the chart's default. */
  ownCostAccounts: string[];
  ownCostDefault: boolean;
  /** Set when the fairs' books could not be read — Setup & Dismantle is then not known. */
  eventsProblem: string | null;
};

export function useLogisticsCost(from: string, to: string) {
  return useQuery({
    queryKey: ['acc-events', 'logistics', from, to],
    queryFn: () => authedFetch<LogisticsReport>(`/acc-events/logistics?from=${from}&to=${to}`),
    staleTime: 30_000,
  });
}

export type LogisticsSettings = {
  /** The company's own tick list; null = the chart's default. */
  picked: string[] | null;
  defaults: string[];
  candidates: Array<{ code: string; name: string | null }>;
};

export function useLogisticsSettings() {
  return useQuery({
    queryKey: ['acc-events', 'logistics-settings'],
    queryFn: () => authedFetch<LogisticsSettings>('/acc-events/logistics/settings'),
    staleTime: 60_000,
  });
}

/** Tick the accounts that make up our lorries' cost; null = back to the default. */
export function useSaveLogisticsSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (accounts: string[] | null) => authedFetch<{ ok: true; picked: string[] | null }>('/acc-events/logistics/settings', {
      method: 'PUT', body: JSON.stringify({ accounts }),
    }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['acc-events', 'logistics-settings'] });
      await qc.invalidateQueries({ queryKey: ['acc-events', 'logistics'] });
    },
    onError: writeFailedAs('Cost accounts not saved'),
  });
}
