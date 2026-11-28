
import { soDeliverableRemaining } from '../routes/delivery-orders-mfg';

/** Σ delivered / Σ remaining per SO doc_no.
 *
 *  eslint-disable-next-line @typescript-eslint/no-explicit-any — `sb` is the
 *  untyped supabase-js client this tree passes around. */
export async function boardDeliverableByDoc(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sb: any,
  docNos: string[],
): Promise<{ deliveredByDoc: Map<string, number>; remainingByDoc: Map<string, number> }> {
  const deliveredByDoc = new Map<string, number>();
  const remainingByDoc = new Map<string, number>();
  for (const line of (await soDeliverableRemaining(sb, docNos)).values()) {
    deliveredByDoc.set(line.docNo, (deliveredByDoc.get(line.docNo) ?? 0) + line.delivered);
    remainingByDoc.set(line.docNo, (remainingByDoc.get(line.docNo) ?? 0) + line.remaining);
  }
  return { deliveredByDoc, remainingByDoc };
}
