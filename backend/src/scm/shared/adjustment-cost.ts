
export const CONSIGNMENT_LOT_SOURCE_DOC_TYPES: ReadonlySet<string> = new Set(['PC_RECEIVE']);

export interface LotCostRow {
  unit_cost_sen: number | null;
  qty_remaining: number | null;
  source_doc_type: string | null;
  received_at?: string | null;
}

const isConsignmentLot = (src: string | null | undefined): boolean =>
  CONSIGNMENT_LOT_SOURCE_DOC_TYPES.has((src ?? '').toUpperCase());

const isPriced = (r: LotCostRow): boolean => Number(r.unit_cost_sen ?? 0) > 0;

/**
 * Weighted-average unit cost (sen) over the SKU's OTHER priced, OPEN,
 * non-consignment lots — the same Sigma(qty*cost)/Sigma(qty) basis
 * check-costless-stock.mjs computes as refAvgCost. Rounded to integer sen
 * (unit_cost_sen is an integer column). Returns null when no priced OPEN lot
 * exists to average (the genuine RM0 case the open-lot view can see).
 */
export function weightedAvgOpenCostSen(rows: readonly LotCostRow[]): number | null {
  let qty = 0;
  let value = 0;
  for (const r of rows) {
    if (isConsignmentLot(r.source_doc_type) || !isPriced(r)) continue;
    const q = Number(r.qty_remaining ?? 0);
    if (q <= 0) continue;
    qty += q;
    value += q * Number(r.unit_cost_sen);
  }
  return qty > 0 ? Math.round(value / qty) : null;
}

/**
 * Last-known unit cost (sen): the most-recently received priced, non-consignment
 * lot for the SKU bucket, REGARDLESS of remaining qty. Heals the "all prior lots
 * already consumed" case, which the open-lot average cannot see (those lots have
 * qty_remaining = 0 but their unit_cost_sen still records what the SKU last cost).
 * Returns null when the SKU has never carried a priced lot.
 */
export function lastKnownCostSen(rows: readonly LotCostRow[]): number | null {
  let best: LotCostRow | null = null;
  for (const r of rows) {
    if (isConsignmentLot(r.source_doc_type) || !isPriced(r)) continue;
    if (best === null || String(r.received_at ?? '') > String(best.received_at ?? '')) best = r;
  }
  return best ? Number(best.unit_cost_sen) : null;
}

export type ForcedCost =
  | { ok: true; unitCostSen: number; basis: 'operator' | 'weighted-avg' | 'last-known' }
  | { ok: false; reason: 'cost_required' };

/**
 * Resolve the unit cost a POSITIVE ADJUSTMENT / STOCK_TAKE movement must carry so
 * the FIFO trigger never floors a new lot to RM0. Priority (never returns 0):
 *   1. operator-entered positive cost (manual adjustment only) — always honoured;
 *   2. weighted average of the SKU's other priced OPEN lots (refAvgCost);
 *   3. the SKU's last-known priced lot cost (covers all-consumed SKUs);
 *   4. otherwise { ok:false, reason:'cost_required' } — the SKU has NO cost basis
 *      anywhere and the operator must supply one. NEVER writes 0.
 *
 * `lots` is every inventory_lots row for the SKU's (warehouse, product, variant)
 * bucket in the active company (open + already-consumed); the pure helpers filter
 * it (avg over qty_remaining > 0, last-known over any). Consignment lots are
 * excluded from both.
 */
export function resolveForcedUnitCostSen(args: {
  operatorCostSen?: number | null;
  lots: readonly LotCostRow[];
}): ForcedCost {
  const op = Number(args.operatorCostSen ?? 0);
  if (Number.isFinite(op) && op > 0) return { ok: true, unitCostSen: Math.round(op), basis: 'operator' };

  const avg = weightedAvgOpenCostSen(args.lots);
  if (avg != null && avg > 0) return { ok: true, unitCostSen: avg, basis: 'weighted-avg' };

  const last = lastKnownCostSen(args.lots);
  if (last != null && last > 0) return { ok: true, unitCostSen: last, basis: 'last-known' };

  return { ok: false, reason: 'cost_required' };
}
