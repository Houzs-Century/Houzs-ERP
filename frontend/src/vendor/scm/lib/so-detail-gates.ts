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
import { soBalanceOf } from '../../shared/so-balance';

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
  proceeded_at?: string | null;
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
   customer name + full delivery address + delivery date, and IS production's
   "ready to build" signal, so once it elapses the order
   is committed whether or not the explicit Proceed (IN_PRODUCTION) toggle was ever
   pressed. The prior rule ALSO required `proceeded_at` (only stamped at
   IN_PRODUCTION), which let a CONFIRMED SO past its processing date stay directly
   editable. DRAFT / CANCELLED stay editable; when status is absent we fall back to
   the `proceeded_at` marker so we never over-lock a status-blind header. Mirrors
   the backend soProcessingLocked exactly.

   Owner 2026-08-12 — the same soft lock now has a SECOND road: `po_locked`, set
   by the server when a live PO already claims one of this SO's lines (2990
   only). It short-circuits the date test entirely, including the DRAFT /
   CANCELLED exemptions below — a DRAFT SO cannot have a PO raised against it,
   and a CANCELLED one releases via cancelling the PO, not by editing the SO. So
   there is no state where po_locked is true and the date exemptions should win.
   Mirrors the backend pair soProcessingLocked || soPoLocked. */
export function procLockActive(header: SoDetailGateHeader): boolean {
  if (header.po_locked === true) return true;
  const orig = (header.processing_date ?? '').slice(0, 10);
  if (orig === '' || !(orig < todayMyt())) return false;
  const status = (header.status ?? '').toUpperCase();
  if (status) return status !== 'DRAFT' && status !== 'CANCELLED';
  return Boolean(header.proceeded_at);
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

/* deriveBalance — the order's SIGNED balance in centi. Prefers the
   server-stamped balance_centi (GET /mfg-sales-orders/:docNo computes it with
   the same rule); otherwise total (local_total ?? total_revenue) minus paid
   (paid_centi_total, falling back to the sum of the payments ledger).

   NEGATIVE when the customer has over-collected — owner 2026-08-16, and the
   floor that used to sit here is gone. It is `soBalanceOf` and not
   `Math.max(0, …)` because the condition under which a negative may be claimed
   at all (a KNOWN positive total) is a rule, shared byte-for-byte with the
   backend; re-deriving it here is how the two surfaces drift. */
export function deriveBalance(
  header: SoDetailGateHeader,
  payments?: ReadonlyArray<{ amount_centi?: number | null }>,
): number {
  if (header.balance_centi != null) return header.balance_centi;
  const total = header.local_total_centi ?? header.total_revenue_centi ?? 0;
  const paid = header.paid_centi_total
    ?? (payments ? payments.reduce((s, p) => s + (p.amount_centi ?? 0), 0) : 0);
  return soBalanceOf(total, paid);
}
