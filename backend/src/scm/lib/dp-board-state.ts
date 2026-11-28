export function dpBoardState(status: string | null): 'DELIVERED' | 'PENDING_DELIVERY' | 'PENDING_SCHEDULE' {
  if (status === 'COMPLETED' || status === 'DELIVERED') return 'DELIVERED';
  if (status === 'SCHEDULED') return 'PENDING_DELIVERY';
  return 'PENDING_SCHEDULE';
}
