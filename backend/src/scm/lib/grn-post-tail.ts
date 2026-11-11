// ----------------------------------------------------------------------------
// scm/lib/grn-post-tail — what a GRN post does AFTER its stock IN has committed.
//
// None of this is the receipt itself, and each step was already best-effort: a
// failure never undid the post. Split out of postGrnAndRollup (routes/grns.ts) so
// the atomic post (GRN_POST_MODE=atomic, lib/stock-post-tx.ts) can commit the
// core first and run these on the ordinary client after commit. The two-step path
// runs them straight after its own writes, as before.
//
//   - drop-ship and oversell retro-cost reconciles, then the DO / SI cost restamps
//     they call for (the reconcile needs the new lots, so it waits for the commit);
//   - rack placement, receipt-to-SO assignment, SO stock allocation.
// ----------------------------------------------------------------------------

import { reconcileDropshipBatches } from './inventory-movements';
import { reconcileUncostedOuts } from './oversell-retrocost';
import { timed } from '../../lib/step-timing';

/** The buckets the stock IN just opened lots in. Empty when this call wrote no IN. */
export type GrnTailBucket = {
  warehouse_id: string;
  item_code: string;
  variant_key: string;
  batch_no: string | null;
};

export type GrnPostTail = {
  grnId: string;
  grnNo: string;
  companyId: number;
  userId: string;
  /** Set only when this call wrote the IN rows; the reconciles run on these. */
  booked: { buckets: GrnTailBucket[]; receiptCutoffTs: string } | null;
};

type ReconcileClient = Parameters<typeof reconcileDropshipBatches>[0];

async function restampDos(sb: ReconcileClient, doIds: string[], tag: string): Promise<void> {
  if (doIds.length === 0) return;
  try {
    const { restampDoActualCost } = await import('../routes/delivery-orders-mfg');
    const { restampSiFromDo } = await import('./recost');
    for (const doId of doIds) {
      await restampDoActualCost(sb, doId);
      try { await restampSiFromDo(sb, doId); } catch { /* best-effort */ }
    }
  } catch (e) { console.error(`[${tag}] DO restamp failed:`, e); }
}

export async function runGrnPostTail(sb: ReconcileClient, tail: GrnPostTail): Promise<void> {
  const { grnId, grnNo, companyId, userId, booked } = tail;
  if (booked) {
    /* Drop-ship receipt reconcile (mig 0057) — a sofa drop-shipped against this
       batch before receipt consumed no lot; consume that shortfall from the new
       lots so coverage and valuation do not count the shipped units twice.
       Ledger-driven and idempotent. Then restamp the DO lines and their SIs. */
    const reconcile = await timed('tail-dropship', () => reconcileDropshipBatches(sb, booked.buckets, userId));
    await restampDos(sb, reconcile.affectedDoIds, 'dropship');
    /* Oversell retro-cost (mig 0154) — normal DO short-ships that shipped
       uncosted BEFORE this receipt (receiptCutoffTs) take their cost from the
       arriving lots. Drop-ship shorts belong to the reconcile above. */
    const oversell = await timed('tail-oversell', () => reconcileUncostedOuts(
      sb,
      booked.buckets.map((m) => ({ warehouse_id: m.warehouse_id, item_code: m.item_code, variant_key: m.variant_key })),
      booked.receiptCutoffTs,
      userId,
    ));
    await restampDos(sb, oversell.affectedDoIds, 'oversell');
  }
  /* Physical rack placement (separate ledger, mig 0151). */
  try {
    const { placeGrnLinesOnRacks } = await import('./grn-rack-sync');
    await timed('tail-racks', () => placeGrnLinesOnRacks(sb, grnId, grnNo, userId));
  } catch (e) { console.error('[grn-rack] place failed:', e); }
  /* Which open orders the stock-PO lines of this receipt serve (owner 2026-10-19). */
  try {
    const { recordReceiptAssignments } = await import('./receipt-so-assignment');
    await timed('tail-receipt-so', () => recordReceiptAssignments(sb, grnId, companyId));
  } catch (e) { console.error('[receipt-so] post-grn failed:', e); }
  /* B2C SO auto-allocation — re-walk PENDING SO lines against the new stock. */
  try {
    const { recomputeSoStockAllocation } = await import('./so-stock-allocation');
    await recomputeSoStockAllocation(sb);
  } catch (e) { console.error('[so-allocation] post-grn failed:', e); }
}

/** A stored date as YYYY-MM-DD. postgres.js hands a DATE / timestamptz back as a
 *  JS Date, and String(date).slice(0, 10) of that reads 'Mon Oct 05'. */
export function isoDayOf(value: unknown): string | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  const text = typeof value === 'string' ? value.slice(0, 10) : '';
  return text || null;
}
