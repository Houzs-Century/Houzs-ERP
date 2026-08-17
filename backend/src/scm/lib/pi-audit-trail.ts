// ----------------------------------------------------------------------------
// pi-audit-trail — the purchase invoice's audit vocabulary and its two writers.
//
// Extracted from routes/purchase-invoices.ts VERBATIM (2026-08-17), same reason
// and same rule as pi-money-rollups: mechanical plumbing, nothing asserts it
// lives in the router, and no guard moved. Both writers are fail-open by design
// (an audit row must never be the thing that refuses a legitimate write), which
// is the opposite contract from the guards that stayed behind.
// ----------------------------------------------------------------------------

import type { Variables } from '../env';
import { recordEntityAudit, compactChanges, fieldChange } from '../lib/entity-audit';

/* ── Audit trail (migration 0139 / lib/entity-audit) ───────────────────────────
   Action vocabulary for this module:
     POST   — DRAFT -> POSTED. The AP liability is booked (Dr Inventory / Cr
              Payables) and the GRN lines are consumed.
     CANCEL — status -> CANCELLED (the document event).
     REVERSE— the AP/GL contra that follows a cancel (the LEDGER event), kept
              apart from the CANCEL for the same reason payment-vouchers keeps
              them apart: a reversal that FAILED must be visible as such.
     UPDATE — header edits and payments.
   No DELETE: this module never hard-deletes an invoice. */
export const PI_AUDIT_FIELDS: Array<[string, string]> = [
  ['supplierId', 'supplier_id'], ['supplierInvoiceRef', 'supplier_invoice_ref'],
  ['invoiceDate', 'invoice_date'], ['dueDate', 'due_date'],
  ['currency', 'currency'], ['notes', 'notes'],
  ['exchangeRate', 'exchange_rate'],
];

/* CREATE was added after the post/payment/cancel/header pass, and it is recorded
   LATE for a reason. All three create paths write the header first and DELETE it
   again — on a failed line insert, and again when the post-insert over-invoice
   re-verification finds this PI would over-bill a GRN line. A CREATE row emitted
   at insert time would describe an invoice that never existed, against a GRN
   whose invoiced_qty never moved. recordPiCreate re-reads the persisted row
   rather than echoing the payload, which makes that ordering self-enforcing: a
   rolled-back header reads back as nothing and no row is written.

   The line vocabulary lives in lib/entity-audit-fields (imported above) — the
   camelCase half is what AUDIT_FINANCE_FIELDS gates on and needs a test that can
   import it without dragging Hono along. */

/* The PI's identity for an audit row written from a LINE handler, which has the
   line in hand but not the parent. Best-effort by design: the writer is
   fail-open, so an unresolved doc number costs the row its human key and
   nothing else. */
export async function loadPiAuditMeta(
  sb: Variables['supabase'],
  piId: string,
): Promise<{ docNo: string | null; companyId: number | null; status: string | null }> {
  try {
    const { data } = await sb.from('purchase_invoices')
      .select('invoice_number, company_id, status').eq('id', piId).maybeSingle();
    const row = (data ?? null) as { invoice_number?: string | null; company_id?: number | null; status?: string | null } | null;
    return { docNo: row?.invoice_number ?? null, companyId: row?.company_id ?? null, status: row?.status ?? null };
  } catch {
    return { docNo: null, companyId: null, status: null };
  }
}

/**
 * Record the CREATE of a PI that has SURVIVED its handler.
 *
 * Reads the row back rather than taking the caller's payload: the doc number is
 * minted server-side, the currency and exchange rate are resolved server-side,
 * the totals come off the lines — and a header a compensating branch already
 * deleted reads back as nothing, so this cannot write a CREATE row for an
 * invoice that was rolled back.
 */
export async function recordPiCreate(
  sb: Variables['supabase'],
  actor: Variables['houzsUser'],
  fallbackCompanyId: number | null | undefined,
  piId: string,
  lineCount: number,
  note?: string,
): Promise<void> {
  let row: Record<string, unknown> | null = null;
  try {
    const { data } = await sb.from('purchase_invoices')
      .select('id, invoice_number, status, company_id, supplier_id, supplier_invoice_ref, ' +
        'purchase_order_id, grn_id, invoice_date, due_date, currency, exchange_rate, total_centi')
      .eq('id', piId).maybeSingle();
    row = (data ?? null) as Record<string, unknown> | null;
  } catch { /* best-effort */ }
  if (!row) return; // rolled back (or unreadable): a CREATE row here would be a lie
  await recordEntityAudit(sb, {
    entityType: 'PURCHASE_INVOICE',
    entityId: piId,
    entityDocNo: (row.invoice_number as string | null) ?? null,
    action: 'CREATE',
    actor,
    companyId: (row.company_id as number | null) ?? fallbackCompanyId,
    statusSnapshot: (row.status as string | null) ?? null,
    note,
    fieldChanges: compactChanges([
      fieldChange('status', null, row.status ?? null),
      fieldChange('supplierId', null, row.supplier_id ?? null),
      fieldChange('supplierInvoiceRef', null, row.supplier_invoice_ref ?? null),
      fieldChange('purchaseOrderId', null, row.purchase_order_id ?? null),
      fieldChange('grnId', null, row.grn_id ?? null),
      fieldChange('invoiceDate', null, row.invoice_date ?? null),
      fieldChange('dueDate', null, row.due_date ?? null),
      fieldChange('currency', null, row.currency ?? null),
      fieldChange('exchangeRate', null, row.exchange_rate ?? null),
      /* INTEGER SEN, straight off the column. */
      fieldChange('totalCenti', null, row.total_centi ?? null),
      fieldChange('lineCount', null, lineCount),
    ]),
  });
}
