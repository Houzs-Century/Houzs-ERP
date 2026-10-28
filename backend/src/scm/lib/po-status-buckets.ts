/* ----------------------------------------------------------------------------
   po-status-buckets — which po_status values each list TAB covers.

   THE ONE SOURCE for both the status-count queries and the list `status`
   filter, so a tab and its number can never be computed from two different
   ideas of what the tab means. The frontend sends the BUCKET NAME; a raw
   status still works.

   `outstanding` is the one ROLL-UP: raised but not received in full, which is
   SUBMITTED + PARTIALLY_RECEIVED. It OVERLAPS the two buckets it is built from
   BY DESIGN (owner 2026-07-31), so the pill counts deliberately do not sum to
   `all`. That is the single most confusing thing on this page and it is on
   purpose — see docs/modules/document-status-vocabulary.md on why Outstanding
   is a filter and not a status.

   ON_HOLD added 2026-08-21 (mig 0318). It is NOT in `outstanding`: a held order
   is not waiting for goods, it is stopped.

   EVERY ENUM MEMBER IS IN A BUCKET AND EVERY BUCKET VALUE IS A MEMBER, pinned
   by backend/tests/statusBucketsEnumMembership.test.mjs. That pin was bought:
   COMPLETED sat in a delivery-order bucket while not being a member of its
   enum, and the tab 500'd with 22P02 while its own count silently read 0.

   Lives here rather than in the route because the route is over its file-size
   ceiling and this is a self-contained vocabulary the list, the counts and the
   membership test all read.
   ---------------------------------------------------------------------------- */

export const PO_STATUS_BUCKETS: Record<string, string[]> = {
  draft: ['DRAFT'],
  outstanding: ['SUBMITTED', 'PARTIALLY_RECEIVED'],
  open: ['SUBMITTED'],
  partial: ['PARTIALLY_RECEIVED'],
  received: ['RECEIVED'],
  cancelled: ['CANCELLED'],
  on_hold: ['ON_HOLD'],
};
