// ----------------------------------------------------------------------------
// do-next-step — why a Delivery Order cannot yet become a Sales Invoice, in ONE
// place, as words an operator can act on.
//
// WHY THIS EXISTS. Owner, 2026-08-18, holding two delivery orders side by side —
// one from each company — and seeing two different green buttons in the same
// corner of the same screen:
//
//   "一个公司显示 Transfer to Sales Invoice，另一个公司却是 Mark signed，
//    这不是同一个系统会统一的东西来的吗？我又不是两套系统"
//
// He was right, and the code was too. The two documents differed only in STATUS
// — DELIVERED versus DISPATCHED — and the status ladder is identical for both
// companies. But the transfer was not shown as UNAVAILABLE; it was simply not
// rendered. From the second company's seat the product did not have the feature.
// A capability that disappears without a word is indistinguishable from a
// capability that does not exist, which is how one system comes to look like two.
//
// So the rule is the same one this codebase has been applying all week to empty
// states and refusals: the thing may be unavailable, but it may not be silent.
// The control stays on screen, disabled, carrying the reason and the next step.
//
// THE LADDER, from routes/delivery-orders-mfg.ts:
//   DRAFT → DISPATCHED → SIGNED → DELIVERED, with CANCELLED terminal.
// A Sales Invoice may be raised from SIGNED or DELIVERED only.
//
// SCOPE. This answers "why not yet", not "may this user do it" — permission is a
// separate question and stays with the caller. A status this module does not
// recognise returns the generic sentence rather than a guess: naming a step that
// does not exist would be worse than saying the state is unexpected.
// ----------------------------------------------------------------------------

/** Statuses a Sales Invoice can be raised from. */
export const SI_TRANSFERABLE_DO_STATUSES = ['signed', 'delivered'] as const;

/**
 * `null` when the transfer is available. Otherwise the sentence to show on the
 * disabled control — what is blocking it, and what to do about it.
 */
export function siTransferBlockReason(status: string | null | undefined): string | null {
  const s = String(status ?? '').trim().toLowerCase();
  if ((SI_TRANSFERABLE_DO_STATUSES as readonly string[]).includes(s)) return null;
  if (s === 'cancelled') {
    return 'This delivery order was cancelled, so it cannot be invoiced.';
  }
  if (s === 'draft') {
    return 'This delivery order is still a draft — dispatch it, then sign it, before raising a Sales Invoice.';
  }
  if (s === 'loaded' || s === 'dispatched' || s === 'in_transit') {
    return 'Sign this delivery order first — a Sales Invoice can only be raised once it is signed or delivered.';
  }
  return 'A Sales Invoice can only be raised from a signed or delivered delivery order.';
}
