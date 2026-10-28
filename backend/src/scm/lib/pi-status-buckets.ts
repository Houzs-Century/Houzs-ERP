/* ----------------------------------------------------------------------------
   pi-status-buckets — which purchase_invoice_status values each list TAB covers.

   THE ONE SOURCE for both the status-count queries and the list `status`
   filter, so a tab and its number can never be computed from two different
   ideas of what the tab means. The frontend sends the BUCKET NAME; a raw
   status still works.

   Every bucket is 1:1 with a status here. ON_HOLD added 2026-08-21 (mig 0320)
   — the disputed bill that must not be paid while it is queried, and the only
   one of the three purchase holds that needed a written guard (see
   payment-vouchers.ts, allocation_on_hold).

   EVERY ENUM MEMBER IS IN A BUCKET AND EVERY BUCKET VALUE IS A MEMBER, pinned
   by backend/tests/statusBucketsEnumMembership.test.mjs. That pin was bought:
   COMPLETED sat in a delivery-order bucket while not being a member of its
   enum, and the tab 500'd with 22P02 while its own count silently read 0.

   Lives here rather than in the route because the route is over its file-size
   ceiling and this is a self-contained vocabulary the list, the counts and the
   membership test all read.
   ---------------------------------------------------------------------------- */

export const PI_STATUS_BUCKETS: Record<string, string[]> = {
  draft: ['DRAFT'],
  posted: ['POSTED'],
  partial: ['PARTIALLY_PAID'],
  paid: ['PAID'],
  cancelled: ['CANCELLED'],
  on_hold: ['ON_HOLD'],
};
