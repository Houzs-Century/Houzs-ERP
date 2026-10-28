/* ----------------------------------------------------------------------------
   grn-status-buckets — which grn_status values each list TAB covers.

   THE ONE SOURCE for both the status-count queries and the list `status`
   filter, so a tab and its number can never be computed from two different
   ideas of what the tab means. The frontend sends the BUCKET NAME; a raw
   status still works.

   CLOSED shares the `posted` bucket rather than having a pill of its own: a
   CLOSED GRN's stock IN stands, where a CANCELLED one's was reversed, so it
   belongs with posted and not beside it. If that is ever separated, it is one
   entry here plus one tab.

   ON_HOLD added 2026-08-21 (mig 0319) — a paperwork pause that moves no stock.

   EVERY ENUM MEMBER IS IN A BUCKET AND EVERY BUCKET VALUE IS A MEMBER, pinned
   by backend/tests/statusBucketsEnumMembership.test.mjs. That pin was bought:
   COMPLETED sat in a delivery-order bucket while not being a member of its
   enum, and the tab 500'd with 22P02 while its own count silently read 0.

   Lives here rather than in the route because the route is over its file-size
   ceiling and this is a self-contained vocabulary the list, the counts and the
   membership test all read.
   ---------------------------------------------------------------------------- */

export const GRN_STATUS_BUCKETS: Record<string, string[]> = {
  draft: ['DRAFT'],
  posted: ['POSTED', 'CLOSED'],
  cancelled: ['CANCELLED'],
  on_hold: ['ON_HOLD'],
};
