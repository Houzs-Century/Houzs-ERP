// ----------------------------------------------------------------------------
// ac-so-payment-edit — what a PAYMENT tells AutoCount: the two header fields a
// payment moves, and nothing else (docs/bugs/0896).
//
// WHY NOT enqueueEdit. A payment used to queue the WHOLE sales order: header,
// every line, every line photograph. A payment changes no line, but composing
// the lines is where an edit is refused — a line with no AutoCount key
// (KeylessLineError), a sofa build the book's one line cannot spell
// (SofaCollapseError) — and where the body outgrows the host's 2 MB limit,
// because the drain attaches every photograph of every line to an edit. So the
// money followed the lines: measured on production 2026-09-14, 4 of the 137
// payments staff recorded since go-live were stranded that way (HC-SO-012025,
// HC-SO-012736 on a sofa; HC-SO-2609-063 "body too large"), while AutoCount's
// balance equalled the value sent on all 124 orders whose edit did land.
//
// WHY HEADER-ONLY IS SAFE IN THE BOOK. AcSyncService's Edit() applies the Header
// keys it is given, then loops over `Lines`; an empty list skips the pre-flight
// and the line loop, and only `Rebuild: true` clears details — which this body
// never sends. The lines, their keys and their photographs stay as they are.
//
// WHAT IT DOES NOT CHANGE. An order not in the book yet (no linked_ac_docno)
// still goes through enqueueEdit, which folds the payment into a pending create
// or correctly says nothing. Anything else an operator edits on the order still
// sends the whole document.
// ----------------------------------------------------------------------------
import type { SupabaseClient } from '@supabase/supabase-js';

import { enqueueAcOp, enqueueEdit } from './autocount-outbox';
import { readSoOutstandingSen, readSoPaymentRefs } from './autocount-read';
import { erpOwnsPaymentText } from './ac-payement-owner';
import { isWritebackEnabled } from './autocount-writeback-flag';
import { acUdfMoney, composePaymentUdf, type ErpPaymentRef } from '../../services/autocount-writeback';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the SCM PostgREST client is untyped at every call site in this tree, the same alias autocount-outbox.ts and autocount-read.ts use.
type Sb = SupabaseClient<any, any, any>;

/** The header columns the balance reader needs, and the link that says the
 *  order is in the book. `readSoOutstandingSen` reads the two totals, the
 *  legacy deposit and the number. */
const SO_PAYMENT_HEADER_COLS = 'doc_no, company_id, total_revenue_sen, local_total_sen, deposit_sen, linked_ac_docno';

export interface SoPaymentEditBody {
  DocType: 'SO';
  DocNo: string;
  Header: { UDF: { BALANCE?: string; PAYEMENT?: string } };
  /** Always empty: the host's line loop does nothing, so no line is touched. */
  Lines: [];
}

/**
 * The /edit body for a payment. Pure.
 *
 * The same two rules the full header keeps (so-edit-header.ts): BALANCE goes
 * as "0.00" when settled and is omitted only when the ERP has no total to
 * compute it from; PAYEMENT is omitted when no payment carries a reference, so
 * the cutover's own text is not blanked. Null when neither field has anything
 * to say — there is then nothing to send.
 */
export function composeSoPaymentEdit(
  acDocNo: string,
  outstandingSen: number | null,
  paymentRefs: readonly ErpPaymentRef[],
): SoPaymentEditBody | null {
  const udf: { BALANCE?: string; PAYEMENT?: string } = {};
  const balance = acUdfMoney(outstandingSen);
  if (balance != null) udf.BALANCE = balance;
  const payement = composePaymentUdf(paymentRefs);
  if (payement) udf.PAYEMENT = payement;
  if (udf.BALANCE == null && udf.PAYEMENT == null) return null;
  return { DocType: 'SO', DocNo: acDocNo, Header: { UDF: udf }, Lines: [] };
}

/**
 * Queue the payment's balance and references for AutoCount.
 *
 * Never throws, and a failure to queue never fails the payment — the outbox's
 * founding property. A read that fails falls back to the whole-document edit,
 * so this path can only ever do better than the one it replaces.
 */
export async function enqueueSoPaymentEdit(
  sb: Sb,
  opts: {
    companyId: number | null | undefined;
    docNo: string;
    createdBy: number | null;
  },
): Promise<boolean> {
  const fallback = () => enqueueEdit(sb, { companyId: opts.companyId, docType: 'SO', docNo: opts.docNo, createdBy: opts.createdBy });
  try {
    if (opts.companyId == null) return false;
    if (!(await isWritebackEnabled(sb, opts.companyId))) return false;

    const { data, error } = await sb.from('mfg_sales_orders')
      .select(SO_PAYMENT_HEADER_COLS)
      .eq('doc_no', opts.docNo)
      .eq('company_id', opts.companyId)
      .maybeSingle();
    if (error) return await fallback();
    const h = data as Record<string, unknown> | null;
    if (!h) return false;
    /* Not in the book yet: a pending create takes the payment into its own
       payload, and an order the write-back never sent has nothing to edit.
       enqueueEdit already decides both. */
    if (!h.linked_ac_docno) return await fallback();

    const [outstandingSen, paymentRefs] = await Promise.all([
      readSoOutstandingSen(sb, h),
      readSoPaymentRefs(sb, opts.docNo),
    ]);
    /* A carried-over order's payment text is the office's; BALANCE alone goes (docs/bugs/0934). */
    const body = composeSoPaymentEdit(String(h.linked_ac_docno), outstandingSen, erpOwnsPaymentText(h.linked_ac_docno) ? paymentRefs : []);
    if (!body) return false;

    return await enqueueAcOp(sb, {
      companyId: opts.companyId,
      op: 'edit',
      docType: 'SO',
      docNo: opts.docNo,
      payload: {
        body: body as unknown as Record<string, unknown>,
        selfDoc: { table: 'mfg_sales_orders', keyCol: 'doc_no', key: opts.docNo },
      },
      /* NULL, as every edit: two payments are two intents, applied in order. */
      dedupeKey: null,
      createdBy: opts.createdBy,
    });
  } catch {
    return await fallback();
  }
}
