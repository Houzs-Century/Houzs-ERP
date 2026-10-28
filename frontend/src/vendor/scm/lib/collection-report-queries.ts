/* The Collection report (owner 2026-09-12): per salesman, deposit collected
   against order value for the orders opened in a period, and the balance
   collected on the delivered ones. Numbers come from
   GET /accounting/reports/collection; see accounting.md (docs/bugs/0825). */

import { useQuery } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { retryUnlessClientError } from '../../../lib/retryPolicy';

export type CollectionOrder = {
  docNo: string; soDate: string; status: string; customer: string | null;
  totalSen: number; depositSen: number; balancePaidSen: number; collectedSen: number; outstandingSen: number;
  depositPct: number; balanceDueSen: number; balancePct: number; delivered: boolean; belowThreshold: boolean;
  /** The live sales invoice on the order, when one exists, and what was billed (its total, else the order's). */
  invoiceNumber: string | null; billedSen: number;
};
export type CollectionDelivered = {
  orders: number; totalSen: number; billedSen: number; depositSen: number; balanceDueSen: number; balancePaidSen: number; balancePct: number; outstandingSen: number;
};
export type CollectionRow = {
  salespersonId: string | null; salesperson: string;
  orders: number; totalSen: number; depositSen: number; depositPct: number; belowCount: number;
  delivered: CollectionDelivered;
  sos: CollectionOrder[];
};
export type CollectionReport = { from: string; to: string; thresholdPct: number; rows: CollectionRow[]; totals: CollectionRow };

export const collectionReportPath = (from: string, to: string, thresholdPct: number, salespersonId: string | null): string =>
  `/accounting/reports/collection?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&threshold=${encodeURIComponent(String(thresholdPct))}`
  + (salespersonId ? `&salesperson=${encodeURIComponent(salespersonId)}` : '');

export const useCollectionReport = (from: string, to: string, thresholdPct: number, salespersonId: string | null) => useQuery({
  queryKey: ['report-collection', from, to, thresholdPct, salespersonId],
  queryFn: () => authedFetch<CollectionReport>(collectionReportPath(from, to, thresholdPct, salespersonId)),
  enabled: Boolean(from && to),
  staleTime: 30_000,
  retry: retryUnlessClientError,
});
