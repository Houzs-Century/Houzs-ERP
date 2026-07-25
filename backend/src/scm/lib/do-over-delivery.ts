/* The over-delivery invariant, extracted pure so the money-path guard is unit
   testable without booting the route.

   A Delivery Order must never ship a Sales Order line for MORE than it ordered.
   The create path already caps this (delivery-orders-mfg.ts, "Audit gap #3"),
   but a DRAFT DO SKIPS that cap and can land its full qty; the only place a
   draft's stock actually leaves is the DRAFT->shipped confirm, so the same cap
   must be re-checked THERE before the flip. This is that check, isolated.

   `linkedQty`  = this DO's about-to-ship qty per so_item_id (the caller drops
                  ad-hoc / unlinked lines — they are intentionally uncapped).
   `remaining`  = soRemainingByItemId: qty - delivered + returned, computed with
                  this still-unshipped DO EXCLUDED (a DRAFT never counts toward
                  delivered), so it is exactly "what the SO line still has open".

   A line is over-delivered when its about-to-ship qty exceeds that open figure.
   A missing id in `remaining` means the SO line no longer has anything open
   (treated as 0) — shipping any qty against it over-delivers. */
export function findOverDeliveredSoItems(
  linkedQty: Map<string, number>,
  remaining: Map<string, number>,
): string[] {
  return [...linkedQty.entries()]
    .filter(([soItemId, qty]) => qty > (remaining.get(soItemId) ?? 0))
    .map(([soItemId]) => soItemId);
}
