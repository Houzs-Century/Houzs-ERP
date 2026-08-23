// markPaidPlan — what the Sales Invoice "Mark paid" button is allowed to do.
//
// WHAT WAS WRONG. The button called PATCH /sales-invoices/:id/status with
// { status: 'PAID' } and recorded NO money. That left one document contradicting
// itself — the status column said PAID while `paid_sen` stayed 0 — and the
// contradiction did not survive: `recomputeSiPaid` (backend
// `scm/lib/si-order-deposit.ts`) DERIVES the status from the payments ledger
// (paid >= total -> PAID, paid > 0 -> PARTIALLY_PAID, else SENT) and runs on
// every payment insert / edit / delete and on any change to the source order's
// deposit. So the hand-written PAID was silently reverted the next time anything
// touched that invoice's money, and in the meantime the office had an invoice
// that looked settled with nothing banked against it.
//
// WHAT IT DOES NOW. It records a real receipt for the outstanding balance
// through the same endpoint a manually-entered payment uses, and writes NO
// status at all — the derivation sets it, exactly as it does for every other
// receipt.
//
// THIS MODULE IS THE GUARD LAYER, and every refusal below is a refusal to
// record money that did not arrive. The amount reaches the general ledger:
// `postSiPayment` -> `customerPaymentLines` (backend `acc/rules.ts`) books
// Dr cash/bank/transit and Cr AR, and `acc/daily-close.ts` sums
// `sales_invoice_payments` into the day's cash-up. A receipt written here is
// cash the drawer is expected to hold.
//
// Where a choice could go either way, it records LESS. That is why
// `depositUnavailable` refuses rather than falling back to the figure on screen.

/** Every reason the button declines, and the sentence the operator is given. */
export type MarkPaidRefusal =
  | 'not_payable'
  | 'nothing_outstanding'
  | 'deposit_unknown';

export type MarkPaidPlan =
  | { ok: true; amountSen: number }
  | { ok: false; reason: MarkPaidRefusal };

export interface MarkPaidInput {
  /** Raw `sales_invoices.status`. */
  status: string | null | undefined;
  /**
   * What the invoice still owes, ALREADY NET of the slice of the source order's
   * deposit allocated to it — i.e. the page's `outstandingOf(header, items,
   * depositSen)`, the same figure the Outstanding hero prints.
   *
   * REQUIRED and not optional: its absence changes the amount of money that
   * gets booked, so a caller that forgot it must fail to compile rather than
   * silently book the gross total (CLAUDE.md, optional-param-noop).
   */
  outstandingSen: number;
  /**
   * `GET /sales-invoices/:id`'s `orderDepositUnavailable` — the server could not
   * read the source order, so the deposit slice fell back to 0 and the
   * outstanding figure on screen is TOO HIGH by however much the order already
   * collected.
   *
   * REQUIRED for the same reason: forgetting it is what books the customer's
   * deposit a second time.
   */
  depositUnavailable: boolean;
}

/* The statuses the payment endpoints themselves refuse with `not_payable`
   (POST /:id/payments and PATCH /:id/payment both 409 on these). Offering an
   action that can only 409 is offering a broken button, so the plan refuses
   first and the caller hides it. */
const NOT_PAYABLE = new Set(['CANCELLED', 'DRAFT']);

export function planMarkPaid(input: MarkPaidInput): MarkPaidPlan {
  const status = (input.status ?? '').trim().toUpperCase();
  if (NOT_PAYABLE.has(status)) return { ok: false, reason: 'not_payable' };

  /* An unreadable order deposit is NOT "the order collected nothing". The
     outstanding on screen is the full invoice less zero, so recording it would
     book the deposit the customer already handed over a SECOND time — which is
     precisely the double-count the read-through design exists to avoid (nothing
     copies order payments into `sales_invoice_payments`, because both ledgers
     post Dr cash / Cr AR). Refuse and let the operator refresh. */
  if (input.depositUnavailable) return { ok: false, reason: 'deposit_unknown' };

  const outstanding = Math.trunc(Number(input.outstandingSen));
  /* NaN falls through here too: `NaN > 0` is false, so an unreadable figure
     refuses rather than booking something. */
  if (!(outstanding > 0)) return { ok: false, reason: 'nothing_outstanding' };

  return { ok: true, amountSen: outstanding };
}

/** Should the button be rendered at all? True only when it can do its job. */
export const canOfferMarkPaid = (input: MarkPaidInput): boolean =>
  planMarkPaid(input).ok;

/* Plain sentences, because a refusal the operator cannot read is the same as no
   refusal (CLAUDE.md: a failure that reaches nobody is worse than a crash). */
export const MARK_PAID_REFUSAL_MESSAGE: Record<MarkPaidRefusal, string> = {
  not_payable:
    'This invoice cannot take a payment — a cancelled invoice is closed, and a draft has to be confirmed first.',
  /* Phrased as the FIGURE this screen read, not as a conclusion about the
     customer's account — the empty-state rule (owner 2026-08-17,
     backend/scripts/check-empty-state-claims.mjs). This screen knows its own
     outstanding; it does not know the customer owes us nothing. */
  nothing_outstanding:
    'The outstanding balance on this invoice reads zero, so there is no amount to record.',
  deposit_unknown:
    'We could not read what the source order already collected, so the outstanding amount shown may be too high. Refresh and try again rather than recording a payment that would count the deposit twice.',
};
