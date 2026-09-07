/* The Receipts & Payments report (owner 2026-09-06/07) — one read, the
   AutoCount shape: a column per cash/bank account plus Total, receipts above
   payments, opening and closing per column, rows in the owner's own accounts
   (a supplier payment read through what it settled — rule A — unless the
   report is asked by party). The numbers come from
   GET /accounting/reports/receipts-payments; see accounting.md. */

import { useQuery } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { retryUnlessClientError } from '../../../lib/retryPolicy';

export type RpColumn = { code: string; name: string };
export type RpRow = { key: string; code: string | null; name: string; cells: Record<string, number>; totalSen: number };
export type RpEntry = {
  jeNo: string; entryDate: string; sourceType: string | null; sourceDocNo: string | null;
  narration: string | null; party: string | null; side: 'R' | 'P'; rowKey: string; column: string; sen: number;
};
export type RpReport = {
  from: string; to: string; byParty: boolean;
  columns: RpColumn[];
  opening: Record<string, number>;
  receipts: RpRow[];
  payments: RpRow[];
  totals: {
    receipts: Record<string, number>; payments: Record<string, number>; closing: Record<string, number>;
    openingTotalSen: number; receiptsTotalSen: number; paymentsTotalSen: number; closingTotalSen: number;
  };
  entries: RpEntry[];
};

export const rpReportPath = (from: string, to: string, accounts: readonly string[], byParty: boolean): string =>
  `/accounting/reports/receipts-payments?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`
  + (accounts.length > 0 ? `&accounts=${encodeURIComponent(accounts.join(','))}` : '')
  + (byParty ? '&party=1' : '');

export const useRpReport = (from: string, to: string, accounts: readonly string[], byParty: boolean) => useQuery({
  queryKey: ['report-rp', from, to, accounts.join(','), byParty],
  queryFn: () => authedFetch<RpReport>(rpReportPath(from, to, accounts, byParty)),
  enabled: Boolean(from && to),
  staleTime: 30_000,
  retry: retryUnlessClientError,
});
