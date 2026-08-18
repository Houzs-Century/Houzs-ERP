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
// WHAT THE FIRST VERSION OF THIS FILE GOT WRONG, kept here because the mistake
// is more instructive than the fix. It read the gate off the screen — "signed
// or delivered" — and wrote a confident sentence around it: "sign this delivery
// order first". The gate itself was the bug. `canConvertToSi` was a HAND-TYPED
// two-status literal in two desktop files, while the rest of the system has
// exactly one declaration of "this delivery has moved stock", the five-state
// DO_SHIPPED_STATES in shared/do-shipped-states.ts. The server's own picker
// (GET /sales-invoices/invoiceable-do-lines) and the mobile convert wizard both
// use the wide predicate; only the two desktop buttons did not. So the door was
// open on the server and painted shut on the screen — and turning "absent" into
// "disabled with a reason" would have shipped a confidently WRONG instruction.
//
// WHY IT LOOKED LIKE A COMPANY DIFFERENCE. 2990's source system never had a
// "delivered" step, so its imported delivery orders sit at DISPATCHED; HOUZS's
// are AutoCount carry-overs written with the literal 'DELIVERED' (25 of 27).
// Measured on production 2026-08-18: eight of 2990's delivery orders are
// DISPATCHED, belong to sales orders 2990's own system calls delivered, and
// have no sales invoice at all. Goods gone, nothing billed, no button. The
// predicate was company-neutral; the DATA SHAPE was not.
//
// The owner's ruling is on record and says the opposite of the narrow gate —
// backfill-2990-delivered-dos.mjs:7 quotes him: "我们开了 DO 就是 consider 出货
// delivered 了". DISPATCHED is where the inventory OUT is written.
//
// THE LADDER: DRAFT → LOADED → DISPATCHED → IN_TRANSIT → SIGNED → DELIVERED →
// INVOICED, with CANCELLED terminal. Billable = the stock has left, i.e.
// DO_SHIPPED_STATES. LOADED is deliberately NOT billable: it is a pre-ship
// state and no OUT movement exists yet.
//
// SCOPE. This answers "why not yet", not "may this user do it" — permission is a
// separate question and stays with the caller. A status this module does not
// recognise returns the generic sentence rather than a guess: naming a step that
// does not exist would be worse than saying the state is unexpected.
// ----------------------------------------------------------------------------

import { DO_SHIPPED_STATES } from '../../shared/do-shipped-states';

/** Statuses a Sales Invoice can be raised from: the stock has left the building.
 *  Derived from the ONE declaration, never re-typed — re-typing it is the whole
 *  defect this module documents. */
export const SI_TRANSFERABLE_DO_STATUSES =
  DO_SHIPPED_STATES.map((s) => s.toLowerCase()) as readonly string[];

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
    return 'This delivery order is still a draft — dispatch it before raising a Sales Invoice.';
  }
  if (s === 'loaded') {
    return 'These goods have not left yet — dispatch this delivery order, then raise the Sales Invoice.';
  }
  return 'A Sales Invoice can only be raised once this delivery order has been dispatched.';
}
