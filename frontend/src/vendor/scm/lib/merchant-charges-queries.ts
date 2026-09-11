/* The Merchant charges report (owner 2026-09-12): per month and per
   acquirer, what the merchant took against the gross, the bank's own payout
   charge beside it, a total per month across merchants. Numbers come from
   GET /accounting/reports/merchant-charges; see accounting.md (docs/bugs/0826). */

import { useQuery } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { retryUnlessClientError } from '../../../lib/retryPolicy';

export type ChargeFigures = {
  lines: number; grossSen: number; feeSen: number; netSen: number; feePct: number;
  bankChargeSen: number; chargeSen: number; chargePct: number;
};
export type ChargeReport = ChargeFigures & { batchId: number; fileName: string | null; periodFrom: string | null; periodTo: string | null };
export type ChargeAcquirer = ChargeFigures & { month: string; acquirer: string; reports: ChargeReport[] };
export type ChargeMonth = ChargeFigures & { month: string; acquirers: ChargeAcquirer[] };
export type MerchantChargesReport = {
  from: string; to: string; confirmedOnly: boolean; acquirer: string | null;
  months: ChargeMonth[]; totals: ChargeFigures;
};

export const merchantChargesPath = (from: string, to: string, acquirer: string | null, confirmedOnly: boolean): string =>
  `/accounting/reports/merchant-charges?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`
  + (acquirer ? `&acquirer=${encodeURIComponent(acquirer)}` : '')
  + (confirmedOnly ? '&confirmed=1' : '');

export const useMerchantChargesReport = (from: string, to: string, acquirer: string | null, confirmedOnly: boolean) => useQuery({
  queryKey: ['report-merchant-charges', from, to, acquirer, confirmedOnly],
  queryFn: () => authedFetch<MerchantChargesReport>(merchantChargesPath(from, to, acquirer, confirmedOnly)),
  enabled: Boolean(from && to),
  staleTime: 30_000,
  retry: retryUnlessClientError,
});
