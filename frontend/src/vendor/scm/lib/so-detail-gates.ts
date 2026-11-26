
import { todayMyt } from './dates';
/* The per-line downstream freeze (owner 2026-09-15). isLocked's `hasChildren`
   argument is now `soDownstreamHardLocked(header)` — the whole order locks only
   when nothing is left to convert; a partly delivered order freezes line by line
   (`soItemFrozen(item)`). */
export { soDownstreamHardLocked, soItemFrozen } from '../../shared/so-line-freeze';

export const LOCKED_STATUSES: readonly string[] = [
  'SHIPPED', 'DELIVERED', 'INVOICED', 'CLOSED', 'CANCELLED',
];

export const CANCELLABLE_STATUSES: readonly string[] = [
  'CONFIRMED', 'IN_PRODUCTION', 'READY_TO_SHIP',
];

export type SoDetailGateHeader = {
  status?: string | null;
  has_children?: boolean | null;
  /* Server-computed (owner 2026-09-15): a live DO/SI carries EVERY live line, so
     nothing is left to convert. Absent = a pre-deploy payload; read through
     soDownstreamHardLocked, which falls back to has_children. */
  downstream_fully_frozen?: boolean | null;
  processing_date?: string | null;
  /* Server-computed: a live (non-cancelled) Purchase Order already claims one of
     this SO's lines — 2990 only (owner 2026-08-12). NOT derivable client-side —
     the detail payload carries no PO linkage — which is exactly why it arrives
     as a fact instead of a fourth local re-derivation of "is this order
     committed". Absent (Houzs, or a cached pre-deploy payload) reads as false,
     so the gate degrades to the date rule alone. */
  po_locked?: boolean | null;
  amendment_eligible?: boolean | null;
  migrated_readonly?: boolean | null;
  migrated_readonly_reason?: string | null;
  balance_sen?: number | null;
  paid_sen_total?: number | null;
  local_total_sen?: number | null;
  total_revenue_sen?: number | null;
};

const upper = (s: string | null | undefined): string => (s ?? '').toUpperCase();

export function isLocked(
  status: string | null | undefined,
  downstreamLocked: boolean,
  unlockOverride = false,
): boolean {
  return (LOCKED_STATUSES.includes(upper(status)) && !unlockOverride) || downstreamLocked;
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
   by the server when a live PO already claims one of this SO's lines (every
   company since 2026-11-09). It short-circuits the date test entirely, including the DRAFT /
   CANCELLED exemptions below — a DRAFT SO cannot have a PO raised against it,
   and a CANCELLED one releases via cancelling the PO, not by editing the SO. So
   there is no state where po_locked is true and the date exemptions should win.
   Mirrors the backend pair soProcessingLocked || soPoLocked. */
export function procLockActive(
  header: SoDetailGateHeader & { status: string | null },
): boolean {
  if (header.po_locked === true) return true;
  const orig = (header.processing_date ?? '').slice(0, 10);
  if (orig === '' || !(orig < todayMyt())) return false;
  const status = (header.status ?? '').toUpperCase();
  if (!status) return false;
  return status !== 'DRAFT' && status !== 'CANCELLED';
}

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
