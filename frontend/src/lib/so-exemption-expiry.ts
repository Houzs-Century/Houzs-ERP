/* ---------------------------------------------------------------------------
   so-exemption-expiry — the "Sales Exemption Expiry Date" cell of a sales order.

   It is the ORIGINAL delivery date: Syu (BUG-51, 2026-10-05) "should not change
   once the bill has been processed ... we will refer to it for the original
   delivery date". The backend now seeds `sales_exemption_expiry` once from the
   first delivery date (backend/src/scm/lib/so-exemption-expiry.ts). Orders
   created in the ERP before that fix never got it, and their original date was
   not kept anywhere, so they fall back to the current `customer_delivery_date`.
   --------------------------------------------------------------------------- */

export type SoExemptionExpiryHeader = {
  sales_exemption_expiry?: string | null;
  customer_delivery_date?: string | null;
};

export function soExemptionExpiryOf(header: SoExemptionExpiryHeader | null | undefined): string | null {
  return header?.sales_exemption_expiry || header?.customer_delivery_date || null;
}
