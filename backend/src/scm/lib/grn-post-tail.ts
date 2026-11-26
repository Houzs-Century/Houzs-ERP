
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
      try { await restampSiFromDo(sb, doId); } catch { }
    }
  } catch (e) { console.error(`[${tag}] DO restamp failed:`, e); }
}

export async function runGrnPostTail(sb: ReconcileClient, tail: GrnPostTail): Promise<void> {
  const { grnId, grnNo, companyId, userId, booked } = tail;
  if (booked) {
    const reconcile = await timed('tail-dropship', () => reconcileDropshipBatches(sb, booked.buckets, userId));
    await restampDos(sb, reconcile.affectedDoIds, 'dropship');
    const oversell = await timed('tail-oversell', () => reconcileUncostedOuts(
      sb,
      booked.buckets.map((m) => ({ warehouse_id: m.warehouse_id, item_code: m.item_code, variant_key: m.variant_key })),
      booked.receiptCutoffTs,
      userId,
    ));
    await restampDos(sb, oversell.affectedDoIds, 'oversell');
  }
  try {
    const { placeGrnLinesOnRacks } = await import('./grn-rack-sync');
    await timed('tail-racks', () => placeGrnLinesOnRacks(sb, grnId, grnNo, userId));
  } catch (e) { console.error('[grn-rack] place failed:', e); }
  /* Which open orders the stock-PO lines of this receipt serve (owner 2026-10-19). */
  try {
    const { recordReceiptAssignments } = await import('./receipt-so-assignment');
    await timed('tail-receipt-so', () => recordReceiptAssignments(sb, grnId, companyId));
  } catch (e) { console.error('[receipt-so] post-grn failed:', e); }
  try {
    const { recomputeAllocationAfterSave } = await import('./stock-allocation-job');
    await recomputeAllocationAfterSave(sb, 'post-grn');
  } catch (e) { console.error('[so-allocation] post-grn failed:', e); }
}

/** A stored date as YYYY-MM-DD. postgres.js hands a DATE / timestamptz back as a
 *  JS Date, and String(date).slice(0, 10) of that reads 'Mon Oct 05'. */
export function isoDayOf(value: unknown): string | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  const text = typeof value === 'string' ? value.slice(0, 10) : '';
  return text || null;
}
