/* CollectedOnOrderCard — what the SALES ORDER has collected, shown on a
   document downstream of it.

   Owner 2026-09-12: the money taken on the order must be visible on the
   documents that come out of it. Read-only by construction — the order is the
   one place a payment is taken, and a second entry point for the same money is
   the same receipt counted twice.

   A REFUSED READ IS NOT AN EMPTY ORDER. `error` is a REQUIRED prop rather than
   an optional one, because the two states look identical once a failed query's
   `data` becomes `[]`, and the expensive direction of that mistake is telling
   the office to chase money that is already in the drawer. The same rule, the
   same week, cost every change log in the system its honesty
   (docs/bugs/0848). */

import { fmtMoneySen } from '../../shared/format';
import { summariseCollected, type CollectedPayment } from '../lib/collected-on-order';

export type CollectedOnOrderCardProps = {
  /** The order's document number, shown so the reader knows WHICH document took
      the money. `null` means this document has no order behind it. */
  soDocNo: string | null;
  payments: readonly CollectedPayment[] | undefined;
  /** The read's failure, if it failed. Required — see the header. */
  error: unknown;
  isLoading: boolean;
  currency: string | null | undefined;
};

const fmtDay = (iso: string | null): string => (iso ? iso.slice(0, 10) : '—');

export function CollectedOnOrderCard({
  soDocNo, payments, error, isLoading, currency,
}: CollectedOnOrderCardProps) {
  if (!soDocNo) return null;

  if (error) {
    return (
      <div className="rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-[12px] text-ink" role="status">
        We could not read the payments on {soDocNo}, so anything already
        collected on the order is not shown here. This is not the same as the
        order having collected nothing. Please refresh.
      </div>
    );
  }

  if (isLoading) return <p className="px-1 py-2 text-[12px] text-ink-muted">Loading…</p>;

  const { payments: rows, totalSen, count } = summariseCollected(payments);
  if (count === 0) {
    return <p className="px-1 py-2 text-[12.5px] text-ink-muted">Nothing collected on {soDocNo} yet.</p>;
  }

  return (
    <div>
      <p className="px-1 pb-2 text-[12.5px] text-ink-muted">
        Taken on {soDocNo}, not on this document.{' '}
        <span className="font-semibold text-ink">{fmtMoneySen(totalSen, currency ?? 'MYR')}</span>
        {' '}across {count} {count === 1 ? 'receipt' : 'receipts'}.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-[12.5px]">
          <thead>
            <tr className="text-left font-mono text-[10px] uppercase tracking-brand text-ink-muted">
              <th className="px-1 py-1 font-semibold">Date</th>
              <th className="px-1 py-1 font-semibold">Method</th>
              <th className="px-1 py-1 font-semibold">Account</th>
              <th className="px-1 py-1 text-right font-semibold">Amount</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.id} className="border-t border-border-subtle">
                <td className="px-1 py-1.5 text-ink">{fmtDay(p.paid_at)}</td>
                <td className="px-1 py-1.5 capitalize text-ink-secondary">{p.method ?? '—'}</td>
                <td className="px-1 py-1.5 text-ink-secondary">{p.account_sheet || '—'}</td>
                <td className="px-1 py-1.5 text-right font-money font-semibold text-ink">
                  {fmtMoneySen(p.amount_sen, currency ?? 'MYR')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
