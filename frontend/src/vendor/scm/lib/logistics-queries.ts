// ----------------------------------------------------------------------------
// logistics-queries — the Logistics cost report (owner 2026-10-29: 物流报告 按
// 地区、每趟、setup & dismantle —「都需要」; our own lorries OVERALL —「trip 除
// 成本」). Server: backend/src/scm/routes/acc-logistics.ts; the arithmetic:
// backend/src/scm/lib/logistics-cost.ts. Money in sen.
// ----------------------------------------------------------------------------

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { writeFailedAs } from './mutation-error';

/** One of the four regions the books split transport by (2026-10-29): Penang, KL, SBH & SWK, SGD. */
export type LogisticsRegionRow = { code: string; name: string; covers: string; dos: number; valueSen: number; ownSen: number; threeplSen: number; totalSen: number };
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
    /** DOs with no state and no Singapore address — counted under KL's "others". */
    dosNoState: number;
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

/* ── The Logistics P&L (owner 2026-10-29, 做 — his Logistic Cost Report from the
   books). Server: backend/src/scm/routes/acc-logistics-pnl.ts; the arithmetic:
   backend/src/scm/lib/logistics-pnl.ts. ───────────────────────────────────── */
export type PnlRegion = 'PG' | 'KL' | 'EM' | 'SG';
export type LogisticsPnlRow = { key: string; label: string; sen: Record<PnlRegion, number | null>; totalSen: number | null };
export type LogisticsIncomeLine = {
  lineId: string; billNo: string; billDate: string; debtorName: string; description: string | null;
  accountCode: string; accountName: string | null; amountSen: number;
  month: string; row: 'houzs' | 'conts' | 'hookka' | '2990'; region: PnlRegion; by: 'account' | 'wording';
};
export type LogisticsSetupTrip = {
  key: string; kind: 'setup' | 'dismantle'; day: string; venue: string;
  area: string | null; areaLabel: string; region: PnlRegion;
  fairs: Array<{ id: number; code: string | null; name: string }>;
  rateSen: number | null; outsourced: boolean; mark: boolean | null; inHouse: boolean; amountSen: number;
};
export type LogisticsSpreadRow = {
  lineId: string; kind: 'upkeep' | 'roadtax'; accountCode: string; accountName: string | null; day: string;
  docNo: string | null; notes: string | null; amountSen: number;
  months: number; isDefault: boolean; perMonthSen: number; inRangeSen: number; lastMonth: string;
};
export type LogisticsAreaRate = { key: string; label: string; region: PnlRegion; rateSen: number | null; defaultRateSen: number | null; isDefault: boolean };
export type LogisticsPnl = {
  from: string; to: string; months: string[];
  doIncomeBp: number;
  dos: Record<PnlRegion, number> & { total: number };
  rows: LogisticsPnlRow[];
  income: LogisticsIncomeLine[];
  trips: LogisticsSetupTrip[];
  spreads: LogisticsSpreadRow[];
  ownTrips: number;
  inHousePerTripSen: number | null;
  /** Set when the fairs could not be read — no setup / dismantle trip is priced then. */
  tripsProblem: string | null;
  areaRates: LogisticsAreaRate[];
};

const PNL_KEY = ['acc-events', 'logistics-pnl'] as const;

export function useLogisticsPnl(from: string, to: string) {
  return useQuery({
    queryKey: [...PNL_KEY, from, to],
    queryFn: () => authedFetch<LogisticsPnl>(`/acc-events/logistics/pnl?from=${from}&to=${to}`),
    staleTime: 30_000,
  });
}

/** One of the P&L's settings saved, the P&L read again. */
function usePnlSetting<B>(path: string, failedAs: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: B) => authedFetch<{ ok: true }>(path, { method: 'PUT', body: JSON.stringify(body) }),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: PNL_KEY }); },
    onError: writeFailedAs(failedAs),
  });
}

/** The share of the DOs' value counted as transport income, in percent. */
export const useSaveIncomeRate = () => usePnlSetting<{ pct: number }>('/acc-events/logistics/income-rate', 'Rate not saved');
/** One area's rate per setup / dismantle trip; rateRm null = no rate; reset = the default again. */
export const useSaveAreaRate = () => usePnlSetting<{ area: string; rateRm?: number | null; reset?: true }>('/acc-events/logistics/area-rate', 'Area rate not saved');
/** How many months one upkeep / insurance bill is spread over; null = its default again. */
export const useSaveSpread = () => usePnlSetting<{ lineId: string; months: number | null }>('/acc-events/logistics/spread', 'Spread not saved');
/** One setup / dismantle trip ticked (ours) or unticked; null = the rule again. */
export const useSaveTripMark = () => usePnlSetting<{ tripKey: string; inHouse: boolean | null }>('/acc-events/logistics/trip', 'Trip not saved');

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
