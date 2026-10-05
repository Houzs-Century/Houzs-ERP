/* ---------------------------------------------------------------------------
   so-exemption-expiry — the "Sales Exemption Expiry Date" cell of a sales order.

   This book keeps the delivery date the salesperson entered in AutoCount's
   SalesExemptionExpiryDate (owner 2026-08-16). `sales_exemption_expiry` is a
   copy of that field and only the AutoCount importers write it, so an order
   created in the ERP leaves it NULL even though the writeback sends AutoCount
   `customer_delivery_date` for it (so-edit-header.ts, autocount-writeback.ts).
   BUG-51: HC11494 / HC-SO-2609-081 showed a blank cell while AutoCount held
   2026-10-03. `customer_delivery_date` is never overwritten by an amend, so it
   is the original date the cell is meant to show.
   --------------------------------------------------------------------------- */

export type SoExemptionExpiryHeader = {
  sales_exemption_expiry?: string | null;
  customer_delivery_date?: string | null;
};

export function soExemptionExpiryOf(header: SoExemptionExpiryHeader | null | undefined): string | null {
  return header?.sales_exemption_expiry || header?.customer_delivery_date || null;
}
