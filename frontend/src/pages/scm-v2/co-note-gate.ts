import { TERMINAL as SO_TERMINAL_STATUSES } from '../../vendor/scm/lib/so-status';

export function canCreateConsignmentNote(row: { status: string; has_undelivered?: boolean }): boolean {
  if (SO_TERMINAL_STATUSES.has(row.status)) return false;
  return row.has_undelivered !== false;
}
