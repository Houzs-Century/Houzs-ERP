/* The Merchant charges report (owner 2026-09-12): per month and per
   acquirer, what the merchant took against the gross, the bank's own payout
   charge beside it, a total per month across merchants — and, since
   2026-09-14 (docs/bugs/0900), the CASH and ONLINE rows: the payments keyed
   on sales orders that no merchant carried, at 0%, counted in the month and
   the total so Charge % reads against everything received. Numbers come from
   GET /accounting/reports/merchant-charges; see accounting.md (docs/bugs/0826). */

import { useQuery } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { retryUnlessClientError } from '../../../lib/retryPolicy';

export type ChargeFigures = {
  lines: number; grossSen: number; feeSen: number; netSen: number; feePct: number;
  bankChargeSen: number; chargeSen: number; chargePct: number;
};
export type ChargeReport = ChargeFigures & { batchId: number; fileName: string | null; periodFrom: string | null; periodTo: string | null };
/** A payment keyed on a sales order that no merchant carried — what a CASH
    or ONLINE row opens to, in place of report files. */
export type ChargePayment = { id: string; docNo: string; paidOn: string; amountSen: number; subType: string | null };
export type ChargeAcquirer = ChargeFigures & { month: string; acquirer: string; reports: ChargeReport[]; payments?: ChargePayment[] };
export type ChargeMonth = ChargeFigures & { month: string; acquirers: ChargeAcquirer[] };
export type MerchantChargesReport = {
  from: string; to: string; confirmedOnly: boolean; acquirer: string | null;
  months: ChargeMonth[]; totals: ChargeFigures;
};

/** The two rows no merchant carries, as the server names them. */
export const CASH_CHANNEL = 'CASH';
export const ONLINE_CHANNEL = 'ONLINE';
/** How a row is labelled: an acquirer by its code, a channel by its word. */
export const channelLabel = (acquirer: string): string =>
  (acquirer === CASH_CHANNEL ? 'Cash' : acquirer === ONLINE_CHANNEL ? 'Online' : acquirer);
/** Acquirers first, alphabetically; then Cash, then Online — the order the
    server lists them in, kept for the filter. */
export const channelOrder = (a: string, b: string): number => {
  const rank = (x: string) => (x === CASH_CHANNEL ? 1 : x === ONLINE_CHANNEL ? 2 : 0);
  return rank(a) - rank(b) || a.localeCompare(b);
};
/** What one keyed payment is worth on the report: its amount, no fee. */
export const paymentFigures = (p: ChargePayment): ChargeFigures => ({
  lines: 1, grossSen: p.amountSen, feeSen: 0, netSen: p.amountSen, feePct: 0, bankChargeSen: 0, chargeSen: 0, chargePct: 0,
});

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
