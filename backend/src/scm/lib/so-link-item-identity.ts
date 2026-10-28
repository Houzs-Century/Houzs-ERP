/* Does a PO line and the sales-order line it names describe the SAME PRODUCT?
 *
 * WHY THIS EXISTS AS A MODULE. `purchase_order_items.so_item_id` is bound at
 * five places in mfg-purchase-orders.ts. Four of them — the add-line, the
 * patch-line and both allocation paths — go through `soLinkTargetRefusal`,
 * which reads the SO line back one at a time and refuses a cross-product bind
 * with 409 `so_link_material_mismatch`. The fifth, `POST /` (bare create), does
 * a BATCH read of the source lines for company scope and the qty cap, and its
 * own comment claimed it "mirrors soLinkTargetRefusal" — it mirrored the
 * company half only. So a New-PO form line for product B could be linked to an
 * SO line for product A on the one path that had no item check.
 *
 * That is not cosmetic. A bedframe or sofa line is HARD-BOUND
 * (`isHardBoundLine`, lib/so-stock-allocation.ts): it reads READY only through
 * its OWN dedicated purchase order's received_qty, never through the pooled
 * balance. A wrong bind therefore tells the floor a customer's bed is ready
 * when a different bed arrives, and the real line can never light. On
 * 2026-09-07 the importer did exactly this to nine live sales-order lines
 * (docs/bugs/0671); this is the same damage through the front door.
 *
 * Bug class: docs/bugs/0672-bug-class-key-without-identity — a link written on
 * the strength of a KEY with no assertion that the two sides are the same
 * thing. It is worth stating why the batch path is where the rule went missing:
 * the per-line guard re-reads the row it is about to link, so the identity is
 * in front of the author; the batch path already HAD the rows and simply did
 * not look at the column.
 *
 * This module is deliberately pure and synchronous — the caller has already
 * taken the company-scoped read, so the check costs no extra round trip. The
 * refusal shape is soLinkTargetRefusal's, so the two paths answer the client
 * identically.
 */

/** The columns POST / reads for its source sales-order lines. */
export type SoSourceLine = {
  id: string;
  doc_no: string | null;
  item_code: string | null;
  qty: number;
  po_qty_picked: number;
};

/** Trim, upper-case, collapse inner whitespace — the way a person reads a code.
 *  Same normalisation as `soLinkTargetRefusal` and `normItemCode` in
 *  scripts/lib/ac-po-line.mjs. Anything looser hides a real mismatch; anything
 *  stricter reports formatting as a wrong product. */
const norm = (v: unknown) => String(v ?? '').trim().toUpperCase().replace(/\s+/g, ' ');

export type SoLinkMismatch = {
  error: 'so_link_material_mismatch';
  reason: string;
  soItemCode: string | null;
  itemCode: string | null;
  soItemId: string;
};

/**
 * The FIRST line whose `soItemId` names a sales-order line for a different
 * product, or null when every linked line agrees with its source.
 *
 * A line with no `soItemId` is a manual purchase and is not this function's
 * business. A `soItemId` that resolves to nothing is not this function's
 * business either — the caller's company-scope check refuses that with 404
 * `so_line_not_found` before this runs; if one reaches here anyway it is
 * refused, because an unresolvable source cannot be asserted equal to anything.
 */
export function soLinkItemMismatch(
  items: Array<Record<string, unknown>>,
  soRows: SoSourceLine[],
): SoLinkMismatch | null {
  const byId = new Map(soRows.map((r) => [r.id, r]));
  for (const it of items) {
    const soItemId = it.soItemId as string | undefined;
    if (!soItemId) continue;
    const soRow = byId.get(soItemId);
    const soCode = norm(soRow?.item_code);
    const poCode = norm(it.itemCode);
    if (soCode && soCode === poCode) continue;
    return {
      error: 'so_link_material_mismatch',
      reason: `This line orders ${String(it.itemCode ?? '')}, but the picked Sales Order line is for ${soRow?.item_code ?? '(no item)'}. Pick the matching line, or leave the source blank.`,
      soItemCode: soRow?.item_code ?? null,
      itemCode: (it.itemCode as string | undefined) ?? null,
      soItemId,
    };
  }
  return null;
}
