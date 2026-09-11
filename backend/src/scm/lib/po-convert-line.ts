/* ----------------------------------------------------------------------------
   po-convert-line — the ROW a converted SO line becomes, written once.

   `convertSosToPosCore` has two arms — APPEND to an existing PO (`targetPoId`)
   and CREATE one per supplier bucket — and both wrote the same sixteen fields
   in two hand-kept copies that differed only in which PO id they carried. Every
   field added since (`description2`, `so_item_id`, `photo_urls`, `from_mrp`)
   had to be added twice, and the comments explaining WHY a field is carried had
   drifted: the append copy had one line about photos, the create copy had
   eight. They are one function now, and the reasons live here.

   Extracted 2026-09-10 while adding `line_no` — `mfg-purchase-orders.ts` is
   over its size ceiling, and the repo's rule for that is a new module rather
   than a bigger number.
   -------------------------------------------------------------------------- */

import { buildVariantSummary } from '../shared';

/** One picked SO line, as `convertSosToPosCore` carries it through grouping. */
export interface PoConvertLine {
  itemCode: string;
  itemName: string;
  qty: number;
  supplierSku: string;
  unitPriceSen: number;
  warehouseId: string | null;
  deliveryDate: string | null;
  itemGroup: string | null;
  variants: Record<string, unknown> | null;
  soItemId: string | null;
  photoUrls: string[];
}

/**
 * The `scm.purchase_order_items` row for one converted line.
 *
 * `fromMrp` is REQUIRED, not defaulted: it decides whether the line locks its
 * source SO line's quota (`recomputeSoPicked` excludes MRP-origin lines), and a
 * decision-carrying parameter is required here so a new caller cannot silently
 * inherit one arm's answer (CLAUDE.md, BUG CLASS optional-param-noop).
 *
 * `line_no` is NOT set here — `stampPoLineNos` numbers the payload after the
 * caller has put it in the sales orders' order (`lib/po-line-order.ts`).
 */
export function poConvertLineRow(
  purchaseOrderId: string,
  l: PoConvertLine,
  fromMrp: boolean,
  resolvedItemGroup: string | null,
): Record<string, unknown> {
  return {
    purchase_order_id: purchaseOrderId,
    material_kind: 'mfg_product',
    item_code: l.itemCode,
    material_name: l.itemName,
    supplier_sku: l.supplierSku,
    qty: l.qty,
    unit_price_sen: l.unitPriceSen,
    line_total_sen: l.qty * l.unitPriceSen,
    /* Commander 2026-05-28 — per-line delivery date = the source SO LINE's
       date; per-line warehouse = the SO's sales_location warehouse. Both may be
       null when the SO didn't carry them — that's allowed. */
    delivery_date: l.deliveryDate,
    warehouse_id: l.warehouseId,
    /* Commander 2026-05-29 — carry the variant through to the PO so the line
       shows its config + the MRP can match outstanding PO supply by variant. */
    /* THE SKU DECIDES THE CATEGORY, and this arm used to be the exception.
       `create` and `add-item` both run `lineIdentityFields(skuCategoryResolver…)`
       (docs/bugs/0514); convert copied `l.itemGroup` from whatever reached the
       route, so the same sofa could land as `others` here and as `sofa` there.
       That is not cosmetic: `item_group` composes the variant key AND decides
       `isHardBoundLine`, so a company-1 sofa PO line written as `others` is not
       "dedicated" — the MRP page reports its sales-order line as SHORT while the
       purchase order sits open, and the buyer is told to order goods that are
       already on order (HC-PO-010087 / HC-SO-013389, owner-reported 2026-09-11).

       REQUIRED, not defaulted, for the same reason `fromMrp` is: a decision that
       changes the stored row must fail to COMPILE when a new caller forgets it,
       never fall back to one arm's answer (CLAUDE.md, BUG CLASS
       optional-param-noop). Pass `groupOf(line)` from `skuCategoryResolver` — it
       already falls back to the line's own group when the SKU is not catalogued. */
    item_group: resolvedItemGroup,
    variants: l.variants,
    description2: buildVariantSummary(String(resolvedItemGroup ?? ''), l.variants ?? null) || null,
    // Release-on-delete link (migration 0098) — every from-SO line carries its
    // source SO line so recomputeSoPicked can release it on delete/cancel.
    so_item_id: l.soItemId,
    /* Owner 2026-08-10 (migration 0274) — the source SO line's photo keys. The
       array is copied, the R2 objects are not: SO line and PO line point at the
       same objects, so a photo deleted on the SO also leaves the PO. PER LINE,
       never deduplicated across the bucket — one sofa build is many compartment
       lines that legitimately share the same build photo, and each PO line must
       carry it or that compartment shows no photo at all. Lines stay 1:1 with
       their SO line, so this is simply each line's own array. */
    photo_urls: l.photoUrls,
    // Commander 2026-05-31 — MRP-origin lines are reference-only (no SO lock).
    from_mrp: fromMrp,
  };
}
