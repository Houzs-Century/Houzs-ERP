// Where a manual DP job (supplier pickup, transfer, set-up, lorry service) stands on
// the Delivery Planning board. The crew's Complete writes COMPLETED
// (routes/delivery-job-progress.ts); DELIVERED is the board's word for it.
export function dpBoardState(status: string | null): 'DELIVERED' | 'PENDING_DELIVERY' | 'PENDING_SCHEDULE' {
  if (status === 'COMPLETED' || status === 'DELIVERED') return 'DELIVERED';
  if (status === 'SCHEDULED') return 'PENDING_DELIVERY';
  return 'PENDING_SCHEDULE';
}
