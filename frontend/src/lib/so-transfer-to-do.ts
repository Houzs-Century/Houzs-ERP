import { soCanRaiseDo } from "../vendor/shared/so-deliverable-states";

/** May "Transfer to Delivery Order" be offered on this Sales Order list row?
 *
 *  The status rule (soCanRaiseDo) AND something still left to deliver. Conts
 *  #699: a fully delivered order was offered the action and it opened an empty
 *  DO form. `has_undelivered` is the list's live reading (lib/so-list-rows.ts:
 *  remaining = qty - delivered + returned, cancelled DOs excluded), the same
 *  numbers the DO line picker uses, so it re-opens after a DO is cancelled or
 *  goods come back. Absent (a worker that predates the field) reads as "yes",
 *  so the action is never hidden on a missing value. */
export function soOffersTransferToDo(row: {
  status?: string | null;
  on_hold?: boolean | null;
  has_undelivered?: boolean | null;
}): boolean {
  return soCanRaiseDo(row.status, row.on_hold ?? null) && row.has_undelivered !== false;
}
