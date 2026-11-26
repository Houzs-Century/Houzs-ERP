export function exemptionExpirySeed(
  stored: string | null | undefined,
  nextDeliveryDate: string | null | undefined,
): string | null {
  if (stored) return null;
  return nextDeliveryDate || null;
}

export function soExemptionExpiryOf(header: {
  sales_exemption_expiry: string | null | undefined;
  ac_sales_exemption_expiry: string | null | undefined;
  customer_delivery_date: string | null | undefined;
}): string | null {
  return header.sales_exemption_expiry || header.ac_sales_exemption_expiry || header.customer_delivery_date || null;
}
