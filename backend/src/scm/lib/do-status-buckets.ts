/* ----------------------------------------------------------------------------
   do-status-buckets — which delivery-order statuses each list TAB covers.

   ONE TAB PER STATUS (owner, 2026-08-21) — 页签＝状态. Four buckets over eight
   statuses could not tell a DRAFT from a LOADED delivery, which is what he
   asked about. SIGNED has no tab of its own: it is merged into DELIVERED by his
   ruling, and it folds here PERMANENTLY because Postgres cannot drop an enum
   label — a row carrying it must always land somewhere.

   EVERY ENUM MEMBER IS IN EXACTLY ONE BUCKET AND EVERY BUCKET VALUE IS A MEMBER,
   pinned by backend/tests/statusBucketsEnumMembership.test.mjs. That pin is not
   decoration: COMPLETED sat in `delivered` while not being a member at all, and
   the tab 500'd with 22P02 while its count silently read 0.

   Lives here rather than in the route because the route is over its size
   ceiling and this is a self-contained vocabulary the list, the counts and the
   tests all read. Full rationale: docs/modules/delivery-order.md.
   ---------------------------------------------------------------------------- */

export const DO_STATUS_BUCKETS: Record<string, string[]> = {
  draft: ['DRAFT'],
  loaded: ['LOADED'],
  dispatched: ['DISPATCHED'],
  in_transit: ['IN_TRANSIT'],
  delivered: ['SIGNED', 'DELIVERED'],
  invoiced: ['INVOICED'],
  cancelled: ['CANCELLED'],
};
