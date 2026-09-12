// ----------------------------------------------------------------------------
// pi-po-price — what the PURCHASE ORDER said this line would cost, beside what
// the supplier actually billed.
//
// Owner 2026-09-12: 「我的 Purchase Invoice 应该要有两个价钱：第一个价钱是从 PO
// 那边带过来的，第二个价钱可能是 Supplier 给我 fill-in 进去的 … 有差异的话，我们
// 基本上就要做 checking」.
//
// A purchase invoice line is created from a GRN line, which was received against
// a purchase-order line, so the ordered price is reachable by a join and does
// NOT need a column of its own:
//
//   purchase_invoice_items.grn_item_id
//     -> grn_items.purchase_order_item_id
//       -> purchase_order_items.unit_price_sen   <- what we ORDERED at
//
// Storing a copy on the PI line would have been the obvious move and is the
// wrong one: the PO is amendable, and a snapshot taken at conversion would keep
// showing the price the PO USED to carry after Purchasing renegotiated it. The
// join always answers "what does the purchase order say today", which is the
// number a person checking a supplier's bill actually wants.
//
// NOT EVERY LINE HAS ONE, and that is a real answer rather than a zero:
//   * a PI-native service line carries no grn_item_id;
//   * a GRN line received without a PO carries no purchase_order_item_id
//     (the walk-in / direct-purchase case);
//   * an UNBOUND SKU is ordered at 0 and keyed in at the invoice
//     (mfg-purchase-orders.ts supplierCostFor: "unbound — key in at PI").
// All three come back `null`, which the UI renders as "no PO price" rather than
// as a difference of the full amount.
// ----------------------------------------------------------------------------

/** The one comparison, so the API, the UI and any report agree on the word. */
export type PiLinePriceComparison = {
  /** Ordered price, or null when this line has no purchase-order line behind it. */
  poUnitPriceSen: number | null;
  /** What the supplier billed — the PI line's own unit price. */
  supplierUnitPriceSen: number;
  /** supplier - PO, per unit. null when there is nothing to compare against. */
  diffSen: number | null;
  /** True only when the two are BOTH known and differ. */
  differs: boolean;
};

export const comparePiLinePrice = (
  supplierUnitPriceSen: number,
  poUnitPriceSen: number | null,
): PiLinePriceComparison => {
  const supplier = Number.isFinite(supplierUnitPriceSen) ? supplierUnitPriceSen : 0;
  if (poUnitPriceSen == null) {
    return { poUnitPriceSen: null, supplierUnitPriceSen: supplier, diffSen: null, differs: false };
  }
  const diff = supplier - poUnitPriceSen;
  return {
    poUnitPriceSen,
    supplierUnitPriceSen: supplier,
    diffSen: diff,
    differs: diff !== 0,
  };
};

/**
 * Resolve the ordered price for a set of PI lines from the two hop tables.
 *
 * PURE on purpose: the route does the three reads and hands the rows in, so the
 * mapping — which is where a wrong join silently produces a plausible number —
 * is testable without a database.
 *
 * A grn_item that is missing from `grnItems` (deleted, or out of the caller's
 * scope) resolves to null, NOT to 0. "We cannot see the order" and "the order
 * said nothing" are the same answer here, and both are honest; what would be
 * dishonest is reporting the supplier's whole price as an overcharge.
 */
export const poUnitPriceByPiLine = (
  piLines: ReadonlyArray<{ id: string; grn_item_id?: string | null }>,
  grnItems: ReadonlyArray<{ id: string; purchase_order_item_id?: string | null }>,
  poItems: ReadonlyArray<{ id: string; unit_price_sen?: number | null }>,
): Map<string, number | null> => {
  const poiByGrnItem = new Map<string, string | null>();
  for (const g of grnItems) poiByGrnItem.set(g.id, g.purchase_order_item_id ?? null);
  const priceByPoi = new Map<string, number | null>();
  for (const p of poItems) {
    priceByPoi.set(p.id, typeof p.unit_price_sen === 'number' ? p.unit_price_sen : null);
  }
  const out = new Map<string, number | null>();
  for (const line of piLines) {
    const grnItemId = line.grn_item_id ?? null;
    if (!grnItemId) { out.set(line.id, null); continue; }
    const poiId = poiByGrnItem.get(grnItemId) ?? null;
    if (!poiId) { out.set(line.id, null); continue; }
    out.set(line.id, priceByPoi.get(poiId) ?? null);
  }
  return out;
};

/** The header line a person checking the bill reads first: how many lines
 *  differ, and by how much in total (qty x per-unit difference). */
export const piPriceDifferenceSummary = (
  lines: ReadonlyArray<{ qty?: number | null; supplierUnitPriceSen: number; poUnitPriceSen: number | null }>,
): { linesDiffering: number; totalDiffSen: number } => {
  let linesDiffering = 0;
  let totalDiffSen = 0;
  for (const l of lines) {
    if (l.poUnitPriceSen == null) continue;
    const diff = l.supplierUnitPriceSen - l.poUnitPriceSen;
    if (diff === 0) continue;
    linesDiffering += 1;
    totalDiffSen += diff * (Number(l.qty ?? 0) || 0);
  }
  return { linesDiffering, totalDiffSen };
};

/* ── The one read, done once ───────────────────────────────────────────────
   Both facts a PI line borrows from its GRN line — the supplier's own code and
   the price we ordered at — come off the same row, so they are fetched
   together: one `grn_items` read per DOCUMENT plus one `purchase_order_items`
   read, never one per line.

   It MUTATES `items` in place because that is what the detail route already
   does with every other enrichment, and a second shape would be a second thing
   to keep in step. A failed hop is logged by the caller and leaves both fields
   null — a purchase invoice must still open when an auxiliary read fails. */
export type PiLineEnrichable = Record<string, unknown> & { id: string; grn_item_id?: string | null };

/* The narrowest shape this needs. PromiseLike, not Promise: PostgREST's filter
   builder is thenable but is not a Promise, and typing it as one makes the real
   client fail to assign ("missing catch, finally"). Structural rather than
   importing SupabaseClient so the helper stays testable with a stub. */
type MinimalPgrest = {
  from: (t: string) => {
    select: (cols: string) => { in: (col: string, vals: string[]) => PromiseLike<{ data: unknown }> };
  };
};

export async function attachGrnLineFacts(sb: MinimalPgrest, items: PiLineEnrichable[]): Promise<void> {
  const grnItemIds = [...new Set(items.map((r) => r.grn_item_id).filter((v): v is string => !!v))];
  for (const it of items) { it.supplier_sku = null; it.po_unit_price_sen = null; }
  if (!grnItemIds.length) return;

  const { data: gis } = await sb.from('grn_items')
    .select('id, supplier_sku, purchase_order_item_id').in('id', grnItemIds);
  const grnRows = (gis ?? []) as Array<{
    id: string; supplier_sku: string | null; purchase_order_item_id: string | null;
  }>;

  const skuByGrnItem = new Map<string, string>();
  for (const g of grnRows) if (g.supplier_sku) skuByGrnItem.set(g.id, g.supplier_sku);

  const poiIds = [...new Set(grnRows.map((g) => g.purchase_order_item_id).filter((v): v is string => !!v))];
  const poItems: Array<{ id: string; unit_price_sen: number | null }> = [];
  if (poiIds.length) {
    const res = await sb.from('purchase_order_items').select('id, unit_price_sen').in('id', poiIds);
    poItems.push(...((res.data ?? []) as Array<{ id: string; unit_price_sen: number | null }>));
  }

  const poPriceByLine = poUnitPriceByPiLine(items, grnRows, poItems);
  for (const it of items) {
    it.supplier_sku = it.grn_item_id ? skuByGrnItem.get(it.grn_item_id) ?? null : null;
    it.po_unit_price_sen = poPriceByLine.get(it.id) ?? null;
  }
}
