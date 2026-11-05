/** Where the New Sales Invoice form goes after a save. An invoice raised from a
 *  delivery order or sales order returns to that document (HC-0127: the
 *  operator carries on with it). A failed payment row still lands on the
 *  invoice, where it is retried. `sourcePath` is null for a plain invoice. */
export function siAfterSavePath(invoiceId: string, fromDo: string | null, failedPayments: number, sourcePath: string | null): string {
  if (failedPayments > 0) return `/scm/sales-invoices/${invoiceId}?retryPayments=1`;
  if (fromDo) return `/scm/delivery-orders/${encodeURIComponent(fromDo)}`;
  return sourcePath ?? `/scm/sales-invoices/${invoiceId}`;
}
