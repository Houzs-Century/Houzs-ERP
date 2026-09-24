/* ----------------------------------------------------------------------------
   cancel-pending-count — how many SO cancellation requests are waiting for a
   given signer, for the "Sales Order Amendment" sidebar badge.

   THE OWNER, 2026-09-24: 「当有 SO request cancel bill - 需要在 SO amendment 出现」.
   A request to cancel a Sales Order is an approval waiting on the same desks the
   amendment queue already serves, so it now shows in that queue — and the badge
   over it has to carry it too, or the number under-counts what is on the desk.

   WHO IT COUNTS FOR is not re-decided here: `approvalRefusal` (shared/
   document-cancel.ts) is the same rule the approve route runs, so the badge and
   the approve button can never disagree about whose signature a row is waiting
   for — nobody signs their own request, and level 2 is never the level-1 signer.

   The caller passes `holds`. The badge passes holdsHouzsPermLiterally (a `*`
   wildcard must not put every desk's backlog on the Owner's menu — the same
   rule the lane half of pending-count already applies).
   ---------------------------------------------------------------------------- */

import { approvalRefusal, OPEN_CANCEL_STATUSES, type CancelRequestLike, type Signer } from '../shared/document-cancel';

/** Rows this signer is the pending approver of. Pure — the list is the caller's. */
export function countCancelRequestsAwaitingSigner(rows: CancelRequestLike[], signer: Signer): number {
  return rows.filter((r) => 'level' in approvalRefusal(r, signer)).length;
}

/** The statuses worth reading for the count — an open request only. */
export const CANCEL_PENDING_STATUSES = OPEN_CANCEL_STATUSES;

