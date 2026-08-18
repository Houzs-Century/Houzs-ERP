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
  balance_centi?: number | null;
  paid_centi_total?: number | null;
  local_total_centi?: number | null;
  total_revenue_centi?: number | null;
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
   (owner 2026-08-16). Prefers the server-stamped balance_centi, which GET
   /:docNo computes with soBalanceCenti and which is already signed; otherwise
   total (local_total ?? total_revenue) minus paid (paid_centi_total, falling
   back to the sum of the payments ledger).

   The floor is gone, but only where a total is KNOWN. A zero total means the
   header has not been recomputed (true of every AutoCount-imported order,
   where total_revenue_centi is 0), not that the customer owes nothing — so it
   still answers 0 rather than painting the whole legacy book red. Same rule,
   and the same reason, as soBalanceCenti on the server. */
export function deriveBalance(
  header: SoDetailGateHeader,
  payments?: ReadonlyArray<{ amount_centi?: number | null }>,
): number {
  if (header.balance_centi != null) return header.balance_centi;
  const total = header.local_total_centi ?? header.total_revenue_centi ?? 0;
  const paid = header.paid_centi_total
    ?? (payments ? payments.reduce((s, p) => s + (p.amount_centi ?? 0), 0) : 0);
  if (!(total > 0)) return 0;
  return total - paid;
}
