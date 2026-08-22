/* ----------------------------------------------------------------------------
   so-tab-statuses — which sales-order statuses each list TAB covers.

   SHIPPED FOLDS INTO DELIVERED (owner, 2026-08-22): 「Sales Order 的 Shipped 跟
   Delivered 是合起来的」. On the Sales Order the two say the same thing to the
   person reading the list — the goods went out — and the difference between
   "left the building" and "arrived" is what the DELIVERY ORDER is for. Splitting
   it here bought nothing and cost a tab: production carried SHIPPED · 0 against
   DELIVERED · 26 the day of the ruling.

   IT FOLDS PERMANENTLY, and that is why this file exists rather than a line
   deleted from SO_STATUSES. Postgres cannot DROP VALUE, so `SHIPPED` stays a
   legal label in scm.mfg_so_status for ever and a row can still arrive carrying
   it — from the AutoCount mirror, from an older client, from a row written
   before today. Removing it from the vocabulary WITHOUT giving it a bucket sends
   every such row into the list's `other` catch-all: reachable from no tab, and
   subtracted from the count the operator is reading. That is precisely the fault
   `status-counts.ts` was written after — 37 delivery orders invisible while the
   numbers looked settled.

   IT IS DELIBERATELY *NOT* NAMED `*_STATUS_BUCKETS`, and the difference is real
   rather than cosmetic. The four maps that carry that name — DO, PO, GRN, PI —
   are EXHAUSTIVE PARTITIONS of their enum, pinned by
   backend/tests/statusBucketsEnumMembership.test.mjs: every member in exactly
   one bucket, because those four lists have no catch-all and a member with no
   bucket is reachable from no tab at all.

   The Sales Order list is the one that DOES have a catch-all. Its handler
   computes `other = allCount - known` and MfgSalesOrdersListV2 renders an
   "Other" tab whenever that count is non-zero, so a status outside this map is
   still reachable. That is why CLOSED and RETURNED — both legal labels in
   scm.mfg_so_status, both retired from the vocabulary — need no entry here, and
   why registering this map as a partition would force two tabs the owner did
   not ask for.

   SHIPPED is folded anyway rather than left to `other`, and the reason is the
   READER, not reachability: an order whose goods went out belongs under
   Delivered, not under a tab called Other.

   THE KEYS ARE THE WIRE VALUES. `useMfgSalesOrdersPaged` sends
   `status.toUpperCase()`, so the tab `delivered` arrives as `DELIVERED`. A tab
   whose bucket holds one status still reads through here, so there is one place
   that answers "what does this tab select" and no second spelling of it.
   ---------------------------------------------------------------------------- */

export const SO_TAB_STATUSES: Record<string, string[]> = {
  DRAFT:         ['DRAFT'],
  CONFIRMED:     ['CONFIRMED'],
  IN_PRODUCTION: ['IN_PRODUCTION'],
  READY_TO_SHIP: ['READY_TO_SHIP'],
  DELIVERED:     ['SHIPPED', 'DELIVERED'],
  INVOICED:      ['INVOICED'],
  ON_HOLD:       ['ON_HOLD'],
  CANCELLED:     ['CANCELLED'],
};

/** The statuses a tab selects. An unknown tab value selects itself, so a caller
 *  the buckets have never heard of still filters to something real rather than
 *  silently widening to every row. */
export function soStatusesForTab(tab: string): string[] {
  return SO_TAB_STATUSES[tab] ?? [tab];
}
