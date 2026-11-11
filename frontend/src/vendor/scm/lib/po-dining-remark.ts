/* po-dining-remark (frontend) — which PO line shows its own Remark in the PO
   quick-view / detail, and what text.

   Owner 2026-11-10 ("2990 - for dining remark 需要带进 PO remark - 给 Supplier
   mention"): a DINING line's own remark must be visible on the PO, beside the
   line, so the supplier-facing note reads without opening the full page.

   The SO->PO convert already stores that remark in `purchase_order_items.notes`
   for DINING lines only (backend po-dining-remark.ts / `diningLineNote`); the
   detail endpoint hands every line its `notes` and `item_group` as-is. But
   `notes` is populated on NON-dining lines too — a sofa / bedframe / mattress
   line carries its own note — so the panel must gate on the group, or every
   such note would surface here. This mirrors the backend's `isDiningGroup` so
   the on-screen remark and the printed "Remark:" agree on which lines qualify
   (the same FE/BE mirror the date formatters keep). */

/** DINING is the only catalogue group whose line shows its remark on the PO.
    Byte-mirrored with the backend's isDiningGroup (po-dining-remark.ts) so the
    shared-mirrors audit keeps them in lockstep — the on-screen remark and the
    printed "Remark:" must agree on which lines qualify. */
export const isDiningGroup = (g: string | null | undefined): boolean =>
  (g ?? '').trim().toLowerCase() === 'dining';

/** The remark to show against a PO line: the line's `notes`, DINING lines only,
 *  trimmed. Null for every non-dining line and for a dining line with no note. */
export const diningLineRemark = (
  itemGroup: string | null | undefined,
  notes: string | null | undefined,
): string | null => (isDiningGroup(itemGroup) ? (notes ?? '').trim() || null : null);
