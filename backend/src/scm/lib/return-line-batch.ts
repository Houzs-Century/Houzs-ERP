// The batch a returned sofa module re-enters stock under.
//
// 2990-0011 (Sim, 2026-10-20): 2990-DR-2610-001 brought back the XAMMAR set
// that 2990-DO-2607-012 shipped from batch 2990-PO-2606-010, but the SO lines'
// allocated_batch_no had been cleared after delivery, so both units came back
// with no batch. MRP's sofa set walk reads batched lots only, so the set showed
// SHORT and asked purchasing to order it again, while the SO page said READY.
// The DO's own shipment is the physical answer: the units that come back are
// the units that left.

import type { BucketTrace } from './source-po-trace';

/** The one PO a DO shipped this code + variant from, or null when the shipment
 *  names none or several. `byBucket` is traceDoShipmentSources().byBucket. */
export function shippedBatchOf(
  byBucket: ReadonlyMap<string, BucketTrace>,
  doId: string,
  itemCode: string,
  variantKey: string,
): string | null {
  const exact = byBucket.get(`${doId}::${itemCode}::${variantKey}`);
  const pos = new Set<string>(exact?.pos ?? []);
  if (!exact) {
    const prefix = `${doId}::${itemCode}::`;
    for (const [k, t] of byBucket) if (k.startsWith(prefix)) for (const p of t.pos) pos.add(p);
  }
  return pos.size === 1 ? [...pos][0]! : null;
}
