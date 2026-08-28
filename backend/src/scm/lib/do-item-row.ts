/* ----------------------------------------------------------------------------
   do-item-row — one `delivery_order_items` insert row from a request line.

   Moved out of routes/delivery-orders-mfg.ts (which is over its size ceiling)
   when the outbound category fix landed — docs/bugs/0524. Two things it buys
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

/* ── Per-line photo carry (mig 20260828T0746, the DO leg of 0274's rule) ────
   Owner 2026-08-10: converting a document must carry the SO line's photos —
   送货时照片要跟着 line; the driver and the customer see the same reference shot
   the salesperson attached. Same contract as the PO carry in
   routes/mfg-purchase-orders.ts:

     · derived SERVER-side from so_item_id, never taken from the request — the
       client never holds these keys, and trusting a caller-supplied array
       would let any DO line reference any R2 object;
     · SHARED KEYS, not copies — the DO line points at the same R2 objects;
     · PER LINE, never deduplicated — one sofa build is many compartment lines
       sharing one build photo, and folding them would blank every compartment
       but the first;
     · [] and never null — delivery_order_items.photo_urls is NOT NULL, so a
       null here is a failed insert in production. Unlinked/ad-hoc lines get [].

   `scope` is REQUIRED (house rule: a parameter that decides something is never
   optional): it is the tenant boundary on the read, and the right predicate
   differs per caller — scopeToCompany on the active-company create/add paths,
   scopeToAllowedCompanies on the cross-company /from-sos convert. The
   service-role client bypasses RLS, so this predicate is the entire boundary. */
export async function loadCarriedSoLinePhotos(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- supabase-js without generated types; the same house shape as firstUndeliverableSo (source-document-gates.ts)
  sb: any,
  lines: ReadonlyArray<{ soItemId?: unknown }>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the scope wrapper passes the same untyped PostgREST builder through (scopeToCompany / scopeToAllowedCompanies)
  scope: (q: any) => any,
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const ids = [...new Set(
    lines.map((l) => l.soItemId).filter((x): x is string => typeof x === 'string' && x.length > 0),
  )];
  if (ids.length === 0) return out;
  const { data, error } = await scope(sb.from('mfg_sales_order_items').select('id, photo_urls')).in('id', ids);
  if (error) {
    /* Best-effort by DESIGN, and the trade is stated: photo_urls is an
       annotation, the keys stay on the SO line, and a re-carry is always
       possible — so a read blip degrades to photo-less lines rather than
       failing a delivery the operator is cutting. The failure still reaches
       the log instead of nobody. */
    // eslint-disable-next-line no-console
    console.error('[do-line-photo-carry] SO line photo read failed; inserting DO lines without photos:', error.message);
    return out;
  }
  for (const r of (data ?? []) as Array<{ id: string; photo_urls: string[] | null }>) {
    out.set(r.id, r.photo_urls ?? []);
  }
  return out;
}

/** The [] -never-null read of the map, shared by every insert path. A linked
 *  line whose SO row fell outside the caller's predicate resolves to [] too —
 *  the boundary refuses the photos, never the insert. */
export function carriedPhotoUrls(
  photosBySoItem: Map<string, string[]>,
  soItemId: string | null | undefined,
): string[] {
  return (soItemId ? photosBySoItem.get(soItemId) : null) ?? [];
}

/* `commitment` is NEVER read off the request body — it is passed in by the route
   from planShipCommitments, so a client cannot claim a binding the ledger has
   not earned (it decides which receipt gets to net this OUT). */
/* `lineNo` (0165) = the DO's listing position; omit/null for un-numbered. */
/* `photosBySoItem` is REQUIRED for the same reason `scope` above is: forgetting
   it must fail to compile, not silently insert photo-less lines. */
export function buildDoItemRow(
  deliveryOrderId: string,
  it: Record<string, unknown>,
  lineNo: number | null,
  commitment: { poNumber: string; strictBatch: boolean; variantKey: string } | null,
  photosBySoItem: Map<string, string[]>,
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
  const soItemId = (it.soItemId as string | undefined) ?? null;
  return {
    delivery_order_id: deliveryOrderId,
    so_item_id: soItemId,
    /* Mig 20260828T0746 — the source SO line's photo keys (see the carry
       contract above). */
    photo_urls: carriedPhotoUrls(photosBySoItem, soItemId),
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
