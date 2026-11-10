// Giving units of a shipped DO back to stock when its lines are edited (qty
// lowered, line deleted, or the line's spec changed so its units move bucket).
// Used by resyncInventoryForDo (routes/delivery-orders-mfg.ts).
//
// The units go back to the lots that paid for them, through
// scm.fn_return_do_units_at_cost (mig 0291, fixed by 20261110T0753). There is no
// fallback any more. Until 2026-11-10 a failed call wrote a plain IN instead, and
// the FIFO trigger turned that IN into a NEW lot sourced from the DO: no GRN, no
// PO, and the original lot still consumed. The call failed every time (the route
// sent p_item_code, the function's parameter is p_product_code; and the function
// body ordered by a column that does not exist), so every shipped-DO edit since
// #2447 minted such a lot. 2990-DO-2611-016 then showed a rack but no PO.
//
// A failed return now writes nothing. The edit stands, an audit row names the
// buckets, and the next save of the DO recomputes the same delta and tries again.
// A ledger that lags an edit can be caught up; a lot with no origin cannot be
// traced back.

/* eslint-disable @typescript-eslint/no-explicit-any -- PostgREST shim, as in the route */

export const DO_RETURN_NOTES = 'Resync: line qty reduced / line deleted (shipped DO).';

export type DoUnitReturn = {
  warehouse_id: string;
  item_code: string;
  variant_key: string;
  batch_no: string | null;
  qty: number;
  correction_seq: number;
};

/** The RPC arguments, named EXACTLY as the SQL function's parameters. PostgREST
 *  matches a function by its argument names; one wrong name is "function not
 *  found", which is how this call failed for three months. Pinned by
 *  tests/doResyncReturnContract.test.ts against the latest migration. */
export function returnAtCostArgs(doId: string, r: DoUnitReturn, performedBy: string | null): Record<string, unknown> {
  return {
    p_do_id: doId,
    p_warehouse_id: r.warehouse_id,
    p_product_code: r.item_code,
    p_variant_key: r.variant_key,
    p_batch_no: r.batch_no,
    p_qty: r.qty,
    p_correction_seq: r.correction_seq,
    p_performed_by: performedBy ?? null,
    p_notes: DO_RETURN_NOTES,
  };
}

/** Return each bucket's units at original lot cost. Buckets are independent, so
 *  one failure does not stop the rest. Never throws. */
export async function returnDoUnitsAtCost(
  sb: any, doId: string, returns: DoUnitReturn[], performedBy: string | null,
): Promise<{ handled: DoUnitReturn[]; failed: Array<{ ret: DoUnitReturn; reason: string }> }> {
  const handled: DoUnitReturn[] = [];
  const failed: Array<{ ret: DoUnitReturn; reason: string }> = [];
  for (const r of returns) {
    try {
      const { error } = await sb.rpc('fn_return_do_units_at_cost', returnAtCostArgs(doId, r, performedBy));
      if (error) failed.push({ ret: r, reason: error.message ?? 'unknown' });
      else handled.push(r);
    } catch (e) {
      failed.push({ ret: r, reason: e instanceof Error ? e.message : String(e) });
    }
  }
  return { handled, failed };
}

/** The movement-shaped row reconcileUncostedAfterIn reads for a returned bucket:
 *  the restored lots can retro-cost an earlier "ship anyway" OUT like any IN. */
export function returnedAsInRow(r: DoUnitReturn): { movement_type: 'IN'; warehouse_id: string; item_code: string; variant_key: string; qty: number } {
  return { movement_type: 'IN', warehouse_id: r.warehouse_id, item_code: r.item_code, variant_key: r.variant_key, qty: r.qty };
}

export function describeFailedReturns(failed: Array<{ ret: DoUnitReturn; reason: string }>): string {
  return failed
    .map((f) => `${f.ret.item_code} [${f.ret.variant_key || '-'}] x${f.ret.qty}: ${f.reason}`)
    .join('; ');
}
