/* ----------------------------------------------------------------------------
   bound-line-ordered — how much of a HARD-BOUND sales-order line is already on
   a live purchase order, counted per LINE and whatever screen raised it.

   Why this exists (owner 2026-09-14, the custom pillow ruling). The bulk convert
   has two caps and neither sees the other's purchase orders:
     · an MRP-origin convert has NO per-line cap — "reference-only, infinitely
       convertible", because for a POOLED SKU the MRP shortage is the guard;
     · the ordinary cap is `qty - po_qty_picked`, and `recomputeSoPicked`
       deliberately leaves MRP-origin lines out of `po_qty_picked`.
   For a bound line (company 1: sofa / bedframe / (SP) mattress / custom pillow)
   the purchase order IS the line's supply, so ordering it a second time is a
   second set of goods nobody can use. That is how production got custom pillow
   lines ordered twice (HC-SO-013236, HC-SO-013310, HC-SO-013322 each on an
   imported PO plus an MRP-origin HC-PO-2609-0xx; HC-SO-013503 on HC-PO-2609-091
   then HC-PO-2609-101).

   The count uses the SAME live set MRP plans from — a CANCELLED or DRAFT purchase
   order is not supply there (`PO_DEAD`, routes/mrp.ts), so it is not an order
   here either; otherwise the server would refuse a line MRP is showing as short.
   -------------------------------------------------------------------------- */

import { isHardBoundLine, HARD_BOUND_COMPANY_ID } from './so-stock-allocation';
import { chunkIn } from './paginate-all';

const PO_DEAD = new Set(['CANCELLED', 'DRAFT']);

type BoundCandidate = { id: string; item_group: string | null; item_code: string | null };

/**
 * `soItemId -> qty on live purchase-order lines`, for the bound lines among
 * `rows` only. A pooled line gets no entry and costs no read.
 *
 * `companyId` is REQUIRED: binding is a company-1 rule, and a caller that did not
 * say which company it is must not silently get either answer (CLAUDE.md, BUG
 * CLASS optional-param-noop). `null` binds nothing — the pre-existing behaviour.
 */
export async function loadBoundOrderedQty(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the scm PostgREST client is untyped
  sb: any,
  companyId: number | null,
  rows: readonly BoundCandidate[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const ids = [...new Set(rows.filter((r) => isBoundForCompany(companyId, r)).map((r) => r.id))];
  if (ids.length === 0) return out;
  const { data, error } = await chunkIn<{ so_item_id: string; qty: number | null; po: { status: string } | null }>(
    ids,
    (batch, from, to) => sb
      .from('purchase_order_items')
      .select('so_item_id, qty, po:purchase_orders!inner(status)')
      .eq('company_id', companyId)
      .in('so_item_id', batch)
      .order('id')
      .range(from, to),
  );
  /* A failed read must not read as "nothing ordered" — that is the permissive
     direction, and it is exactly the double order this guard exists to stop. */
  if (error) throw new Error(`bound_ordered_read_failed: ${error.message}`);
  for (const r of data) {
    const status = String(r.po?.status ?? '').toUpperCase();
    if (!status || PO_DEAD.has(status)) continue;
    out.set(r.so_item_id, (out.get(r.so_item_id) ?? 0) + Math.max(0, Number(r.qty ?? 0)));
  }
  return out;
}

/** Does every convert — MRP-origin included — cap this line? Company 1's bound
 *  lines only; everything else keeps the pooled model's caps unchanged. */
export function isBoundForCompany(companyId: number | null, row: Omit<BoundCandidate, 'id'>): boolean {
  return companyId === HARD_BOUND_COMPANY_ID && isHardBoundLine(row.item_group, row.item_code);
}

/** The pick count a cap should use: the recorded `po_qty_picked`, raised to
 *  what live purchase orders already hold for a bound line. Never lowered. */
export function boundAwarePicked(
  row: { id: string; po_qty_picked: number | null },
  boundOrdered: ReadonlyMap<string, number>,
): number {
  return Math.max(Number(row.po_qty_picked ?? 0), boundOrdered.get(row.id) ?? 0);
}
