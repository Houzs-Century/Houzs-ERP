
import type { Variables } from '../env';
import { recordEntityAudit, compactChanges, fieldChange } from '../lib/entity-audit';

export const PI_AUDIT_FIELDS: Array<[string, string]> = [
  ['supplierId', 'supplier_id'], ['supplierInvoiceRef', 'supplier_invoice_ref'],
  ['invoiceDate', 'invoice_date'], ['dueDate', 'due_date'],
  ['currency', 'currency'], ['notes', 'notes'],
  ['exchangeRate', 'exchange_rate'],
];


export async function loadPiAuditMeta(
  sb: Variables['supabase'],
  piId: string,
): Promise<{ docNo: string | null; companyId: number | null; status: string | null }> {
  try {
    const { data, error } = await sb.from('purchase_invoices')
      .select('invoice_number, company_id, status').eq('id', piId).maybeSingle();
    if (error) {
      /* eslint-disable-next-line no-console */
      console.error('[pi-audit] meta read failed — audit row loses its doc number:', piId, error.message);
    }
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
    const { data, error } = await sb.from('purchase_invoices')
      .select('id, invoice_number, status, company_id, supplier_id, supplier_invoice_ref, ' +
        'purchase_order_id, grn_id, invoice_date, due_date, currency, exchange_rate, total_sen')
      .eq('id', piId).maybeSingle();
    if (error) {
      /* eslint-disable-next-line no-console */
      console.error('[pi-audit] CREATE read-back failed — no CREATE row for this invoice:', piId, error.message);
    }
    row = (data ?? null) as Record<string, unknown> | null;
  } catch { }
  if (!row) return;
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
      fieldChange('totalSen', null, row.total_sen ?? null),
      fieldChange('lineCount', null, lineCount),
    ]),
  });
}
