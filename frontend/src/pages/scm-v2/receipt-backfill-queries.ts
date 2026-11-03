// Official receipts owed to history — the plan and the run behind Self-check's
// "Official receipts" row (once ReceiptBackfillCard). The plan (what the run
// would take, per month and series) is read on mount; nothing is written
// until the run is pressed and confirmed.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from '../../vendor/scm/lib/authed-fetch';
import { retryUnlessClientError } from '../../lib/retryPolicy';

export type BackfillSeries = { series: string; count: number; from: string; to: string };
export type BackfillMonth = { ym: string; payments: number; cash: number; confirmedCards: number; unlettered: number; series: BackfillSeries[] };
export type BackfillPlan = { total: number; months: BackfillMonth[] };
export type BackfillResult = { created: number; formalised: number; failed: Array<{ paymentId: string; docNo: string; reason: string }>; remaining: number };

export const RECEIPT_PLAN_KEY = ['receipt-backfill-plan'] as const;

export const useReceiptBackfillPlan = () => useQuery({
  queryKey: RECEIPT_PLAN_KEY,
  queryFn: () => authedFetch<BackfillPlan>('/accounting/receipts/backfill'),
  staleTime: 30_000,
  retry: retryUnlessClientError,
});

/** The run, in batches the server sizes (owner 2026-09-16: one call for 179
    outran the 30 s the client waits): call again while something is left and
    the last batch made progress; `onBatch` carries the running total. */
export const useRunReceiptBackfill = (onBatch?: (sum: BackfillResult) => void) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const sum: BackfillResult = { created: 0, formalised: 0, failed: [], remaining: -1 };
      for (;;) {
        const r = await authedFetch<BackfillResult>('/accounting/receipts/backfill', { method: 'POST' });
        sum.created += r.created; sum.formalised += r.formalised; sum.failed = [...sum.failed, ...r.failed]; sum.remaining = r.remaining;
        onBatch?.({ ...sum });
        if (r.remaining <= 0 || r.created + r.formalised === 0) return sum;
      }
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: RECEIPT_PLAN_KEY });
      void qc.invalidateQueries({ queryKey: ['receipts'] });
      void qc.invalidateQueries({ queryKey: ['finance-todo'] });
    },
  });
};

/** "2606" → "June 2026" (a month, not a date). */
export const monthLabel = (ym: string): string =>
  new Date(Date.UTC(2000 + Number(ym.slice(0, 2)), Number(ym.slice(2, 4)) - 1, 1)).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });

/** The months a plan spans, in words: one or two named, more counted. */
export const monthsWord = (months: readonly BackfillMonth[]): string =>
  months.length === 0 ? 'no month' : months.length <= 2 ? months.map((m) => monthLabel(m.ym)).join(' and ') : `${months.length} months`;

/** One line per series: "2990-DraftOR-2606-001 – 040 (40)". */
export const seriesLine = (s: BackfillSeries): string =>
  s.count === 1 ? `${s.from} (1)` : `${s.from} – ${s.to.slice(s.to.lastIndexOf('-') + 1)} (${s.count})`;
