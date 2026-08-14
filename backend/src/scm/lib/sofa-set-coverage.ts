// Sofa "whole-set, all-or-nothing" batch coverage — the SINGLE source of truth
// for both stock allocation (so-stock-allocation) and the DO ship-gate
// (sofa-batch-guard). Keep ONE definition so the two can never drift.
//
// RULE (Wei Siang 2026-06-03, replaces the earlier "batch belongs to the PO's
// SO" model):
//   • Sofa behaves like every other product — eligibility is plain SKU +
//     variant_key. It is NOT reserved to the SO whose PO created the batch.
//   • The ONLY extra rule: a sofa SET (all the sofa module lines of one SO at
//     one warehouse — e.g. BOOQIT-1A(LHF) + BOOQIT-1A(RHF), same fabric) must be
//     filled from ONE single production batch (batch_no = source PO number = one
//     dye lot) that holds enough of EVERY module. Take the whole set from one
//     batch, or take nothing — never split a dye lot across two batches and
//     never partially consume a batch leaving an orphan half-set.
//   • If no single batch covers the whole set → the set is NOT allocated (stays
//     PENDING) and the DO must NOT be opened for it.
//
// A "batch" is identified by batch_no on inventory_lots (stamped at GRN from the
// source PO number, migration 0120). We read open lots from v_inventory_lots_open
// (migration 0122 exposes batch_no), grouped per (warehouse, batch, code,
// variant). Among batches that cover the whole set we pick the FIFO-oldest
// (earliest received_at) so allocation is deterministic and matches FIFO cost.

export type SofaSetLine = { itemCode: string; variantKey: string; need: number };

/** key = `${warehouseId}|${batchNo}|${productCode}|${variantKey}` → qty_remaining */
export type SofaBatchStock = {
  /** mutable remaining-by-key (callers decrement as sets claim batches) */
  remaining: Map<string, number>;
  /** batch_no → earliest received_at (FIFO ordering; '' if unknown) */
  receivedAt: Map<string, string>;
  /** every batch_no seen, for enumeration */
  batches: Set<string>;
};

export function sofaStockKey(
  warehouseId: string,
  batchNo: string,
  productCode: string,
  variantKey: string,
): string {
  return `${warehouseId}|${batchNo}|${productCode}|${variantKey}`;
}

/** Load open-lot stock for `codes`, grouped per (warehouse, batch, code, variant).
 *  Only batched lots (batch_no NOT NULL) matter for sofa set matching. */
export async function loadSofaBatchStock(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sb: any,
  codes: string[],
): Promise<SofaBatchStock> {
  const remaining = new Map<string, number>();
  const receivedAt = new Map<string, string>();
  const batches = new Set<string>();
  const wanted = new Set(codes.filter(Boolean));
  if (wanted.size === 0) return { remaining, receivedAt, batches };

  // Only sofa lots carry a batch_no, so "batched + open" is already the small
  // sofa-only slice. We deliberately do NOT filter product_code via .in() here:
  // sofa codes contain parentheses (e.g. BOOQIT-1A(LHF)) which break PostgREST's
  // in.(...) list syntax and silently return zero rows. Filter codes in JS.
  const { data: lots, error } = await sb
    .from('v_inventory_lots_open')
    .select('warehouse_id, product_code, variant_key, batch_no, qty_remaining, received_at')
    .not('batch_no', 'is', null)
    .gt('qty_remaining', 0);
  if (error) throw new Error(`sofa batch stock load failed: ${error.message}`);

  for (const r of (lots ?? []) as Array<{
    warehouse_id: string; product_code: string; variant_key: string | null;
    batch_no: string; qty_remaining: number; received_at: string | null;
  }>) {
    if (!wanted.has(r.product_code)) continue;
    const v = r.variant_key ?? '';
    const k = sofaStockKey(r.warehouse_id, r.batch_no, r.product_code, v);
    remaining.set(k, (remaining.get(k) ?? 0) + Number(r.qty_remaining ?? 0));
    batches.add(r.batch_no);
    /* received_at is typed string and is one under PostgREST, but a repair
       script driving this through the postgres shim gets a Date back, and the
       FIFO sort below calls .localeCompare on it — which threw and killed a
       production allocation recompute (BUG-HISTORY 2026-08-10). Normalise HERE,
       at the boundary, so everything downstream sees the declared type. */
    const rawRa: unknown = r.received_at;
    const ra = rawRa instanceof Date ? rawRa.toISOString() : (r.received_at ?? '');
    const prev = receivedAt.get(r.batch_no);
    if (prev === undefined || (ra && ra < prev)) receivedAt.set(r.batch_no, ra);
  }
  return { remaining, receivedAt, batches };
}

/** Find the single batch (in `warehouseId`) that completely covers EVERY line of
 *  the set — i.e. has qty_remaining ≥ need for each module. Returns the
 *  FIFO-oldest qualifying batch_no, or null if none covers the whole set.
 *  Does NOT mutate `stock`; call claimSofaBatch() after to decrement. */
export function findCoveringBatch(
  warehouseId: string | null,
  lines: SofaSetLine[],
  stock: SofaBatchStock,
): string | null {
  if (!warehouseId || lines.length === 0) return null;
  // Aggregate need per distinct (itemCode, variantKey). Two lines of the SAME
  // module + variant (e.g. a symmetric sofa's two identical arms) must be SUMMED
  // before comparing to the batch's on-hand — otherwise a batch holding qty 2
  // would falsely "cover" two lines each needing 2 (it must hold 4). (Audit fix
  // 2026-06-03)
  const needByKey = new Map<string, { itemCode: string; variantKey: string; need: number }>();
  for (const ln of lines) {
    const k = `${ln.itemCode}|${ln.variantKey}`;
    const e = needByKey.get(k) ?? { itemCode: ln.itemCode, variantKey: ln.variantKey, need: 0 };
    e.need += ln.need;
    needByKey.set(k, e);
  }
  const reqs = [...needByKey.values()];
  const candidates = [...stock.batches].sort((a, b) => {
    const ra = stock.receivedAt.get(a) ?? '';
    const rb = stock.receivedAt.get(b) ?? '';
    return ra !== rb ? ra.localeCompare(rb) : a.localeCompare(b);
  });
  for (const batch of candidates) {
    let coversAll = true;
    for (const r of reqs) {
      const have = stock.remaining.get(sofaStockKey(warehouseId, batch, r.itemCode, r.variantKey)) ?? 0;
      if (have < r.need) { coversAll = false; break; }
    }
    if (coversAll) return batch;
  }
  return null;
}

/** Decrement `stock.remaining` for a claimed batch so a later set in the same
 *  allocation walk can't double-claim the same units (cross-SO contention). */
export function claimSofaBatch(
  warehouseId: string,
  batch: string,
  lines: SofaSetLine[],
  stock: SofaBatchStock,
): void {
  for (const ln of lines) {
    const key = sofaStockKey(warehouseId, batch, ln.itemCode, ln.variantKey);
    stock.remaining.set(key, Math.max(0, (stock.remaining.get(key) ?? 0) - ln.need));
  }
}
