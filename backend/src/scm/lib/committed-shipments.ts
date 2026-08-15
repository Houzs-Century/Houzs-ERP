// ----------------------------------------------------------------------------
// committed-shipments — the LOADER for "units a shipment already owns".
//
// MOVED VERBATIM out of routes/mrp.ts (2026-08-07, PR-4 the bind flip) so the
// DO-time live allocator can fold outstanding ship-before-arrival commitments
// into its available-qty inputs THROUGH THE SAME READ MRP uses. Two loaders
// would be two definitions of "still committed", which is exactly the drift
// class the MRP guide's "one business rule, one home" trap warns about. The
// PURE half of the rule (outstandingCommitments — claimability is the same
// `ABS(qty) - SUM(consumed)` test the SQL reconcile recomputes) stays in
// lib/ship-commitment.ts; this file is only the ledger read that feeds it.
//
// Nothing here changed in the move. mrp.ts imports composite / WH_NONE /
// loadCommittedShipments from here and behaves byte-identically.
// ----------------------------------------------------------------------------

import {
  outstandingCommitments,
  type CommittedShipmentRow,
  type OutstandingCommitment,
} from './ship-commitment';
import { chunkIn } from './paginate-all';

/* Commander 2026-05-31 — every bucket is scoped by warehouse: stock can't cross
   warehouses, so a (code, variant) pair in KL is a DIFFERENT bucket from the
   same pair in PJ. NULL warehouse (unmapped state / pre-backfill line) gets its
   own WH_NONE bucket so it never silently shares another warehouse's stock. */
export const WH_NONE = 'NOWH';
export const composite = (whId: string | null, code: string, vkey: string): string =>
  `${whId ?? WH_NONE}|${code}|${vkey}`;

/* Load the ship-before-arrival commitments that are still outstanding against
   the given open PO numbers (= batch numbers, since a GRN stamps batch_no =
   source PO number, mig 0120).

   BOUNDED BY THE OPEN POs ON PURPOSE. Every normal sofa ship also carries a
   batch_no, so an unfiltered scan of batched OUT movements would grow with the
   whole shipment history on a hot read path. Filtering to batches that still
   have an OPEN PO line keeps the working set to what could possibly matter, and
   the three follow-up reads are all keyed off that first bounded result — no
   N+1, four reads total, and none at all when nothing is on order.

   ⚠ BOUNDED IS NOT THE SAME AS SMALL, AND EVERY READ HERE IS PAGED. PostgREST
   caps a response at ~1000 rows and reports NO error when it clips — the trap
   mrp.ts documents twice (the product-master read in its section 2, and
   so-stock-allocation.ts). All four reads can exceed it: a few hundred open
   POs is thousands of matching OUTs; a movement can carry several lot
   consumptions, so 300 movements alone can blow the cap. Truncation is not a
   rounding error here, it changes the answer in BOTH directions — a lost DO
   header reads as `cancelled: !d` and DROPS a real commitment, while a lost
   consumption row understates consumedQty and OVERSTATES the commitment,
   over-deducting the PO pool and over-adding-back to stock. chunkIn pages every
   chunk (paginate-all.ts), so none of them can clip.

   BEST-EFFORT: any read error yields an empty map, i.e. no deduction and no
   add-back — the two always move together. A planning page must not 500, and a
   shipment must not go unbound, because a commitment lookup hiccuped. */
export async function loadCommittedShipments(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sb: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  scoped: <Q>(q: Q) => Q,
  poNumbers: string[],
): Promise<Map<string, OutstandingCommitment>> {
  const batches = [...new Set(poNumbers.filter(Boolean))];
  if (batches.length === 0) return new Map();
  try {
    type MovRow = {
      id: string; warehouse_id: string | null; product_code: string;
      variant_key: string | null; batch_no: string | null; qty: number; source_doc_id: string | null;
    };
    const { data: movs, error: movErr } = await chunkIn<MovRow>(batches, (batch, from, to) =>
      scoped(sb.from('inventory_movements')
        .select('id, warehouse_id, product_code, variant_key, batch_no, qty, source_doc_id')
        .eq('movement_type', 'OUT')
        .eq('source_doc_type', 'DO')
        .in('batch_no', batch))
        .order('id')
        .range(from, to));
    if (movErr) return new Map();
    if (movs.length === 0) return new Map();

    const doIds = [...new Set(movs.map((m) => m.source_doc_id).filter((x): x is string => !!x))];
    const movIds = movs.map((m) => m.id);

    /* A CANCELLED DO owns nothing — its OUT was reversed (fn_reverse_dropship_do_out,
       0088) — and is_dropship is the legacy whole-header claim signal the reconcile
       still honours. Both read here so this deduction and the SQL agree.
       A MISSING header is read as cancelled, which is the honest default (offer
       the supply) but ALSO the reason this read must never be truncated: a
       clipped page would silently drop real commitments. */
    type DoRow = { id: string; status: string | null; is_dropship: boolean | null };
    const { data: doRows, error: doErr } = await chunkIn<DoRow>(doIds, (batch, from, to) =>
      scoped(sb.from('delivery_orders').select('id, status, is_dropship').in('id', batch))
        .order('id')
        .range(from, to));
    if (doErr) return new Map();
    const doById = new Map(doRows.map((d) => [d.id, d]));

    /* The per-line claim signal (mig 0230), keyed the same way the SQL keys it —
       INCLUDING the variant, which the SQL scopes on so two lines of one DO
       sharing an item_code across different fabrics cannot cross-claim. The key
       is the STORED committed_variant_key, never a recomputed one: the SQL
       compares that same stored string, and a second derivation of the variant
       identity is how the two would come to disagree. */
    type LineRow = {
      delivery_order_id: string; item_code: string;
      committed_po_batch_no: string; committed_variant_key: string | null;
    };
    const { data: lineRows, error: lineErr } = await chunkIn<LineRow>(doIds, (batch, from, to) =>
      scoped(sb.from('delivery_order_items')
        .select('delivery_order_id, item_code, committed_po_batch_no, committed_variant_key')
        .in('delivery_order_id', batch)
        .not('committed_po_batch_no', 'is', null))
        .order('delivery_order_id')
        .range(from, to));
    if (lineErr) return new Map();
    const committedLines = new Set(
      lineRows.map((r) => `${r.delivery_order_id}|${r.item_code}|${r.committed_variant_key ?? ''}|${r.committed_po_batch_no}`),
    );

    type ConsRow = { movement_id: string; qty_consumed: number };
    const { data: cons, error: consErr } = await chunkIn<ConsRow>(movIds, (batch, from, to) =>
      sb.from('inventory_lot_consumptions')
        .select('movement_id, qty_consumed')
        .in('movement_id', batch)
        .order('movement_id')
        .range(from, to));
    if (consErr) return new Map();
    const consumedByMovement = new Map<string, number>();
    for (const r of cons) {
      consumedByMovement.set(r.movement_id, (consumedByMovement.get(r.movement_id) ?? 0) + Number(r.qty_consumed ?? 0));
    }

    const rows: CommittedShipmentRow[] = [];
    for (const m of movs) {
      if (!m.batch_no || !m.source_doc_id) continue;
      const d = doById.get(m.source_doc_id);
      const variantKey = m.variant_key ?? '';
      rows.push({
        bucketKey: composite(m.warehouse_id ?? null, m.product_code, variantKey),
        warehouseId: m.warehouse_id ?? null,
        itemCode: m.product_code,
        variantKey,
        batchNo: m.batch_no,
        outQty: Math.abs(Number(m.qty ?? 0)),
        consumedQty: consumedByMovement.get(m.id) ?? 0,
        // No header row -> treat as cancelled: never deduct on a document we
        // could not read (the honest default is "offer the supply").
        cancelled: !d || (d.status ?? '').toUpperCase() === 'CANCELLED',
        headerDropship: d?.is_dropship === true,
        lineCommitted: committedLines.has(`${m.source_doc_id}|${m.product_code}|${variantKey}|${m.batch_no}`),
      });
    }
    return outstandingCommitments(rows);
  } catch {
    return new Map();
  }
}
