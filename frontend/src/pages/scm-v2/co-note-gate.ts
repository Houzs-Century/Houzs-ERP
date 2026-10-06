/* May a Consignment Note be raised from this Consignment Order?

   The CO list GET never stamps `has_undelivered` (only the Sales Order list
   helper, so-list-rows.ts, computes it), so a gate written as
   `!row.has_undelivered` refused EVERY order: the right-click "Create
   Consignment Note" always answered "Nothing to be converted". A missing flag
   means "not known", not "nothing left" — only an explicit false, or a status
   that cannot proceed, blocks the note. The New Note page re-derives the
   deliverable balance from the lines, so letting an unknown through is safe. */
const CO_NOTE_BLOCKED_STATUSES = new Set(['CANCELLED', 'CLOSED', 'ON_HOLD']);

export function canCreateConsignmentNote(row: { status: string; has_undelivered?: boolean }): boolean {
  if (CO_NOTE_BLOCKED_STATUSES.has(row.status)) return false;
  return row.has_undelivered !== false;
}
