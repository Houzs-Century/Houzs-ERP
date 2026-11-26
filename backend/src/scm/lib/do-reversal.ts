
export interface DoReversalMovement {
  movement_type: string;
  warehouse_id: string;
  item_code: string;
  variant_key: string | null;
  batch_no?: string | null;
  qty: number;
  total_cost_sen: number | null;
  product_name: string | null;
}

export interface DoReversalContext {
  deliveryOrderId: string;
  doNo: string;
  performedBy: string;
  dropshipBatchedHandled: boolean;
  nonDropshipHandled: boolean;
}

export interface DoReversalRow {
  warehouse_id: string;
  item_code: string;
  variant_key: string;
  product_name: string | null;
  qty: number;
  unit_cost_sen: number;
  source_doc_type: 'ADJUSTMENT';
  source_doc_id: string;
  source_doc_no: string;
  performed_by: string;
  notes: string;
  movement_type: 'ADJUSTMENT' | 'IN';
  batch_no?: string;
}

interface Agg {
  warehouse_id: string;
  item_code: string;
  variant_key: string;
  batch_no: string | null;
  product_name: string | null;
  net_out: number;
  out_total_cost: number;
  out_qty: number;
}

/**
 * Legacy add-back rows for a cancelled DO's movements, bucketed by
 * (warehouse, product, variant, batch). net_out per bucket = Σ OUT qty − Σ IN qty
 * across THIS DO's own movements.
 *
 * Returns an EMPTY array when the authoritative SQL fn already handled the DO:
 *   - nonDropshipHandled  -> fn_reverse_do_out reversed ALL buckets;
 *   - dropshipBatchedHandled -> fn_reverse_dropship_do_out reversed the BATCHED
 *     buckets, so only the plain (unbatched) buckets still need route-side rows.
 */
export function buildDoReversalRows(
  movs: DoReversalMovement[],
  ctx: DoReversalContext,
): DoReversalRow[] {
  const byBucket = new Map<string, Agg>();
  for (const m of movs) {
    if (m.movement_type !== 'IN' && m.movement_type !== 'OUT') continue;
    const variant_key = m.variant_key ?? '';
    const batch_no = m.batch_no ?? null;
    const k = `${m.warehouse_id}::${m.item_code}::${variant_key}::${batch_no ?? ''}`;
    let agg = byBucket.get(k);
    if (!agg) {
      agg = { warehouse_id: m.warehouse_id, item_code: m.item_code, variant_key, batch_no, product_name: m.product_name, net_out: 0, out_total_cost: 0, out_qty: 0 };
      byBucket.set(k, agg);
    }
    const q = Number(m.qty ?? 0);
    if (m.movement_type === 'OUT') { agg.net_out += q; agg.out_total_cost += Number(m.total_cost_sen ?? 0); agg.out_qty += q; }
    else { agg.net_out -= q; }
    if (!agg.product_name) agg.product_name = m.product_name;
  }

  return [...byBucket.values()]
    .filter((b) => b.net_out > 0)
    .filter(() => !ctx.nonDropshipHandled)
    .filter((b) => !(ctx.dropshipBatchedHandled && b.batch_no))
    .map((b) => {
      const unit_cost_sen = b.out_qty > 0 ? Math.round(b.out_total_cost / b.out_qty) : 0;
      const base = {
        warehouse_id: b.warehouse_id,
        item_code: b.item_code,
        variant_key: b.variant_key,
        product_name: b.product_name,
        qty: b.net_out,
        unit_cost_sen,
        source_doc_type: 'ADJUSTMENT' as const,
        source_doc_id: ctx.deliveryOrderId,
        source_doc_no: ctx.doNo,
        performed_by: ctx.performedBy,
        notes: `Delivery order ${ctx.doNo} cancelled — reversing shipment (stock returned to shelf)`,
      };
      return b.batch_no
        ? { ...base, movement_type: 'IN' as const, batch_no: b.batch_no }
        : { ...base, movement_type: 'ADJUSTMENT' as const };
    });
}
