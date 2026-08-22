/* ----------------------------------------------------------------------------
   so-status-buckets — which sales-order statuses each list TAB covers.

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

   THE KEYS ARE THE WIRE VALUES. `useMfgSalesOrdersPaged` sends
   `status.toUpperCase()`, so the tab `delivered` arrives as `DELIVERED`. A tab
   whose bucket holds one status still reads through here, so there is one place
   that answers "what does this tab select" and no second spelling of it.
   ---------------------------------------------------------------------------- */

export const SO_STATUS_BUCKETS: Record<string, string[]> = {
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
  return SO_STATUS_BUCKETS[tab] ?? [tab];
}
