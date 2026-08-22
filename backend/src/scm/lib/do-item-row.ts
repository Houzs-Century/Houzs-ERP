/* ----------------------------------------------------------------------------
   do-item-row — one `delivery_order_items` insert row from a request line.

   Moved out of routes/delivery-orders-mfg.ts (which is over its size ceiling)
   when the outbound category fix landed — docs/bugs/0523. Two things it buys
   beyond the line count: the row shape can be asserted directly by a test
   without standing up the whole route, and the contract below has somewhere to
   live where it is read before the row is built rather than after.

   ── THE CONTRACT ON `it.itemGroup` ──
   It is expected to be ALREADY RESOLVED against the product master
   (`resolveItemGroups`, lib/sku-category.ts) by the route, before this is
   called. This function does not resolve it, deliberately: `item_group` is the
   input to the stock bucket, the same request's stock CHECK reads it too, and
   two independent resolutions can disagree. The route resolves once, onto the
   line objects every reader shares. See lib/sku-category.ts for why.
   -------------------------------------------------------------------------- */

import { buildVariantSummary } from '../shared';
import { dateOrNull } from './date-coerce';

/* `commitment` is NEVER read off the request body — it is passed in by the route
   from planShipCommitments, so a client cannot claim a binding the ledger has
   not earned (it decides which receipt gets to net this OUT). */
/* `lineNo` (0165) = the DO's listing position; omit/null for un-numbered. */
export function buildDoItemRow(
  deliveryOrderId: string,
  it: Record<string, unknown>,
  lineNo?: number | null,
  commitment?: { poNumber: string; strictBatch: boolean; variantKey: string } | null,
) {
  const qty = Number(it.qty ?? 1);
  const unitPrice = Number(it.unitPriceSen ?? 0);
  const discount = Number(it.discountSen ?? 0);
  const unitCost = Number(it.unitCostSen ?? 0);
  // Audit 2026-06-20 — clamp like the PO create path (negative-money guard).
  const lineTotal = Math.max(0, (qty * unitPrice) - discount);
  const lineCost = qty * unitCost;
  const itemGroup = (it.itemGroup as string) ?? null;
  const variants = (it.variants as unknown) ?? null;
  return {
    delivery_order_id: deliveryOrderId,
    so_item_id: (it.soItemId as string | undefined) ?? null,
    item_code: it.itemCode,
    item_group: itemGroup,
    description: (it.description as string) ?? null,
    description2: buildVariantSummary(String(itemGroup ?? ''), (variants as Record<string, unknown> | null) ?? null) || (it.description2 as string) || null,
    uom: (it.uom as string) ?? 'UNIT',
    qty,
    m3_milli: Number(it.m3Milli ?? 0),
    unit_price_sen: unitPrice,
    discount_sen: discount,
    line_total_sen: lineTotal,
    unit_cost_sen: unitCost,
    line_cost_sen: lineCost,
    line_margin_sen: lineTotal - lineCost,
    variants,
    /* Migration 0058 — carry the dedicated variant-breakdown columns from the
       client line payload (manual add already carries variants + line date). */
    gap_inches: (it.gapInches as number | null) ?? null,
    divan_height_inches: (it.divanHeightInches as number | null) ?? null,
    divan_price_sen: Number(it.divanPriceSen ?? 0),
    leg_height_inches: (it.legHeightInches as number | null) ?? null,
    leg_price_sen: Number(it.legPriceSen ?? 0),
    custom_specials: (it.customSpecials as unknown) ?? null,
    line_suffix: (it.lineSuffix as string | null) ?? null,
    special_order_price_sen: Number(it.specialOrderPriceSen ?? 0),
    notes: (it.notes as string) ?? null,
    line_delivery_date: dateOrNull(it.lineDeliveryDate),
    line_delivery_date_overridden: Boolean(it.lineDeliveryDateOverridden ?? false),
    /* REC P4 (mig 0118) — the SOURCE rack this line ships from. Null = let the
       dispatch chokepoint auto-pick the rack holding this product. */
    rack_id: (it.rackId as string | undefined) || null,
    /* Mig 0230 — the incoming PO batch this line is shipping AGAINST when it
       ships before the goods arrive, the bucket it was committed in, and whether
       that batch is a DYE LOT (sofa). The strict flag is what keeps the
       batch-agnostic oversell retro-cost off a sofa OUT — and, just as
       deliberately, keeps it available to a mattress OUT whose PO may yet be
       cancelled or re-raised. */
    committed_po_batch_no: commitment?.poNumber ?? null,
    committed_variant_key: commitment ? commitment.variantKey : null,
    committed_batch_strict: commitment?.strictBatch === true,
    ...(typeof lineNo === 'number' ? { line_no: lineNo } : {}),
  };
}
