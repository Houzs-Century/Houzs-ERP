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

import { itemCodeKey } from './do-unlinked-so-lines';

/* The blind spot findOverDeliveredSoItems above CANNOT see, and why it needs a
   second guard rather than a fix to the first.

   findOverDeliveredSoItems keys everything by so_item_id. A DO line with NO
   so_item_id therefore contributes nothing to `linkedQty`, so it is invisible
   to that check — yet it still ships stock (deductInventoryForDo reads the DO's
   OWN lines, link or no link). That is exactly how 2990-DO-2607-005 shipped the
   same six items 2990-DO-2607-017 shipped: DO-005's lines all carried
   so_item_id = null, so the over-delivery guard never counted them against
   2990-SO-2606-019, and the order's own goods went out a second time.

   The create + add-line paths now refuse an unlinked line whose item_code the
   named SO already orders (do-unlinked-so-lines.ts, 2026-08-04). The DRAFT->
   shipped CONFIRM path — the single point where a draft's stock actually leaves
   — does NOT run that refusal; its only shipping guard is findOverDeliveredSoItems,
   which is blind here. This closes that remaining hole at the same chokepoint,
   in quantity terms rather than a binary refusal, so a legitimate partial /
   multi-DO split still ships.

   `unlinkedByItemCode` = this DO's about-to-ship qty per item_code, summed over
                          ONLY the lines with no so_item_id.
   `openByItemCode`     = the named SO's still-open qty per ORDERED item_code
                          (qty - delivered + returned, aggregated across the SO's
                          lines of that code, this DO EXCLUDED). An item_code
                          PRESENT with 0 means the SO ordered it and it is fully
                          delivered — an unlinked line of it is a duplicate. An
                          item_code ABSENT means the SO never ordered it — a
                          genuinely ad-hoc line (replacement part, sample), never
                          flagged, exactly as the linked path leaves ad-hoc lines
                          uncapped.

   Comparison is on item_code alone, matching do-unlinked-so-lines' deliberate
   choice: a variant or whitespace difference must not let the same product slip
   through as "a different item". */
export function findOverDeliveredUnlinkedItems(
  unlinkedByItemCode: Map<string, number>,
  openByItemCode: Map<string, number>,
): string[] {
  const open = new Map<string, number>();
  for (const [code, qty] of openByItemCode) open.set(itemCodeKey(code), qty);

  const over: string[] = [];
  for (const [rawCode, qty] of unlinkedByItemCode) {
    const code = itemCodeKey(rawCode);
    if (!code || !open.has(code)) continue; // SO never ordered it -> ad-hoc, allowed
    if (qty > (open.get(code) as number)) over.push(rawCode);
  }
  return over;
}
