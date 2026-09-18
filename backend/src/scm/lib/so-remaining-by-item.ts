/* Remaining-to-deliver per SALES-ORDER LINE id.
 *
 * Moved out of routes/delivery-orders-mfg.ts, where it was a private helper in
 * a 5,589-line file, so that the identity assertion below could be added
 * without growing that file — the file-size gate charges GROWTH and names this
 * as the way to pay. It also puts the function beside `doLineRemaining`, the
 * same shape one document further down the chain.
 */
import { soDeliverableRemaining } from '../routes/delivery-orders-mfg';

export async function soRemainingByItemId(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sb: any,
  soItemIds: Array<string | null | undefined>,
): Promise<Map<string, number>> {
  const ids = [...new Set(soItemIds.filter((x): x is string => !!x))];
  const out = new Map<string, number>();
  if (ids.length === 0) return out;
  const { data } = await sb.from('mfg_sales_order_items').select('doc_no').in('id', ids);
  const docNos = [...new Set(((data ?? []) as Array<{ doc_no: string | null }>).map((r) => r.doc_no).filter((d): d is string => !!d))];
  const remainingMap = await soDeliverableRemaining(sb, docNos);
  for (const id of ids) out.set(id, remainingMap.get(id)?.remaining ?? 0);
  return out;
}
