// ----------------------------------------------------------------------------
// journal-document — the document a journal entry was written from, found so
// the entry card can open it (the owner's redesign, batch 6 owner question g3:
// a document's entry is corrected through its document, so its card offers
// "Open <document>" and nothing that posts). An entry names its source by
// NUMBER; the document pages open by id, so the number is read back to its row
// here — one company-scoped read, two for a payment.
//
//   SI / SIPAY      the sales invoice (a payment on an invoice: its invoice)
//   SOPAY / SOCONV  the sales order the payment sits on (it opens by number)
//   PI · API · PV   the purchase invoice, the AP invoice, the voucher
//   CN DN OCN · SCN the customer / other-debtor note, or the supplier's
//   anything else   none — a card settlement, a stock close, a manual journal
// A reversal (…_REVERSAL) opens its original's document. Reads only.
// ----------------------------------------------------------------------------

type Db = any;

export type JournalDocumentKind = 'SI' | 'SO' | 'PI' | 'API' | 'PV' | 'NOTE' | 'SUPPLIER_NOTE';
export type JournalDocument = { kind: JournalDocumentKind; id: string; number: string };
export type JournalDocumentResult = { ok: true; document: JournalDocument | null } | { ok: false; reason: string };

const NONE: JournalDocumentResult = { ok: true, document: null };

/** One row of `table` whose `keyCol` is `key`, in the company. */
async function one(sb: Db, companyId: number, table: string, keyCol: string, key: string, cols: string): Promise<{ ok: true; row: Record<string, unknown> | null } | { ok: false; reason: string }> {
  const { data, error } = await sb.from(table).select(cols).eq('company_id', companyId).eq(keyCol, key).limit(1);
  if (error) return { ok: false, reason: `${table}: ${String(error.message ?? error)}` };
  const rows = Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [];
  return { ok: true, row: rows[0] ?? null };
}

export async function resolveJournalDocument(sb: Db, companyId: number, sourceType: string | null, sourceDocNo: string | null): Promise<JournalDocumentResult> {
  const base = String(sourceType ?? '').replace(/_REVERSAL$/, '');
  const key = sourceDocNo == null ? '' : String(sourceDocNo);
  if (!key) return NONE;

  const byNumber = async (kind: JournalDocumentKind, table: string, col: string): Promise<JournalDocumentResult> => {
    const r = await one(sb, companyId, table, col, key, `id, ${col}`);
    if (!r.ok) return r;
    return { ok: true, document: r.row ? { kind, id: String(r.row.id), number: String(r.row[col] ?? key) } : null };
  };

  switch (base) {
    case 'SI': return byNumber('SI', 'sales_invoices', 'invoice_number');
    case 'PI': return byNumber('PI', 'purchase_invoices', 'invoice_number');
    case 'API': return byNumber('API', 'ap_invoices', 'invoice_number');
    case 'PV': return byNumber('PV', 'payment_vouchers', 'pv_number');
    case 'CN': case 'DN': case 'OCN': return byNumber('NOTE', 'acc_credit_notes', 'note_number');
    case 'SCN': return byNumber('SUPPLIER_NOTE', 'acc_credit_notes', 'note_number');
    case 'SOPAY':
    case 'SOCONV': {
      const pay = await one(sb, companyId, 'mfg_sales_order_payments', 'id', key, 'id, so_doc_no');
      if (!pay.ok) return pay;
      const so = pay.row?.so_doc_no == null ? '' : String(pay.row.so_doc_no);
      return { ok: true, document: so ? { kind: 'SO', id: so, number: so } : null };
    }
    case 'SIPAY': {
      const pay = await one(sb, companyId, 'sales_invoice_payments', 'id', key, 'id, sales_invoice_id');
      if (!pay.ok) return pay;
      const siId = pay.row?.sales_invoice_id == null ? '' : String(pay.row.sales_invoice_id);
      if (!siId) return NONE;
      const si = await one(sb, companyId, 'sales_invoices', 'id', siId, 'id, invoice_number');
      if (!si.ok) return si;
      return { ok: true, document: si.row ? { kind: 'SI', id: siId, number: String(si.row.invoice_number ?? siId) } : null };
    }
    default:
      return NONE;
  }
}
