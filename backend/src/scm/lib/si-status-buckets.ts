/* ----------------------------------------------------------------------------
   si-status-buckets — which sales_invoice_status values each list TAB covers.

   THE ONE SOURCE for the status-count queries, the list `status` filter and the
   list's two exports (lib/si-list-read.ts), so a tab, its number and its export
   can never be computed from different ideas of what the tab means. The
   frontend sends the BUCKET NAME; a raw status still works.

   EVERY VALUE IS AN ENUM MEMBER AND EVERY MEMBER IS IN A BUCKET — a non-member
   500s the tab and used to zero its count; a member in no bucket is a row in no
   tab. Pinned, with the 2026-08-17 prod evidence, by
   backend/tests/statusBucketsEnumMembership.test.mjs: ISSUED / PARTIAL /
   COMPLETED were never members (INPUT-only via SI_STATUS_CANON in
   routes/sales-invoices.ts), OVERDUE was bucketless and joins `sent`, as the
   frontend did.

   MOVED 2026-09-15 out of routes/sales-invoices.ts, unchanged, when the list's
   filter moved to lib/si-list-read.ts for the exports — the same move the PI
   and GRN maps made on 2026-08-21.
   ---------------------------------------------------------------------------- */

export const SI_STATUS_BUCKETS: Record<string, string[]> = {
  sent: ['DRAFT', 'SENT', 'OVERDUE'],
  partial: ['PARTIALLY_PAID'],
  paid: ['PAID'],
  cancelled: ['CANCELLED'],
};
