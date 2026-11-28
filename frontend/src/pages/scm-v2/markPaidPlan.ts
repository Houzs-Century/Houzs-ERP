
/** Every reason the button declines, and the sentence the operator is given. */
export type MarkPaidRefusal =
  | 'not_payable'
  | 'nothing_outstanding'
  | 'deposit_unknown'
  | 'credit_unknown';

export type MarkPaidPlan =
  | { ok: true; amountSen: number }
  | { ok: false; reason: MarkPaidRefusal };

export interface MarkPaidInput {
  status: string | null | undefined;
  outstandingSen: number;
  depositUnavailable: boolean;
  creditNotesUnavailable: boolean;
}

const NOT_PAYABLE = new Set(['CANCELLED', 'DRAFT']);

export function planMarkPaid(input: MarkPaidInput): MarkPaidPlan {
  const status = (input.status ?? '').trim().toUpperCase();
  if (NOT_PAYABLE.has(status)) return { ok: false, reason: 'not_payable' };

  if (input.depositUnavailable) return { ok: false, reason: 'deposit_unknown' };
  /* The same for the credit notes knocked off it (owner 2026-11-03): an
     unread credit is not "no credit", and booking it as cash counts it twice. */
  if (input.creditNotesUnavailable) return { ok: false, reason: 'credit_unknown' };

  const outstanding = Math.trunc(Number(input.outstandingSen));
  if (!(outstanding > 0)) return { ok: false, reason: 'nothing_outstanding' };

  return { ok: true, amountSen: outstanding };
}

/** Should the button be rendered at all? True only when it can do its job. */
export const canOfferMarkPaid = (input: MarkPaidInput): boolean =>
  planMarkPaid(input).ok;

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
  credit_unknown:
    'We could not read the credit notes knocked off this invoice, so the outstanding amount shown may be too high. Refresh and try again rather than recording a payment for what a credit note settles.',
};
