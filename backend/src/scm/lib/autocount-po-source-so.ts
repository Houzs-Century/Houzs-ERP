// ----------------------------------------------------------------------------
// autocount-po-source-so — which sales orders a purchase order was made from,
// in the two fields the office plug-in fills on its own purchase orders:
//
//   UDF_SONo  the order's book number  (908 of 910 plug-in pairs since 2026-06-01)
//   Ref       the order's reference    (897 of 910)
//
// Read off the live book on 2026-09-15 (docs/bugs/0926). The ERP's transfers
// carried neither, and its creates put our own SO numbers in Ref.
//
// SEVERAL ORDERS: a consolidated purchase serves more than one (migration 0235).
// UDF_SONo then names every one of them in the plug-in's ", " form; Ref, which
// holds ONE reference, is left for the book to keep.
// ----------------------------------------------------------------------------
import type { SupabaseClient } from '@supabase/supabase-js';
import { soReference } from '../../services/autocount-writeback';
import { poSourceSoNos } from '../shared/po-transfer-shape';
import { readOrThrow } from './autocount-read';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the client type autocount-outbox.ts hands in (its own Sb)
type Sb = SupabaseClient<any, any, any>;

export type PoSourceSo = { ref: string | null; source_so_no: string | null };

type SoHead = { doc_no: string; ref: string | null; customer_so_no: string | null; linked_ac_docno: string | null };

export async function readPoSourceSo(sb: Sb, poId: string): Promise<PoSourceSo> {
  const items = await readOrThrow('purchase_order_items',
    sb.from('purchase_order_items').select('so_item_id').eq('purchase_order_id', poId));
  const soItemIds = [...new Set(((items as Array<{ so_item_id: string | null }> | null) ?? [])
    .map((r) => r.so_item_id).filter((v): v is string => !!v))];
  if (!soItemIds.length) return { ref: null, source_so_no: null };

  const soLines = await readOrThrow('mfg_sales_order_items',
    sb.from('mfg_sales_order_items').select('doc_no').in('id', soItemIds));
  const docNos = [...new Set(((soLines as Array<{ doc_no: string | null }> | null) ?? [])
    .map((r) => r.doc_no).filter((v): v is string => !!v))];
  if (!docNos.length) return { ref: null, source_so_no: null };

  const heads = ((await readOrThrow('mfg_sales_orders',
    sb.from('mfg_sales_orders').select('doc_no, ref, customer_so_no, linked_ac_docno').in('doc_no', docNos))) as SoHead[] | null) ?? [];
  /* The book's number: a carried-over order is SO-0xxxxx there and HC-SO-0xxxxx
     here; an ERP-made one is the same on both sides. */
  const source_so_no = poSourceSoNos(heads.map((h) => h.linked_ac_docno ?? h.doc_no));
  const ref = heads.length === 1 ? soReference(heads[0]) : null;
  return { ref, source_so_no };
}
