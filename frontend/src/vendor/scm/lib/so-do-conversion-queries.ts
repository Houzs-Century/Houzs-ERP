// ----------------------------------------------------------------------------
// so-do-conversion-queries — Finance's SO to DO conversion report (owner
// 2026-11-24): the month's shipped delivery orders, split into those raised
// from this month's orders and those from earlier ones, each part's total and
// its share of the month's DO total. Server:
// backend/src/scm/routes/accounting-so-do-conversion.ts over
// acc/so-do-conversion.ts.
// ----------------------------------------------------------------------------

import { useQuery } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { retryUnlessClientError } from '../../../lib/retryPolicy';

/** this_month: the order's SO date is in the DO's month. earlier: before it
 *  (orders brought over from AutoCount included). other: no order, or one dated after. */
export type ConversionPart = 'this_month' | 'earlier' | 'other';
export type OtherReason = 'no_order' | 'order_not_found' | 'order_after';

export type ConversionRow = {
  id: string;
  doNumber: string;
  /** The month the DO counts in. */
  doDate: string;
  status: string;
  docNo: string | null;
  soDate: string | null;
  customer: string | null;
  /** The order came over from AutoCount at the cutover. */
  imported: boolean;
  part: ConversionPart;
  otherReason: OtherReason | null;
  amountSen: number;
};

export type ConversionTotal = {
  dos: number;
  amountSen: number;
  /** Share of the month's DO total, one decimal; null when the month has none. */
  pct: number | null;
};

export type SoDoConversionData = {
  month: string;
  from: string;
  to: string;
  total: ConversionTotal;
  parts: Record<ConversionPart, ConversionTotal>;
  rows: ConversionRow[];
};

export const useSoDoConversion = (month: string) => useQuery({
  queryKey: ['so-do-conversion', month],
  queryFn: () => authedFetch<SoDoConversionData>(`/accounting/so-do-conversion?month=${encodeURIComponent(month)}`),
  staleTime: 30_000,
  retry: retryUnlessClientError,
  retryDelay: 800,
});
