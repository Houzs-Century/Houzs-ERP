/* List money tiles (Revenue / Outstanding / Paid / Cost / Margin) leave
   cancelled documents out (gap review G16). A cancelled order keeps its
   local_total, so the All tab's Revenue used to include every cancelled sale and
   its Outstanding every cancelled balance. Only the Cancelled tab, where the
   operator asked for exactly those, still sums them.

   The predicate is an `or` so a document with no status at all (the SO list's
   Other tab) still counts: `status <> 'CANCELLED'` alone is NULL for those. */
export const NOT_CANCELLED_OR = 'status.is.null,status.neq.CANCELLED';

/** True when the money tiles must leave cancelled documents out. */
export function moneySkipsCancelled(statusFilter: string | null | undefined): boolean {
  return (statusFilter ?? '').trim().toUpperCase() !== 'CANCELLED';
}
