/** Where the New Sales Invoice form goes after a save. An invoice raised from a
 *  delivery order returns to that DO (HC-0127: the operator carries on with the
 *  DO). A failed payment row still lands on the invoice, where it is retried. */
export function siAfterSavePath(invoiceId: string, fromDo: string | null, failedPayments: number): string {
  if (failedPayments > 0) return `/scm/sales-invoices/${invoiceId}?retryPayments=1`;
  if (fromDo) return `/scm/delivery-orders/${encodeURIComponent(fromDo)}`;
  return `/scm/sales-invoices/${invoiceId}`;
}
