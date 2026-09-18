// ----------------------------------------------------------------------------
// si-payment-row — the factored insert core of POST /sales-invoices/:id/payments,
// with the column list that belongs to it.
//
// The same split so-payment-row.ts records for the SO side: the file-size
// ratchet holds routes/sales-invoices.ts to "may only shrink", so the payment
// row's derivation + insert live below the route layer. Moved verbatim apart
// from the imports — a split the ratchet asks for, not a redesign. The legacy
// quick-pay endpoint's minimal cash insert stays in-route on purpose: it
// derives nothing.
// ----------------------------------------------------------------------------

import { createReceiptForPayment } from '../../acc/receipts';
import { companyCodeById } from './doc-no';

export const SI_PAYMENT_COLS =
  'id, sales_invoice_id, paid_at, method, merchant_provider, installment_months, ' +
  'online_type, approval_code, amount_sen, account_sheet, collected_by, note, ' +
  'created_at, created_by';

export type SiPaymentRowInput = {
  salesInvoiceId: string;
  companyId: number | null | undefined;
  paidAt: string;
  method: string;
  merchantProvider?: string | null;
  installmentMonths?: number | null;
  onlineType?: string | null;
  approvalCode?: string | null;
  amountSen: number;
  accountSheet?: string | null;
  collectedBy?: string | null;
  note?: string | null;
  createdBy: string;
};

/** Method-scoped field derivation + the insert, exactly as the route wrote it:
    merchant/installment keep provider + months, transfer keeps the online
    sub-type, cash keeps nothing. Returns supabase's { data, error } shape. */
export async function insertSiPaymentRow(sb: any, p: SiPaymentRowInput) {
  const merchantLike      = p.method === 'merchant' || p.method === 'installment';
  const merchantProvider  = merchantLike ? (p.merchantProvider ?? null) : null;
  const installmentMonths = merchantLike
    ? (typeof p.installmentMonths === 'number' && p.installmentMonths > 0 ? p.installmentMonths : null)
    : null;
  const onlineType        = p.method === 'transfer' ? (p.onlineType ?? null) : null;

  const res = await sb.from('sales_invoice_payments').insert({
    // The ACTIVE company, proven to be the invoice's by the caller's scoped read.
    company_id:         p.companyId,
    sales_invoice_id:   p.salesInvoiceId,
    paid_at:            p.paidAt,
    method:             p.method,
    merchant_provider:  merchantProvider,
    installment_months: installmentMonths,
    online_type:        onlineType,
    approval_code:      p.approvalCode ?? null,
    amount_sen:       p.amountSen,
    account_sheet:      p.accountSheet ?? null,
    collected_by:       p.collectedBy ?? null,
    note:               p.note ?? null,
    created_by:         p.createdBy,
  }).select(SI_PAYMENT_COLS).single();

  /* The Official Receipt is born with the payment (GL redesign item 9) —
     DRAFT for card/transfer, formal at once for cash. BEST-EFFORT: the money
     is recorded; a receipt hiccup must never un-record it, and
     ensureReceiptForPayment heals the gap at the next print. */
  if (!res.error) {
    try {
      const paymentId = String((res.data as { id?: unknown } | null)?.id ?? '');
      const code = p.companyId != null ? await companyCodeById(sb, p.companyId) : null;
      if (paymentId && p.companyId != null && code) {
        await createReceiptForPayment(sb, {
          source: 'SIPAY', paymentId, companyId: p.companyId, companyCode: code,
          docNo: p.salesInvoiceId, method: p.method, amountSen: p.amountSen,
          paidAt: String(p.paidAt ?? '').slice(0, 10) || null, createdBy: p.createdBy ?? null,
        });
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[receipts] draft OR not created for SI payment:', e);
    }
  }
  return res;
}
