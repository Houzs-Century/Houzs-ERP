import { scopeToCompanyId } from './companyScope';
import { pgrestInList } from './pgrest-in-list';
import { soLineFreezeFrom } from '../shared/so-line-freeze';

/* Line ids the header date cascade must skip: lines a live Consignment Note
   carries (so-line-freeze rules 1 and 3, the SO's rule). `null` = skip every line:
   a live note line names no CO line, or the read failed — fail closed. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- same untyped client as the consignment-orders route
async function coFrozenLineFilter(sb: any, coDocNo: string, companyId: number): Promise<string[] | null> {
  const { data: notes, error: noteErr } = await scopeToCompanyId(sb.from('consignment_delivery_orders')
    .select('id, status').eq('consignment_so_doc_no', coDocNo), companyId);
  if (noteErr) return null;
  const status = new Map(((notes ?? []) as Array<{ id: string; status: string | null }>).map((n) => [n.id, n.status]));
  if (status.size === 0) return [];
  const { data: noteLines, error: lineErr } = await scopeToCompanyId(sb.from('consignment_delivery_order_items')
    .select('consignment_so_item_id, consignment_delivery_order_id')
    .in('consignment_delivery_order_id', [...status.keys()]), companyId);
  if (lineErr) return null;
  const freeze = soLineFreezeFrom(
    ((noteLines ?? []) as Array<{ consignment_so_item_id: string | null; consignment_delivery_order_id: string }>)
      .map((l) => ({ kind: 'DO' as const, so_item_id: l.consignment_so_item_id, status: status.get(l.consignment_delivery_order_id) ?? null })),
    0,
  );
  return freeze.unlinked ? null : [...freeze.frozenLineIds];
}

/* Master-follower cascade (owner 2026-10-06): a header delivery date change
   moves every line EXCEPT a hand-set one (line_delivery_date_overridden — the
   user's date always wins) and one already on a live Consignment Note
   (so-line-freeze rules 1 and 3, as apply_so_header_cas does for the SO).
   Best-effort: the header has already committed. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- same untyped client as the consignment-orders route
export async function cascadeCoHeaderDelivery(sb: any, coDocNo: string, companyId: number, newDate: string | null): Promise<void> {
  const frozen = await coFrozenLineFilter(sb, coDocNo, companyId);
  if (frozen === null) return;
  let q = scopeToCompanyId(sb.from('consignment_sales_order_items')
    .update({ line_delivery_date: newDate })
    .eq('doc_no', coDocNo), companyId)
    .eq('line_delivery_date_overridden', false);
  if (frozen.length > 0) q = q.not('id', 'in', pgrestInList(frozen));
  await q;
}
