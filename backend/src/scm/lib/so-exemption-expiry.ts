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
