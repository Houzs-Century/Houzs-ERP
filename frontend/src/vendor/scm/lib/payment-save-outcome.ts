/**
 * What the operator is told, and whether the page may leave, after a Save that
 * also had to BOOK typed payment rows.
 *
 * WHY IT IS ITS OWN RULE. Until 2026-08-31 a typed payment row was booked only
 * by its own Save button; the page's Save saved the document and left the row
 * where it was. The one warning that exists is wired to the payments card's Done
 * and to the page's back button — not to Save — so the money row was dropped in
 * silence and the operator read it as "the payment did not save"
 * (owner, HC-SO-013393: no payment action had ever been recorded on it).
 *
 * The decision is small and entirely about consequences, which is exactly the
 * kind that must not live inline in a 4,000-line page: LEAVING the page discards
 * whatever was not booked, so anything short of "all of them landed" has to keep
 * the page open and say which rows and why.
 */
export type PaymentCommitTally = {
  /** rows this Save booked */
  committed: number;
  /** rows that were sent and refused */
  failed: number;
  /** rows that could not even be sent, each already phrased for a human */
  blocked: string[];
};

export type PaymentSaveOutcome = {
  /** true = do NOT navigate away; there is unbooked money on this screen. */
  stay: boolean;
  /** null when there is nothing to say. */
  message: string | null;
};

export function paymentSaveOutcome(tally: PaymentCommitTally): PaymentSaveOutcome {
  const { committed, failed, blocked } = tally;
  if (failed === 0 && blocked.length === 0) return { stay: false, message: null };

  const parts: string[] = [];
  if (committed > 0) {
    parts.push(`${committed} payment row${committed === 1 ? '' : 's'} saved`);
  }
  if (failed > 0) {
    parts.push(`${failed} could not be saved — try again`);
  }
  if (blocked.length > 0) {
    /* Named, not counted. "1 row is incomplete" sends the operator hunting; the
       row's own reason is what he can act on. */
    parts.push(`still incomplete: ${blocked.join('; ')}`);
  }
  return { stay: true, message: `The order was saved. ${parts.join('. ')}.` };
}
