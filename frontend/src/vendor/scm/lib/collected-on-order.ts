/* What a sales order has COLLECTED, for a downstream document to show.

   Owner 2026-09-12: 「付款记录，SO 的付款要带去 DO 跟 SI」— the money taken on the
   order must be visible on the documents that come out of it. The sales invoice
   already does this (its "Collected on HC-SO-…" section); the delivery order
   showed nothing at all.

   CARRY MEANS SHOW, NOT RE-ENTER. This module deliberately produces a read-only
   summary and no way to record anything: a deposit banked against the order and
   then keyed a second time against the delivery order is the same money counted
   twice, and the order remains the one place it is taken.

   Why a shared module rather than a few lines on the delivery-order page: the
   figure is a MONEY figure, and a second implementation of a money rule is how
   the order screen and the delivery screen start disagreeing quietly. */

export type CollectedPayment = {
  id: string;
  paid_at: string | null;
  method: string | null;
  amount_sen: number;
  account_sheet: string | null;
  note: string | null;
  collected_by_name?: string | null;
};

export type CollectedOnOrder = {
  /** Every payment row on the order, newest first. */
  payments: CollectedPayment[];
  /** Their sum, in sen. */
  totalSen: number;
  /** How many there are — so a caption never has to recount. */
  count: number;
};

const amountOf = (p: CollectedPayment): number => {
  const n = Number(p.amount_sen);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
};

/**
 * Summarise an order's payment rows for a downstream document.
 *
 * A refused read must NOT arrive here as an empty array — the caller is
 * expected to keep its query error and say so on screen. "The order collected
 * nothing" and "we could not read the order" look identical once both are `[]`,
 * and telling the office to chase money that is already in the drawer is the
 * expensive direction of that mistake.
 */
export const summariseCollected = (
  payments: readonly CollectedPayment[] | undefined | null,
): CollectedOnOrder => {
  const rows = [...(payments ?? [])].sort((a, b) => {
    const da = a.paid_at ?? '';
    const db = b.paid_at ?? '';
    if (da !== db) return da < db ? 1 : -1;
    return a.id < b.id ? 1 : -1;
  });
  return {
    payments: rows,
    totalSen: rows.reduce((s, p) => s + amountOf(p), 0),
    count: rows.length,
  };
};
