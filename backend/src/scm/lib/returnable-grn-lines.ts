/* ----------------------------------------------------------------------------
   returnable-grn-lines — which received lines a PO-sourced Purchase Return may
   draw from.

   THE DEFECT (owner 2026-09-28, HC-PO-010114): the purchase order read RECEIVED
   with a full receipt bar, and the return screen offered nothing to return —
   「系统找不到 GRN - 但是现实已经received stock」. Both units HAD been received,
   on `HC-GRN-2609-098` and `HC-GRN-2609-155`, but those receipts are HEADED at
   a different purchase order, so the old read — `grns.purchase_order_id = poId`
   — matched no receipt at all.

   This is the same header-FK-only blind spot #4199 fixed for the PO list and
   the relationship map; the return's pool was never taught it. A receipt links
   to a purchase order TWICE and the two links disagree by design:

     · `grns.purchase_order_id`            — the receipt's own header
     · `grn_items.purchase_order_item_id`  — what each LINE was received against

   The owner confirmed 2026-09-28 that one receipt carrying several suppliers'
   purchase orders is DELIBERATE (Hookka and Ohana are one group and arrive on
   one lorry), so the line link is the truth here, not the header.

   THE POOL IS KEYED ON THE LINE. Lines received against THIS purchase order, on
   a POSTED receipt, with `qty_accepted - returned_qty > 0`. That fixes the
   missing rows AND closes the mirror leak: a receipt headed at this PO but
   carrying another PO's lines used to offer those other lines here.

   THE HEADER LINK SURVIVES for one case only — a line on this PO's own receipt
   that carries NO line link (pre-link imports, a receipt raised without picking
   PO lines). Dropping it would hide receipts the old read did show, which is a
   regression wearing a fix's clothes.
   ---------------------------------------------------------------------------- */

/** A receipt line as the two reads below deliver it. */
export type GrnLineRow = {
  id: string;
  grn_id: string;
  purchase_order_item_id: string | null;
  material_kind: string | null;
  item_code: string;
  material_name: string | null;
  item_group: string | null;
  variants: Record<string, unknown> | null;
  qty_accepted: number | null;
  returned_qty: number | null;
  unit_price_sen: number | null;
  rejection_reason: string | null;
};

export type ReturnableLine = {
  grnItemId: string;
  grnNumber: string | null;
  materialKind: string | null;
  itemCode: string;
  materialName: string | null;
  itemGroup: string | null;
  variants: Record<string, unknown> | null;
  unitPriceSen: number;
  rejectionReason: string | null;
  remaining: number;
};

/**
 * The pure half: given the receipt lines that reference this PO (by either
 * link) and the POSTED receipts they sit on, produce the returnable pool.
 *
 * `poItemIds` is the set of THIS purchase order's line ids. A row qualifies
 * when it names one of them, or — the legacy case — when it names none and its
 * receipt is headed at this purchase order (`headerGrnIds`).
 *
 * Deduplicated by receipt-line id: the two reads overlap by construction.
 */
export function buildReturnablePool(
  rows: readonly GrnLineRow[],
  postedGrnNumberById: ReadonlyMap<string, string>,
  poItemIds: ReadonlySet<string>,
  headerGrnIds: ReadonlySet<string>,
): ReturnableLine[] {
  const seen = new Set<string>();
  const out: ReturnableLine[] = [];
  for (const r of rows) {
    if (seen.has(r.id)) continue;
    // Only POSTED receipts: a draft receipt's stock has not moved in yet.
    const grnNumber = postedGrnNumberById.get(r.grn_id);
    if (grnNumber === undefined) continue;
    const byLine = r.purchase_order_item_id != null && poItemIds.has(r.purchase_order_item_id);
    const byHeaderLegacy = r.purchase_order_item_id == null && headerGrnIds.has(r.grn_id);
    if (!byLine && !byHeaderLegacy) continue;
    const remaining = Math.max(0, (r.qty_accepted ?? 0) - (r.returned_qty ?? 0));
    if (remaining <= 0) continue;
    seen.add(r.id);
    out.push({
      grnItemId: r.id,
      grnNumber,
      materialKind: r.material_kind,
      itemCode: r.item_code,
      materialName: r.material_name,
      itemGroup: r.item_group,
      variants: r.variants,
      unitPriceSen: r.unit_price_sen ?? 0,
      rejectionReason: r.rejection_reason,
      remaining,
    });
  }
  return out;
}
