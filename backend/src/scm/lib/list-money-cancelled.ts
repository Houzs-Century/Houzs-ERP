export const NOT_CANCELLED_OR = 'status.is.null,status.neq.CANCELLED';

/** True when the money tiles must leave cancelled documents out. */
export function moneySkipsCancelled(statusFilter: string | null | undefined): boolean {
  return (statusFilter ?? '').trim().toUpperCase() !== 'CANCELLED';
}
