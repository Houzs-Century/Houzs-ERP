/* ----------------------------------------------------------------------------
   so-po-raised — has a PURCHASE ORDER been raised from this sales order?

   IT GATES THE REBUILD, and the reason is a gap the owner named before the code
   did. 2026-09-02: 「如果它已经是转了 PO 或者被 convert 的话，这张订单就不能被更改
   了呀」 — he believed a converted order is locked. For a DELIVERY ORDER and a
   SALES INVOICE it is: `scm/lib/downstream-lock.ts` counts both. **It does not
   count a purchase order raised from the sales order**, so such an order is
   still editable today.

   That is survivable for an ordinary edit and NOT survivable for a rebuild: a
   rebuild destroys and reissues every DtlKey, and `PODTL.FromSODtlKey` is the
   purchase line's record of WHICH SALES LINE it was raised for. Voiding it
   silently breaks the link between a customer's order and the goods bought for
   it — the thing the whole document graph hangs on.

   THE HOST'S OWN CHECK CANNOT BE RELIED ON HERE. `AnyLineTransferred` reads
   `SODTL.TransferedQty > 0`, and whether an SO->PO transfer writes that column
   is UNKNOWN — `AcSyncService.cs` says so in its own words. An UNKNOWN is not a
   guard, so the ERP answers from what it can prove: its own rows.

   NOT A NEW LOCK. This refuses one destructive MECHANISM, never an edit. A
   change to such an order still syncs the way it always has — matched line by
   line, keys preserved. Widening `downstream-lock` to count purchase orders is a
   separate decision and the owner's to make, not one to smuggle in here.
   -------------------------------------------------------------------------- */
import type { SupabaseClient } from '@supabase/supabase-js';

type Sb = SupabaseClient;

/** True when any live purchase-order line was raised for a line of this order.
 *
 *  THROWS on a failed read rather than answering `false`. "I could not tell" and
 *  "no purchase order exists" are opposite facts, and only one of them makes a
 *  rebuild safe — the same rule venue-binding.ts and autocount-relink.ts apply.
 */
export async function poRaisedFromSo(sb: Sb, soDocNo: string): Promise<boolean> {
  /* Through the SO's own line ids: `purchase_order_items.so_item_id` is the
     stored link (mig 0235's fast path), and its allocations table supersedes it
     only for the finer-grained answer — either one existing is enough here. */
  const { data: items, error: itemErr } = await sb
    .from('mfg_sales_order_items').select('id').eq('doc_no', soDocNo);
  if (itemErr) throw new Error(`so-po-raised: ${itemErr.message}`);
  const ids = (items ?? []).map((r) => (r as { id: string }).id);
  if (!ids.length) return false;

  const { count, error } = await sb
    .from('purchase_order_items')
    .select('id', { count: 'exact', head: true })
    .in('so_item_id', ids);
  if (error) throw new Error(`so-po-raised: ${error.message}`);
  return (count ?? 0) > 0;
}
