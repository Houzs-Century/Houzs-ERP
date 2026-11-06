// ----------------------------------------------------------------------------
// aging-queries — the formal AR / AP Aging (owner 2026-10-02: 正式 account 的
// debtor & creditor aging; B1a by month, B2a by the invoice's month, B3a money
// not tied to a bill in 未冲, B4 replacing the old ones under the same names).
// Server: backend/src/scm/routes/accounting-aging.ts over acc/aging.ts.
// The query keys still start 'ar-aging' / 'ap-aging', so the invoice and AP
// screens that refresh the old aging after a change refresh this one.
// ----------------------------------------------------------------------------

import { useQuery } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { retryUnlessClientError } from '../../../lib/retryPolicy';

export type AgingSide = 'ar' | 'ap';
export type AgingBasis = 'invoice' | 'due';
export type AgingBuckets = 'month' | 'day';
export type AgingControl = 'all' | 'trade' | 'other';

export type AgingOpenItem = { group: string; docNo: string; kind: string; date: string; dueDate: string | null; amountSen: number; openSen: number; column: number };
export type AgingUnappliedItem = { docNo: string; kind: string; date: string; amountSen: number };
export type AgingRow = {
  key: string;
  code: string | null;
  name: string;
  balanceSen: number;
  /** The five columns, in sen: This month · 1 · 2 · 3 · 4 months + (本月 … 4 个月以上), or by days. */
  cells: number[];
  /** Money not tied to a bill (未冲, Unapplied) — negative. */
  unappliedSen: number;
  items: AgingOpenItem[];
  unapplied: AgingUnappliedItem[];
};
export type AgingReportData = {
  asOf: string;
  basis: AgingBasis;
  buckets: AgingBuckets;
  control: AgingControl;
  rows: AgingRow[];
  totals: { balanceSen: number; cells: number[]; unappliedSen: number };
  controls: Array<{ code: string; balanceSen: number }>;
  /** What the rows miss of the control accounts — zero by construction. */
  differenceSen: number;
  /** Open invoices brought over from AutoCount: never booked here, not aged. */
  outside: { count: number; sen: number };
  /** AR: orders owing here although AutoCount took their deposit before the ERP. */
  paidBeforeErp?: { orders: number; sen: number };
};

/** The five columns' names, in English (the owner's Claude Design, batch 6
    question g1, default: today's report and its choices, in English). */
export const AGING_COLUMN_LABELS: Record<AgingBuckets, string[]> = {
  month: ['This month', '1 month', '2 months', '3 months', '4 months +'],
  day: ['0–30', '31–60', '61–90', '91–120', 'Over 120 days'],
};

export const useAging = (side: AgingSide, p: { asOf: string; basis: AgingBasis; buckets: AgingBuckets; control: AgingControl }) => useQuery({
  queryKey: [side === 'ar' ? 'ar-aging' : 'ap-aging', p.asOf, p.basis, p.buckets, p.control],
  queryFn: () => {
    const qs = new URLSearchParams({ asOf: p.asOf, basis: p.basis, buckets: p.buckets, control: p.control });
    return authedFetch<AgingReportData>(`/accounting/${side}-aging?${qs.toString()}`);
  },
  staleTime: 30_000,
  retry: retryUnlessClientError,
  retryDelay: 800,
});
