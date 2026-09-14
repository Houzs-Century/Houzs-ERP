// ----------------------------------------------------------------------------
// line-po-ref — which PURCHASE ORDER a goods-receipt or purchase-invoice LINE
// came from.
//
// Owner-confirmed request #26 (2026-09-14): "GRN & PI need PO related show for
// every item — easier to cross check, also during PI if price not tally."
//
// Why per LINE and not the header's `purchase_order_id`: one receipt can take
// lines from several of a supplier's orders (`/grns/from-pos` buckets by
// supplier), and one invoice can bill several receipts. The header ref is the
// PRIMARY order only, so for any single line it is a guess. The line's own link
// is not:
//
//   grn_items.purchase_order_item_id -> purchase_order_items.purchase_order_id
//   purchase_invoice_items.grn_item_id -> grn_items.purchase_order_item_id -> ...
//
// A line with no link — a manual receipt line, a PI-native service line, a
// grn line out of the caller's scope — gets NO ref. Nothing here falls back to
// the header, because a wrong PO number beside a line is worse than none.
// ----------------------------------------------------------------------------

export type LinePoRef = { poId: string; poNumber: string };

type PoEmbed = { po_number?: string | null } | Array<{ po_number?: string | null }> | null | undefined;

/** One PO-line read (`id, purchase_order_id, po:purchase_orders(po_number)`)
 *  -> ref per PO line. A half-known order (no id to open, or no number to
 *  show) is left out rather than rendered as half a link. */
export const poRefByPoItemId = (
  poItems: ReadonlyArray<{ id: string; purchase_order_id?: string | null; po?: PoEmbed }>,
): Map<string, LinePoRef> => {
  const out = new Map<string, LinePoRef>();
  for (const r of poItems) {
    const po = Array.isArray(r.po) ? r.po[0] : r.po;
    const poNumber = po?.po_number ?? null;
    if (r.purchase_order_id && poNumber) out.set(r.id, { poId: r.purchase_order_id, poNumber });
  }
  return out;
};

/** GRN detail: stamp `source_po_id` + `source_po_number` on every line (null on
 *  a line with no PO behind it), in place — the route's existing enrichment
 *  shape — plus `po_unit_price_sen`, the price the order names today, which the
 *  create-invoice-from-receipt screen starts a new invoice line at
 *  (owner 2026-09-14). The price is independent of the ref: an order whose
 *  number cannot be read still has a price. */
export const stampGrnLinePoRefs = (
  lines: Array<Record<string, unknown> & { purchase_order_item_id: string | null }>,
  refs: ReadonlyMap<string, LinePoRef>,
  priceByPoItemId: ReadonlyMap<string, number | null>,
): void => {
  for (const l of lines) {
    const poiId = l.purchase_order_item_id;
    const ref = poiId ? refs.get(poiId) ?? null : null;
    l.source_po_id = ref?.poId ?? null;
    l.source_po_number = ref?.poNumber ?? null;
    l.po_unit_price_sen = poiId ? priceByPoItemId.get(poiId) ?? null : null;
  }
};

/** PO line rows -> unit price per PO line; a non-number reads as null, never 0. */
export const poPriceByPoItemId = (
  poItems: ReadonlyArray<{ id: string; unit_price_sen?: number | null }>,
): Map<string, number | null> =>
  new Map(poItems.map((r) => [r.id, typeof r.unit_price_sen === 'number' ? r.unit_price_sen : null]));

/** PI detail: the extra hop through the receipt line. Every PI line gets an
 *  entry, so a caller never reads undefined. */
export const poRefByPiLine = (
  piLines: ReadonlyArray<{ id: string; grn_item_id?: string | null }>,
  grnItems: ReadonlyArray<{ id: string; purchase_order_item_id?: string | null }>,
  refs: ReadonlyMap<string, LinePoRef>,
): Map<string, LinePoRef | null> => {
  const poiByGrnItem = new Map<string, string | null>();
  for (const g of grnItems) poiByGrnItem.set(g.id, g.purchase_order_item_id ?? null);
  const out = new Map<string, LinePoRef | null>();
  for (const line of piLines) {
    const poiId = line.grn_item_id ? poiByGrnItem.get(line.grn_item_id) ?? null : null;
    out.set(line.id, poiId ? refs.get(poiId) ?? null : null);
  }
  return out;
};
