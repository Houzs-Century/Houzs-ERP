/* BUG-51 (Syu 2026-10-05): "Sales Exemption Expiry Date should not change once
   the bill has been processed ... we will refer to it for the original delivery
   date." So it is the FIRST delivery date the order carried: seeded when a date
   first lands (create, or the first PATCH that fills one) and never written
   again. Later edits, amends and the HC Delivery sheet move
   customer_delivery_date only. */
export function exemptionExpirySeed(
  stored: string | null | undefined,
  nextDeliveryDate: string | null | undefined,
): string | null {
  if (stored) return null;
  return nextDeliveryDate || null;
}

/* The "Sales Exemption Expiry Date" an SO shows: the frozen original, else the
   AutoCount book's expiry, else the current customer_delivery_date. The SAME
   chain as frontend/src/lib/so-exemption-expiry.ts (the column on the board and
   the SO list), so the Overdue rule (derivePlanningState) reads what staff see. */
export function soExemptionExpiryOf(header: {
  sales_exemption_expiry: string | null | undefined;
  ac_sales_exemption_expiry: string | null | undefined;
  customer_delivery_date: string | null | undefined;
}): string | null {
  return header.sales_exemption_expiry || header.ac_sales_exemption_expiry || header.customer_delivery_date || null;
}
