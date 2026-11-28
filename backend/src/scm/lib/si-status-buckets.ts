
export const SI_STATUS_BUCKETS: Record<string, string[]> = {
  draft: ['DRAFT'],
  sent: ['SENT', 'OVERDUE'],
  partial: ['PARTIALLY_PAID'],
  paid: ['PAID'],
  cancelled: ['CANCELLED'],
};
