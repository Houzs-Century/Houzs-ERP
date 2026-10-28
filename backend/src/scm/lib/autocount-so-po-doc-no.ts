// ----------------------------------------------------------------------------
// autocount-so-po-doc-no — the sales order's "PO Doc No." (SO.UDF_ToPONo) names
// the purchase orders made from it, the way the office plug-in writes it.
//
// Plug-in shape, read off the live book on 2026-09-15: the purchase order numbers,
// ", "-joined when one order made several (264 separators seen, every one ", "),
// in an nvarchar(500). The ERP wrote the order's reference there instead
// (docs/bugs/0926); this is the part that puts our purchase order numbers back.
//
// WHEN. After a purchase order made from sales orders reaches the book (create_po,
// so_to_po) and after one is cancelled there, each of its source orders gets a
// header-only edit carrying the field and nothing else.
//
// THE VALUE. The book numbers of the purchase orders the ERP links to the order
// through its lines (purchase_order_items.so_item_id) that are not cancelled and
// are already in the book. Checked against the book for the 558 orders the ERP had
// written the reference into: where the field held purchase order numbers before,
// this list equals them on 102 of 103 orders and adds one on the last.
//
// NONE LEFT. After a cancel the field is cleared, because the number there is one
// the ERP put in. After a create there is always at least the one just made.
// ----------------------------------------------------------------------------
import type { SupabaseClient } from '@supabase/supabase-js';
import type { EnqueueInput } from './autocount-outbox';
import { readOrThrow } from './autocount-read';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the client type autocount-outbox.ts hands in (its own Sb)
type Sb = SupabaseClient<any, any, any>;

/** SO.UDF_ToPONo is nvarchar(500) in the live book (INFORMATION_SCHEMA, 2026-09-15). */
export const AC_PO_DOC_NO_MAX = 500;

/** Sorted, de-duplicated, ", "-joined; whole numbers only, stopping before 500 characters. */
export function joinPoDocNos(nos: readonly (string | null | undefined)[]): string {
  const uniq = [...new Set(nos.map((n) => String(n ?? '').trim()).filter((n) => n !== ''))].sort();
  let out = '';
  for (const n of uniq) {
    const next = out ? `${out}, ${n}` : n;
    if (next.length > AC_PO_DOC_NO_MAX) break;
    out = next;
  }
  return out;
}

/** The book numbers of the order's live purchase orders that AutoCount already holds. */
export async function readSoPoDocNos(sb: Sb, companyId: number, soDocNo: string): Promise<string[]> {
  const lines = ((await readOrThrow('mfg_sales_order_items',
    sb.from('mfg_sales_order_items').select('id').eq('company_id', companyId).eq('doc_no', soDocNo))) as Array<{ id: string }> | null) ?? [];
  if (!lines.length) return [];
  const poLines = ((await readOrThrow('purchase_order_items',
    sb.from('purchase_order_items').select('purchase_order_id').in('so_item_id', lines.map((l) => l.id)))) as Array<{ purchase_order_id: string | null }> | null) ?? [];
  const poIds = [...new Set(poLines.map((l) => l.purchase_order_id).filter((v): v is string => !!v))];
  if (!poIds.length) return [];
  const pos = ((await readOrThrow('purchase_orders',
    sb.from('purchase_orders').select('status, linked_ac_docno').eq('company_id', companyId).in('id', poIds))) as Array<{ status: string | null; linked_ac_docno: string | null }> | null) ?? [];
  return pos
    .filter((p) => String(p.status ?? '').toUpperCase() !== 'CANCELLED' && !!p.linked_ac_docno)
    .map((p) => String(p.linked_ac_docno));
}

export interface SoPoDocNoEditBody {
  DocType: 'SO';
  DocNo: string;
  Header: { UDF: { ToPONo: string } };
  /** Always empty: the host's line loop does nothing, so no line is touched. */
  Lines: [];
}

export function composeSoPoDocNoEdit(acDocNo: string, poDocNos: string): SoPoDocNoEditBody {
  return { DocType: 'SO', DocNo: acDocNo, Header: { UDF: { ToPONo: poDocNos } }, Lines: [] };
}

const PO_EVENTS: ReadonlySet<string> = new Set(['create_po', 'so_to_po', 'cancel']);

/** enqueueAcOp, passed in: this runs FROM the outbox module's dispatch. */
export type PoDocNoEnqueue = (input: EnqueueInput) => Promise<boolean>;

/**
 * After a purchase order's create, transfer or cancel is marked sent: queue the
 * PO Doc No. of each sales order it was made from. Returns how many were queued.
 * Best effort; the purchase order row is already sent.
 */
export async function queueSoPoDocNos(
  sb: Sb,
  sent: { company_id: number; op: string; doc_type: string; doc_no: string; doc_id: string | null },
  enqueue: PoDocNoEnqueue,
): Promise<number> {
  if (sent.doc_type !== 'PO' || !PO_EVENTS.has(sent.op) || !sent.doc_id) return 0;
  try {
    const poLines = ((await readOrThrow('purchase_order_items',
      sb.from('purchase_order_items').select('so_item_id').eq('purchase_order_id', sent.doc_id))) as Array<{ so_item_id: string | null }> | null) ?? [];
    const soItemIds = [...new Set(poLines.map((l) => l.so_item_id).filter((v): v is string => !!v))];
    if (!soItemIds.length) return 0;
    const soLines = ((await readOrThrow('mfg_sales_order_items',
      sb.from('mfg_sales_order_items').select('doc_no').eq('company_id', sent.company_id).in('id', soItemIds))) as Array<{ doc_no: string | null }> | null) ?? [];
    const soDocNos = [...new Set(soLines.map((l) => l.doc_no).filter((v): v is string => !!v))];

    let queued = 0;
    for (const soDocNo of soDocNos) {
      const so = (await readOrThrow('mfg_sales_orders',
        sb.from('mfg_sales_orders').select('doc_no, status, linked_ac_docno').eq('company_id', sent.company_id).eq('doc_no', soDocNo).maybeSingle())) as
        { doc_no: string; status: string | null; linked_ac_docno: string | null } | null;
      if (!so?.linked_ac_docno || String(so.status ?? '').toUpperCase() === 'CANCELLED') continue;
      const poDocNos = joinPoDocNos(await readSoPoDocNos(sb, sent.company_id, soDocNo));
      if (!poDocNos && sent.op !== 'cancel') continue;
      const ok = await enqueue({
        companyId: sent.company_id,
        op: 'edit',
        docType: 'SO',
        docNo: soDocNo,
        payload: {
          body: composeSoPoDocNoEdit(so.linked_ac_docno, poDocNos) as unknown as Record<string, unknown>,
          selfDoc: { table: 'mfg_sales_orders', keyCol: 'doc_no', key: soDocNo },
        },
        /* NULL, as every edit: two purchase orders are two changes, applied in order. */
        dedupeKey: null,
        createdBy: null,
      });
      if (ok) queued += 1;
    }
    return queued;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(`[autocount-outbox] PO Doc No. of the orders behind ${sent.doc_no} not queued:`, e instanceof Error ? e.message : String(e));
    return 0;
  }
}
