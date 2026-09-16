// Official receipts owed to history — the Self-check card that mints them.
// The plan (what the run would take, per month and series) is read on
// mount; nothing is written until the button is pressed and confirmed.

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from '../../vendor/scm/lib/authed-fetch';
import { retryUnlessClientError } from '../../lib/retryPolicy';
import { useConfirm } from '../../vendor/scm/components/ConfirmDialog';

export type BackfillSeries = { series: string; count: number; from: string; to: string };
export type BackfillMonth = { ym: string; payments: number; cash: number; confirmedCards: number; unlettered: number; series: BackfillSeries[] };
export type BackfillPlan = { total: number; months: BackfillMonth[] };
export type BackfillResult = { created: number; formalised: number; failed: Array<{ paymentId: string; docNo: string; reason: string }>; remaining: number };

const PLAN_KEY = ['receipt-backfill-plan'] as const;

export const useReceiptBackfillPlan = () => useQuery({
  queryKey: PLAN_KEY,
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
      void qc.invalidateQueries({ queryKey: PLAN_KEY });
      void qc.invalidateQueries({ queryKey: ['receipts'] });
    },
  });
};

/** "2606" → "06/2026". */
export const monthWord = (ym: string): string => `${ym.slice(2, 4)}/20${ym.slice(0, 2)}`;

/** One line per series: "2990-DraftOR-2606-001 – 040 (40)". */
export const seriesLine = (s: BackfillSeries): string =>
  s.count === 1 ? `${s.from} (1)` : `${s.from} – ${s.to.slice(s.to.lastIndexOf('-') + 1)} (${s.count})`;

const cardStyle = {
  background: 'var(--c-paper, #fff)', border: '1px solid var(--c-line, rgba(34,31,32,0.18))',
  borderRadius: 10, padding: 'var(--space-4, 16px)',
} as const;
const good = 'var(--c-secondary-a, #2F5D4F)';
const bad = 'var(--c-festive-b, #B8331F)';

export const ReceiptBackfillCard = () => {
  const plan = useReceiptBackfillPlan();
  const [progress, setProgress] = useState<BackfillResult | null>(null);
  const run = useRunReceiptBackfill(setProgress);
  const askConfirm = useConfirm();
  const p = plan.data;
  const clean = p != null && p.total === 0;

  return (
    <div style={{ ...cardStyle, borderColor: plan.isError ? bad : clean ? good : bad }} className="space-y-2" data-testid="receipt-backfill-card">
      <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center', flexWrap: 'wrap' }}>
        <b>Official receipts</b>
        {plan.isLoading && <span style={{ fontSize: 'var(--fs-13)' }}>Counting…</span>}
        {plan.isError && <span style={{ fontSize: 'var(--fs-13)', color: bad }}>not checked — the read failed</span>}
        {p && (
          <span style={{
            padding: '2px 10px', borderRadius: 999, fontWeight: 700, fontSize: 'var(--fs-12)',
            background: clean ? 'rgba(47, 93, 79, 0.12)' : 'rgba(184, 51, 31, 0.12)', color: clean ? good : bad,
          }}>
            {clean ? 'every payment has one' : `${p.total} payment${p.total === 1 ? '' : 's'} without one`}
          </span>
        )}
        {p && !clean && !run.data && (
          <button type="button" disabled={run.isPending}
            onClick={() => {
              void askConfirm({
                title: `Create ${p.total} receipt${p.total === 1 ? '' : 's'} now?`,
                body: 'Each payment gets its receipt on its own month\'s series, in payment-date order — cash formal at once, card payments already confirmed on merchant reconciliation formal on their payout bank, the rest as drafts. Nothing in the ledger moves.',
                confirmLabel: 'Create them',
              }).then((ok) => { if (ok) run.mutate(); });
            }}
            style={{ marginLeft: 'auto', border: `1px solid ${good}`, color: good, background: 'none', borderRadius: 6, padding: '4px 12px', cursor: 'pointer', fontSize: 'var(--fs-12)', fontWeight: 700 }}>
            {run.isPending ? (progress ? `Creating… ${progress.created} of ${p.total}, ${progress.remaining} left` : 'Creating…') : `Create ${p.total} receipt${p.total === 1 ? '' : 's'} now`}
          </button>
        )}
      </div>
      {p && !clean && (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--fs-13)' }}>
          <thead>
            <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--c-line, rgba(34,31,32,0.18))' }}>
              <th>Month</th><th style={{ textAlign: 'right' }}>Payments</th><th>Numbers the run takes</th>
            </tr>
          </thead>
          <tbody>
            {p.months.map((m) => (
              <tr key={m.ym} style={{ borderBottom: '1px solid var(--c-line, rgba(34,31,32,0.10))', verticalAlign: 'top' }}>
                <td>{monthWord(m.ym)}</td>
                <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                  {m.payments}
                  <div style={{ fontSize: 'var(--fs-12)', color: 'var(--c-ink-soft, #777)' }}>
                    {m.cash} cash · {m.confirmedCards} card confirmed{m.unlettered > 0 ? ` · ${m.unlettered} confirmed but the payout bank has no letter yet` : ''}
                  </div>
                </td>
                <td style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-12)' }}>
                  {m.series.map((s) => <div key={s.series}>{seriesLine(s)}</div>)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {run.isError && (
        <div style={{ fontSize: 'var(--fs-13)', color: bad }}>
          The run stopped: {run.error instanceof Error ? run.error.message : String(run.error)}
          {progress && ` — ${progress.created} created so far; every receipt made is kept, press again for the rest.`}
        </div>
      )}
      {run.data && (
        <div style={{ fontSize: 'var(--fs-13)', color: run.data.failed.length > 0 ? bad : good, fontWeight: 600 }}>
          Created {run.data.created}, formal {run.data.formalised}, refused {run.data.failed.length}
          {run.data.remaining > 0 ? ` — ${run.data.remaining} still without one` : ' — every payment has one now'}.
          {run.data.failed.length > 0 && (
            <ul style={{ fontWeight: 400, marginTop: 4 }}>
              {run.data.failed.map((f) => <li key={`${f.paymentId}:${f.reason}`}>{f.docNo || f.paymentId}: {f.reason}</li>)}
            </ul>
          )}
        </div>
      )}
    </div>
  );
};
