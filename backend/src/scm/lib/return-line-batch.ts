
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
