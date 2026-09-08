// ----------------------------------------------------------------------------
// so-detail-gates — PURE status / date / amount gate logic for the Sales-Order
// DETAIL flow. NO React, no query client, no I/O. The desktop SalesOrderDetail
// page and the MobileSODetail screen both consume these so a gating fix lands
// ONCE instead of drifting between two hand-rolled copies.
//
// Everything here is derived from the header the /mfg-sales-orders/:docNo GET
// returns (+ the payments ledger for the balance). Status comparisons are
// case-insensitive (the column stores UPPERCASE; some call sites already
// upper-cased, some did not).
// ----------------------------------------------------------------------------

import { todayMyt } from './dates';

/* Terminal / downstream-carrying statuses — once the SO reaches one of these
   its header + line items are no longer ours to edit (SHIPPED onward once goods
   leave, plus CANCELLED). Mirrors the desktop `lockedStatuses`. */
export const LOCKED_STATUSES: readonly string[] = [
  'SHIPPED', 'DELIVERED', 'INVOICED', 'CLOSED', 'CANCELLED',
];

/* In-flight statuses a Cancel is still offered on — never once SHIPPED+ /
   INVOICED / CLOSED (those carry downstream docs). Mirrors the desktop
   `cancellableStatuses`. */
export const CANCELLABLE_STATUSES: readonly string[] = [
  'CONFIRMED', 'IN_PRODUCTION', 'READY_TO_SHIP',
];

/* Minimal structural header the gates read — every field optional/nullable so
   both the desktop and mobile SoHeader types satisfy it without coupling. */
export type SoDetailGateHeader = {
  status?: string | null;
  has_children?: boolean | null;
  processing_date?: string | null;
  /* Server-computed: a live (non-cancelled) Purchase Order already claims one of
     this SO's lines — 2990 only (owner 2026-08-12). NOT derivable client-side —
     the detail payload carries no PO linkage — which is exactly why it arrives
     as a fact instead of a fourth local re-derivation of "is this order
     committed". Absent (Houzs, or a cached pre-deploy payload) reads as false,
     so the gate degrades to the date rule alone. */
  po_locked?: boolean | null;
  amendment_eligible?: boolean | null;
  /* Server-computed: this order was carried across from AutoCount at the 2026-08
     cutover AND the migrated-order lock is currently on for this company
     (backend/src/scm/lib/migrated-so-lock.ts). It arrives as ALREADY-DECIDED
     rather than as the raw `linked_ac_docno`, because the answer depends on an
     app_config switch and on the caller's bypass — neither of which the browser
     can see. The endpoint that refuses the write computes it with the SAME
     function, so the button and the API cannot disagree.
     Absent (a cached pre-deploy payload) reads as false, which is the pre-2026-09
     behaviour exactly. */
  migrated_readonly?: boolean | null;
  /* The sentence to show the operator. Server-authored so it can be changed by
     an operator through scm.app_config.description without a deploy. */
  migrated_readonly_reason?: string | null;
  balance_sen?: number | null;
  paid_sen_total?: number | null;
  local_total_sen?: number | null;
  total_revenue_sen?: number | null;
};

const upper = (s: string | null | undefined): string => (s ?? '').toUpperCase();

/* isLocked — the SO header/lines are frozen when the status is terminal
   (SHIPPED+/CANCELLED, unless an explicit unlock override is active) OR a
   non-cancelled DO/SI references this SO (hasChildren; never overridable — the
   child must be cancelled first). Mirrors the desktop `isLocked`. */
export function isLocked(
  status: string | null | undefined,
  hasChildren: boolean,
  unlockOverride = false,
): boolean {
  return (LOCKED_STATUSES.includes(upper(status)) && !unlockOverride) || hasChildren;
}

/* migratedReadonly — this order came across from AutoCount and the cutover lock
   is still on, so NOTHING about it may be edited (owner 2026-09-08,
   「只开新单，旧单暂时不能改」).

   DELIBERATELY NOT FOLDED INTO isLocked(), and this is the whole point of it
   being a separate predicate: isLocked takes `unlockOverride`, and the desktop
   editor offers an Override button that sets it (SalesOrderDetail.tsx). A
   salesperson may override a status lock — that is a judgement about our own
   paperwork. They may not override this one: the reason a migrated order is shut
   is that AutoCount payments have not reached us and sync-ac-delta can still
   overwrite the row, and no amount of local certainty changes either fact.

   Two arms so the reason is never lost: `migratedReadonly` for the gate, and
   `migratedReadonlyReason` for the sentence beside it. A gate with no sentence
   is how this repo produced "the button does nothing". */
export function migratedReadonly(header: SoDetailGateHeader | null | undefined): boolean {
  return header?.migrated_readonly === true;
}

/* The sentence to render next to a disabled control. Never empty when
   migratedReadonly() is true — the server always sends one, and this is the
   fallback for a payload that somehow arrives without it. */
export const MIGRATED_READONLY_FALLBACK =
  'This order came from AutoCount and is view-only for now. New orders save normally.';

export function migratedReadonlyReason(header: SoDetailGateHeader | null | undefined): string {
  const v = String(header?.migrated_readonly_reason ?? '').trim();
  return v.length > 0 ? v : MIGRATED_READONLY_FALLBACK;
}

/* procLockActive — the SO PROCESS lock: once a CONFIRMED-or-later SO's processing
   day has passed we have PO'd to the supplier, so the LINE ITEMS + the customer
   State/Postcode freeze (direct edits must go through the amendment flow instead).
   Uses todayMyt() (Malaysia calendar day) — NOT the browser-local date — so the
   lock flips at MYT midnight regardless of the device timezone.

   Owner 2026-07-16 — the lock now fires on the processing date passing for any
   non-DRAFT / non-CANCELLED SO. A Processing Date can only be SET on an order that
   meets its company's deposit rule (Houzs 30%, 2990 50% — owner 2026-07-31) plus
   customer name + full delivery address + delivery date, and IS the signal that
   RELEASES the order to purchasing (owner 2026-08-18), so once it elapses the order
   is committed whether or not the explicit Proceed (IN_PRODUCTION) toggle was ever
   pressed. The prior rule ALSO required `proceeded_at` (only stamped at
   IN_PRODUCTION), which let a CONFIRMED SO past its processing date stay directly
   editable. DRAFT / CANCELLED stay editable. Mirrors the backend
   soProcessingLocked exactly.

   THE STATUS-BLIND FALLBACK IS GONE (owner 2026-08-18 — one Processing Date
   across frontend, backend and database). This function used to end
   `return Boolean(header.proceeded_at)`, reached only when `status` was absent,
   and the reason given was "so we never over-lock a status-blind header": with
   no status we cannot tell a DRAFT from a CONFIRMED, and over-locking a DRAFT
   blocks an edit the operator is entitled to make, with no way round it.

   That protection is PRESERVED, not dropped, and by a stronger mechanism than a
   second column: `status` is now REQUIRED on SoDetailGateHeader, so a caller
   that has not got one cannot reach here at all — it fails to compile instead of
   silently consulting a different fact. The runtime empty-string case answers
   "not locked", which is the same side the old marker was chosen to protect.
   Nothing rendered changes: the detail payload has always carried `status`
   (HEADER in backend/src/scm/routes/mfg-sales-orders.ts includes it), so the
   deleted line was unreachable in production, not a second opinion.

   Owner 2026-08-12 — the same soft lock now has a SECOND road: `po_locked`, set
   by the server when a live PO already claims one of this SO's lines (2990
   only). It short-circuits the date test entirely, including the DRAFT /
   CANCELLED exemptions below — a DRAFT SO cannot have a PO raised against it,
   and a CANCELLED one releases via cancelling the PO, not by editing the SO. So
   there is no state where po_locked is true and the date exemptions should win.
   Mirrors the backend pair soProcessingLocked || soPoLocked. */
export function procLockActive(
  /* `status` is REQUIRED here and optional on SoDetailGateHeader, which the
     money helpers below also take. Narrowing it at the one gate that DECIDES on
     it is what makes "a caller without a status cannot ask this question" a
     compile error rather than a comment. */
  header: SoDetailGateHeader & { status: string | null },
): boolean {
  if (header.po_locked === true) return true;
  const orig = (header.processing_date ?? '').slice(0, 10);
  if (orig === '' || !(orig < todayMyt())) return false;
  const status = (header.status ?? '').toUpperCase();
  if (!status) return false;
  return status !== 'DRAFT' && status !== 'CANCELLED';
}

/* amendmentEligible — the SO is processing-locked (already PO'd) but still
   editable via the amendment flow, so a line change must go out as an amendment
   request rather than a direct edit. Only meaningful while the SO is NOT
   hard-locked (terminal status / downstream child) — a SHIPPED/terminal SO is
   never amendment-eligible. Mirrors the desktop
   `Boolean(header.amendment_eligible) && !isLocked`. */
export function amendmentEligible(header: SoDetailGateHeader, locked: boolean): boolean {
  return Boolean(header.amendment_eligible) && !locked;
}

/* deriveBalance — balance in centi, SIGNED: negative means over-collected
   (owner 2026-08-16). Prefers the server-stamped balance_sen, which GET
   /:docNo computes with soBalanceSen and which is already signed; otherwise
   total (local_total, else total_revenue) minus paid (paid_sen_total, falling
   back to the sum of the payments ledger).

   A SERVER ZERO DOES NOT WIN OVER A TOTAL WE CAN SUBTRACT FROM. `balance_sen`
   is non-null on every response, so `!= null` handed 0 straight through — and
   0 is exactly what the server used to answer for an AutoCount-imported order
   (total_revenue_sen is 0 on those). This function's own fallback was correct
   the whole time and was never reached, so the mobile SO detail printed Total
   3,200, Paid 1,600, Balance 0.00. The server half is fixed too; this half is
   what stops a stale or cached payload doing it again. Trace:
   `docs/bugs/0723-the-sales-order-detail-showed-a-paid-up-balance-of-0-on-ever.md`

   The floor is gone, but only where a total is KNOWN. NO total in either
   column means the header has not been recomputed, not that the customer owes
   nothing — so it still answers 0 rather than painting an order red for money
   nobody over-collected. Same rule, and the same reason, as soBalanceSen on
   the server. */
export function deriveBalance(
  header: SoDetailGateHeader,
  payments?: ReadonlyArray<{ amount_sen?: number | null }>,
): number {
  const total = (header.local_total_sen ?? 0) || (header.total_revenue_sen ?? 0);
  const computable = total > 0;
  if (header.balance_sen != null && !(header.balance_sen === 0 && computable)) {
    return header.balance_sen;
  }
  if (!computable) return 0;
  const paid = header.paid_sen_total
    ?? (payments ? payments.reduce((s, p) => s + (p.amount_sen ?? 0), 0) : 0);
  return total - paid;
}
