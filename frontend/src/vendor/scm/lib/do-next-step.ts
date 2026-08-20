import { SI_TRANSFERABLE_DO_STATES } from '../../shared/do-shipped-states';
// ----------------------------------------------------------------------------
// do-next-step — what a Delivery Order may do next, and why it may not yet, in
// ONE place, as words an operator can act on.
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
// AND THE REASON LIVES HERE, ONCE. That is the other half, and it is the half
// that decides whether this fix is still true in two months. The date-format
// rule was fixed the same way in June — a DateField component that forces one
// format — and it reached 14 of 189 inputs, because each surface kept
// re-deriving the answer by hand and nothing errored when it drifted. Four
// surfaces ask "what may this DO do next?" (desktop detail header, that same
// page's phone action bar, the list quick-view drawer, and the native mobile
// shell), and before this module they answered it four times.
//
// WHAT IS SHARED, AND WHAT DELIBERATELY IS NOT — stated precisely, because a
// header that overstates its own reach is how the next reader comes to trust a
// thing that is not true:
//
//   · The SALES-INVOICE question (siTransferBlockReason) is shared by all four.
//     That is the one the owner hit, and the one that was silently missing.
//   · The ADVANCE question (doAdvanceStep) is shared by the three desktop-side
//     surfaces. The native mobile shell keeps its own finer ladder ON PURPOSE:
//     it offers DISPATCHED → IN_TRANSIT ("Mark In Transit"), a rung the desktop
//     skips, and IN_TRANSIT is the departure marker MobileDeliveryPlanning
//     writes for "On the way" (MobileDeliveryPlanning.tsx:1280). Collapsing the
//     phone onto the desktop's single jump would have DELETED a step drivers
//     use. So on DISPATCHED the desktop still says "Mark signed" and the phone
//     still says "Mark In Transit" — that difference is now a recorded decision
//     with a reason, rather than two hand-written copies that had drifted.
//
// ── THE VOCABULARY (measured, not assumed) ──────────────────────────────────
// The eight legal delivery_orders.status values are declared once, server-side,
// in backend/src/scm/shared/do-shipped-states.ts (DO_STATUSES):
//
//   DRAFT, LOADED, DISPATCHED, IN_TRANSIT, SIGNED, DELIVERED, INVOICED, CANCELLED
//
// They are exactly the labels of the scm.do_status enum. That file also records
// what happens when a status is asserted rather than measured: COMPLETED lived
// in these lists for months on the strength of a comment, and Postgres 500'd on
// it in both tenants because the enum never had it. So a status this module does
// not recognise gets the GENERIC sentence, never a guess — naming a step that
// does not exist is worse than saying the state is unexpected.
//
// ── WHAT THE BACKEND ACTUALLY ENFORCES ──────────────────────────────────────
// From routes/delivery-orders-mfg.ts, PATCH /:id/status:
//   · A DO is born DISPATCHED, or DRAFT when created with `asDraft` (:3518).
//   · CANCELLED IS FINAL. prevStatus === 'CANCELLED' is refused outright with
//     `do_cancelled_final` (:5401) — un-cancelling would leave the cancel's
//     add-back standing while the re-deduct no-ops, inflating stock by the whole
//     DO. There is no reopen, and any control offering one cannot succeed.
//   · A shipped DO may not fall back to a pre-ship status (:5418).
//   · Otherwise forward and lateral moves are all accepted — the ladder is NOT
//     walked one rung at a time, which is why "Mark signed" can jump straight to
//     DELIVERED from LOADED.
//
// ── SCOPE ───────────────────────────────────────────────────────────────────
// This answers "why not yet", never "may this user do it". Permission is a
// separate question and stays with the caller, which still HIDES the control
// outright (auth/salesAccess.ts:200 — "off, not hide"): advertising an action a
// salesperson may never take is noise and leaks org structure.
// ----------------------------------------------------------------------------

/* THE OWNER'S RULE, FROM ITS ONE HOME — NOT A HAND-TYPED LIST. `['signed',
   'delivered']` stood here until 2026-08-18 and was the narrowest of three live
   spellings of "this delivery may be invoiced". Two things fixed it, a day
   apart, and BOTH are kept:

     · WHERE the rule lives (2026-08-18). SI_TRANSFERABLE_DO_STATES in
       shared/do-shipped-states.ts is the single declaration; the backend
       ENFORCES it in routes/sales-invoices.ts, the server's own DO picker and
       the phone's convert wizard read the same constant, and the frontend twin
       is held byte-identical by check-shared-mirrors.mjs --strict. This module
       derives from it instead of restating it.
     · WHAT the rule says (2026-08-19, #2485). Every CONFIRMED delivery order —
       anything past DRAFT that is not CANCELLED — may be invoiced, LOADED
       included. That superseded the previous day's four-state list, and it is
       what the server has always permitted: the SI-from-DO create refuses only
       a CANCELLED source. "Mark signed" survives as an OPTIONAL delivery-
       tracking action (doAdvanceStep), never a prerequisite.

   It read as a status bug and is a MULTI-ORGANISATION one. The predicate carries
   no company term and never did; it fired on one organisation because of DATA.
   2990's source system has no "delivered" step, so its imported deliveries sit
   at DISPATCHED, while the HOUZS AutoCount carry-overs were inserted as literal
   'DELIVERED'. One build, one permission set — and 2990 was told the transfer
   did not exist. */
export const SI_TRANSFERABLE_DO_STATUSES =
  SI_TRANSFERABLE_DO_STATES.map((s) => s.toLowerCase()) as readonly string[];

/** Normalise a raw status off a row into the lower-case token used here. */
function norm(status: string | null | undefined): string {
  return String(status ?? '').trim().toLowerCase();
}

/**
 * Where to raise the Sales Invoice on the NATIVE MOBILE SHELL, which does not
 * host the convert wizard on the delivery-order screen.
 *
 * The capability is genuinely reachable there — MobileApp's MODULE_TO_CONVERT
 * maps the Sales Invoices module to the "si" convert target, whose source is a
 * delivery order (MobileConvertWizard META.si), and the "+" appears for anyone
 * `canOperateSalesInvoices` allows. So this is a DISCOVERABILITY gap, not a
 * missing feature, and the honest sentence names the route rather than
 * pretending the phone cannot do it.
 *
 * It is a separate string from {@link siTransferBlockReason} because it answers
 * a different question: that one says why the transfer is not YET possible,
 * this one says where to perform a transfer that IS possible.
 */
export const SI_TRANSFER_MOBILE_ROUTE_HINT =
  'The next step is the Sales Invoice — raise it from the Sales Invoices screen with "+".';

/**
 * `null` when the transfer is available. Otherwise the sentence to show on the
 * disabled control — what is blocking it, and what to do about it.
 */
export function siTransferBlockReason(status: string | null | undefined): string | null {
  const s = norm(status);
  if ((SI_TRANSFERABLE_DO_STATUSES as readonly string[]).includes(s)) return null;
  if (s === 'cancelled') {
    return 'This delivery order was cancelled, so it cannot be invoiced. Raise a new delivery order to deliver these goods again.';
  }
  if (s === 'draft') {
    return 'This delivery order is still a draft — confirm it before raising a Sales Invoice.';
  }
  /* INVOICED deliberately falls through to the generic sentence rather than
     getting an "already invoiced" one. routes/unbilled-deliveries.ts:13 records
     the measurement: NOTHING in the codebase ever writes
     delivery_orders.status='INVOICED' — creating a Sales Invoice from a DO does
     not advance the DO — so the label means "somebody clicked it", not "this was
     billed", and it is unreliable in both directions. Saying "already invoiced"
     here would state as fact the exact thing that file proves the flag cannot
     tell us. The generic sentence states the gate, which is true. An unrecognised
     status also lands here rather than a guess (COMPLETED once did — see header). */
  return 'A Sales Invoice can only be raised from a confirmed delivery order.';
}

/**
 * The one status step this document is ready for, as the control that performs
 * it: the target status to PATCH and the words on the button.
 *
 * `null` when no step applies — pair it with {@link doAdvanceBlockReason}, which
 * says why. The two are deliberately separate functions because a caller that
 * renders the control disabled needs BOTH the label (so the slot keeps its verb)
 * and the reason.
 *
 * The labels and targets are the ones already shipped on the surfaces this
 * replaces, so no operator's muscle memory changes:
 *   · DRAFT → DISPATCHED, "Confirm"     (mobile MobileModuleDetail's ladder)
 *   · LOADED / DISPATCHED / IN_TRANSIT → DELIVERED, "Mark signed"
 *     (desktop DeliveryOrderDetailV2 + the list drawer)
 *
 * NOTE, recorded rather than silently changed: the "Mark signed" control writes
 * DELIVERED, not SIGNED — DeliveryOrderDetailV2.tsx:777 and
 * MfgDeliveryOrdersListV2.tsx:968 both mutate `status: "DELIVERED"`. Both
 * targets satisfy the Sales-Invoice gate, so the operator's outcome is correct
 * and this change does not touch it. The label/target mismatch is a separate
 * defect and is logged as one.
 */
export type DoAdvanceStep = {
  /** Target delivery_orders.status to PATCH. */
  status: 'DISPATCHED' | 'DELIVERED';
  /** The words on the button. */
  label: string;
};

export function doAdvanceStep(status: string | null | undefined): DoAdvanceStep | null {
  const s = norm(status);
  if (s === 'draft') return { status: 'DISPATCHED', label: 'Confirm' };
  if (s === 'loaded' || s === 'dispatched' || s === 'in_transit') {
    return { status: 'DELIVERED', label: 'Mark signed' };
  }
  return null;
}

/**
 * The sentence to show an operator who is about to close a delivery that
 * carries NO proof of delivery — `null` when there is nothing to say.
 *
 * WHY A SENTENCE AND NOT A REFUSAL. Three measured reasons, all pointing the
 * same way:
 *
 *   · The office legitimately closes deliveries it did not attend. 2990's
 *     imported deliveries have no POD at all, and the HOUZS AutoCount
 *     carry-overs were inserted as literal 'DELIVERED'. A hard gate would make
 *     a whole tenant's backlog unclosable.
 *   · The SERVER already decided this. `patchDeliveryOrderStatusHandler` DROPS
 *     an out-of-range GPS fix rather than 409-ing it, in as many words: "a bad
 *     sensor reading must never be the reason a driver cannot close a
 *     delivery". A client stricter than its own server is a bug.
 *   · The owner's standing rule for this system is to loosen rather than
 *     restrict, and to prefer a default or a prompt over a wall.
 *
 * What was actually wrong was never the permissiveness — it was the SILENCE.
 * The same delivery closed from a different screen either had a signature or
 * had nothing, and no screen said which you were about to do. That is the same
 * rule this module already applies to the Sales-Invoice transfer: the thing may
 * be unavailable, but it may not be silent.
 *
 * Scope: only the step that CLOSES the delivery is warned about. A
 * DRAFT→DISPATCHED confirm is not a delivery and must not nag.
 */
export function doCloseWithoutEvidenceWarning(
  step: DoAdvanceStep | null,
  pod: { signature_data?: string | null; pod_r2_key?: string | null } | null | undefined,
): string | null {
  if (step?.status !== 'DELIVERED') return null;
  if (pod?.signature_data || pod?.pod_r2_key) return null;
  return 'This delivery order has no customer signature and no delivery photo. Marking it delivered records it as complete with no proof of delivery — the driver captures that on the Proof of Delivery screen in the mobile app.';
}

/**
 * `null` when {@link doAdvanceStep} has a step to offer. Otherwise the sentence
 * for the disabled control.
 */
export function doAdvanceBlockReason(status: string | null | undefined): string | null {
  if (doAdvanceStep(status)) return null;
  const s = norm(status);
  if (s === 'cancelled') {
    /* The backend's own words, from the `do_cancelled_final` refusal at
       delivery-orders-mfg.ts:5403. This is why no surface should offer a
       "Reopen" here: the write is refused every time. */
    return 'A cancelled delivery order cannot be reactivated — its stock was already returned. Raise a new delivery order to deliver again.';
  }
  if (s === 'signed' || s === 'delivered') {
    return 'This delivery order is complete. The next step is to raise its Sales Invoice.';
  }
  if (s === 'invoiced') {
    return 'This delivery order is marked invoiced, so there is no further delivery step.';
  }
  return 'This delivery order is in an unexpected state, so no next step can be offered. Please check with the office.';
}
