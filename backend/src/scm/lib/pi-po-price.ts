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
// All three mean "the order never named a price", and NONE of them is an
// overcharge.
//
// THE ZERO IS NOT A PRICE — MEASURED, NOT ASSUMED. The first version of this
// module treated an ordered 0 as a real price, so a line billed RM 2,138 against
// an unpriced order read as "+RM 2,138, supplier billed more". Measured on 25
// live purchase invoices (115 lines, staging copy of production, 2026-09-12):
//
//   78 lines (68%)  ordered price 0  -> the order was never priced
//   35 lines (30%)  ordered == billed
//    2 lines (1.7%) genuinely differ  -> HC-PI-008026: TRION (A)-(K) ordered
//                                        800.00 billed 830.00; JAGER-(Q)
//                                        ordered 200.00 billed 225.00
//
// Painting the 78 red buries the 2 that a person actually has to check, which is
// the whole point of the feature. So 0 is reported as UNPRICED and never as a
// difference; the two real ones stand alone.
// ----------------------------------------------------------------------------

import { poRefByPiLine, poRefByPoItemId } from './line-po-ref';
import { piPriceDifferenceSummary } from './pi-po-price-rule';

/* The pure rule lives in its own mirrored file; re-exported so existing importers keep one door. */
export { comparePiLinePrice, defaultPiUnitPriceSen, piPriceDifferenceSummary, type PiLinePriceComparison } from './pi-po-price-rule';

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
    select: (cols: string) => {
      in: (col: string, vals: string[]) => PromiseLike<{ data: unknown; error: unknown }>;
    };
  };
};

/* ── The trail, taken once ─────────────────────────────────────────────────
   Migration 20260914T0200 stores the ordered price ON the invoice line. Every
   insert path calls this on the rows it is about to write, so the value comes
   from the server's own link at that moment — a `po_unit_price_sen` in a
   request body is overwritten, and a line with no purchase order behind it is
   null. A failed read THROWS: an invoice written with a silent trail of nulls
   would look exactly like "no purchase order", which is the wrong answer. */
export async function stampPoPriceSnapshot(sb: MinimalPgrest, rows: Array<Record<string, unknown>>): Promise<void> {
  const grnItemIds = [...new Set(rows.map((r) => r.grn_item_id).filter((v): v is string => typeof v === 'string' && !!v))];
  for (const r of rows) r.po_unit_price_sen = null;
  if (!grnItemIds.length) return;
  const g = await sb.from('grn_items').select('id, purchase_order_item_id').in('id', grnItemIds);
  if (g.error) throw new Error(`grn_items read failed: ${String((g.error as { message?: string }).message ?? g.error)}`);
  const grnRows = (g.data ?? []) as Array<{ id: string; purchase_order_item_id: string | null }>;
  const poiIds = [...new Set(grnRows.map((x) => x.purchase_order_item_id).filter((v): v is string => !!v))];
  const poItems: Array<{ id: string; unit_price_sen: number | null }> = [];
  if (poiIds.length) {
    const p = await sb.from('purchase_order_items').select('id, unit_price_sen').in('id', poiIds);
    if (p.error) throw new Error(`purchase_order_items read failed: ${String((p.error as { message?: string }).message ?? p.error)}`);
    poItems.push(...((p.data ?? []) as Array<{ id: string; unit_price_sen: number | null }>));
  }
  const keyed = rows.map((r, i) => ({ id: String(i), grn_item_id: (r.grn_item_id as string | null | undefined) ?? null }));
  const byLine = poUnitPriceByPiLine(keyed, grnRows, poItems);
  rows.forEach((r, i) => { r.po_unit_price_sen = byLine.get(String(i)) ?? null; });
}

/** The one-line form every insert site uses: stamp the trail, then run the
 *  site's own insert. A failed stamp comes back in the insert's error shape, so
 *  each site's existing failure handling (rollback, 500) applies unchanged.
 *  `sb` is `unknown` because the route's real client type is too deep for the
 *  structural one (TS2589) — the same reason the detail route casts. */
export async function withPoPriceSnapshot<R extends { error: { message: string } | null }>(
  sb: unknown,
  rows: Array<Record<string, unknown>>,
  insert: () => PromiseLike<R>,
): Promise<R | { data: null; error: { message: string } }> {
  try {
    await stampPoPriceSnapshot(sb as MinimalPgrest, rows);
  } catch (e) {
    return { data: null, error: { message: e instanceof Error ? e.message : String(e) } };
  }
  return insert();
}

export async function attachGrnLineFacts(sb: MinimalPgrest, items: PiLineEnrichable[]): Promise<void> {
  const grnItemIds = [...new Set(items.map((r) => r.grn_item_id).filter((v): v is string => !!v))];
  /* The stored trail (20260914T0200) as the detail read returned it, taken
     BEFORE the fields are reset. `po_price_source` tells the screen which one
     it is looking at: 'snapshot' | 'live' (a line written before the column
     existed) | 'none'. */
  const stored = new Map<string, number>();
  for (const it of items) {
    if (typeof it.po_unit_price_sen === 'number') stored.set(it.id, it.po_unit_price_sen);
    it.supplier_sku = null; it.po_unit_price_sen = null; it.source_po_id = null; it.source_po_number = null;
    it.po_price_source = 'none';
  }
  for (const it of items) {
    if (stored.has(it.id)) { it.po_unit_price_sen = stored.get(it.id)!; it.po_price_source = 'snapshot'; }
  }
  if (!grnItemIds.length) return;

  /* Bind the error and THROW rather than reading `data ?? []` as "none": a
     failed read and an empty result are different facts, and collapsing them
     would quietly report every line as having no purchase order behind it —
     which is exactly the wrong answer to show a person checking a bill. The
     caller catches, logs, and leaves both fields null. */
  const { data: gis, error: gErr } = await sb.from('grn_items')
    .select('id, supplier_sku, purchase_order_item_id').in('id', grnItemIds);
  if (gErr) throw new Error(`grn_items read failed: ${String((gErr as { message?: string }).message ?? gErr)}`);
  const grnRows = (gis ?? []) as Array<{
    id: string; supplier_sku: string | null; purchase_order_item_id: string | null;
  }>;

  const skuByGrnItem = new Map<string, string>();
  for (const g of grnRows) if (g.supplier_sku) skuByGrnItem.set(g.id, g.supplier_sku);

  const poiIds = [...new Set(grnRows.map((g) => g.purchase_order_item_id).filter((v): v is string => !!v))];
  /* The same PO-line read carries the line's own purchase order (#26), so the
     PO number beside a line and the PO price beside it can never come from two
     different rows. */
  type PoItemRow = { id: string; unit_price_sen: number | null; purchase_order_id: string | null; po?: { po_number?: string | null } | null };
  const poItems: PoItemRow[] = [];
  if (poiIds.length) {
    const res = await sb.from('purchase_order_items')
      .select('id, unit_price_sen, purchase_order_id, po:purchase_orders ( po_number )').in('id', poiIds);
    if (res.error) {
      throw new Error(`purchase_order_items read failed: ${String((res.error as { message?: string }).message ?? res.error)}`);
    }
    poItems.push(...((res.data ?? []) as PoItemRow[]));
  }

  const poPriceByLine = poUnitPriceByPiLine(items, grnRows, poItems);
  const poRefByLine = poRefByPiLine(items, grnRows, poRefByPoItemId(poItems));
  for (const it of items) {
    it.supplier_sku = it.grn_item_id ? skuByGrnItem.get(it.grn_item_id) ?? null : null;
    if (!stored.has(it.id)) {
      it.po_unit_price_sen = poPriceByLine.get(it.id) ?? null;
      it.po_price_source = it.po_unit_price_sen == null ? 'none' : 'live';
    }
    const ref = poRefByLine.get(it.id) ?? null;
    it.source_po_id = ref?.poId ?? null;
    it.source_po_number = ref?.poNumber ?? null;
  }
}

/* ── The list marker ──────────────────────────────────────────────────────
   Per invoice: how many lines were billed at a price other than the one their
   purchase order named, the net per-unit x qty difference, and how many lines
   HAD a PO price to compare at all — so the list can say "no PO price" rather
   than a reassuring "matches" for an invoice nothing could be compared on.
   Information only (owner 2026-09-14: 「这只是一个 reference 的」). */
export type PiPoPriceSummary = { linesDiffering: number; totalDiffSen: number; comparableLines: number; lines: number };

export const piPoPriceSummaryByInvoice = (
  lines: ReadonlyArray<{ purchase_invoice_id: string; qty?: number | null; unit_price_sen?: number | null; po_unit_price_sen?: number | null }>,
): Map<string, PiPoPriceSummary> => {
  const grouped = new Map<string, Array<{ qty: number; supplierUnitPriceSen: number; poUnitPriceSen: number | null }>>();
  for (const l of lines) {
    const arr = grouped.get(l.purchase_invoice_id) ?? [];
    arr.push({ qty: Number(l.qty ?? 0) || 0, supplierUnitPriceSen: Number(l.unit_price_sen ?? 0) || 0, poUnitPriceSen: l.po_unit_price_sen ?? null });
    grouped.set(l.purchase_invoice_id, arr);
  }
  const out = new Map<string, PiPoPriceSummary>();
  for (const [id, arr] of grouped) {
    const { linesDiffering, totalDiffSen } = piPriceDifferenceSummary(arr);
    const comparableLines = arr.filter((a) => a.poUnitPriceSen != null && a.poUnitPriceSen !== 0).length;
    out.set(id, { linesDiffering, totalDiffSen, comparableLines, lines: arr.length });
  }
  return out;
};
