// ----------------------------------------------------------------------------
// scm/lib/do-ship-atomic — the shapes and answers of an all-or-nothing DO ship.
//
// DO_SHIP_MODE=atomic (lib/stock-post-tx.ts): the status write and the ship's
// stock writes (the OUT rows, which fire the FIFO trigger, and the rack
// STOCK_OUT rows) commit together or not at all. HC-DO-2610-319 shipped with 4
// lines and no OUT because they were separate PostgREST calls. The transaction
// itself runs in routes/delivery-orders-mfg.ts (shipDoAtomically), beside the
// deduction it wraps; this file holds what does not need the route, which sits
// near its size ceiling.
// ----------------------------------------------------------------------------

import { scopeToCompanyId } from './companyScope';
import { hasUnreadableLines, LINES_UNREADABLE, linesUnreadableMessage } from './failed-read-refusal';
import { STOCK_TX_ROLLED_BACK, stockTxFailureBody, type StockTxClient } from './stock-post-tx';
import type { writeMovements } from './inventory-movements';

type Db = Parameters<typeof writeMovements>[0];

/** After-commit work of a ship. null = this call wrote nothing (already shipped, migrated, refused). */
export type DoShipTail = { deliveryOrderId: string; companyId: number | null; wroteOut: boolean } | null;

export type DoShipFailure = { ok: false; reason: string; status?: number; detail?: string };

/** The status write inside the ship's transaction; null data never reaches here. */
export type DoShipFlip = (tx: StockTxClient) => Promise<{ ok: true; data: { id: string; status: string } } | DoShipFailure>;

export const DO_OVER_DELIVERY_MESSAGE = 'This delivery would ship more than the Sales Order ordered — another DO already covers it. Refresh and check the Sales Order.';

/** The deduction reported errors: inside the transaction that is a rollback, never a half ship. */
export function doShipCoreFailure(errors: string[]): DoShipFailure {
  return {
    ok: false,
    reason: hasUnreadableLines(errors) ? LINES_UNREADABLE : STOCK_TX_ROLLED_BACK,
    status: 503,
    detail: errors.join('; '),
  };
}

/** The answer for a ship whose transaction rolled back. Nothing was written. */
export function doShipFailureResponse(f: { reason: string; detail?: string }): { body: object; status: 409 | 500 | 503 } {
  if (f.reason === 'over_delivery') return { body: { error: 'over_delivery', message: DO_OVER_DELIVERY_MESSAGE, reason: f.detail }, status: 409 };
  if (f.reason === 'status_changed') return { body: { error: 'status_changed', reason: 'This delivery order just changed. Reload it and try again.' }, status: 409 };
  if (f.reason === 'update_failed') return { body: { error: 'update_failed', reason: f.detail }, status: 500 };
  if (f.reason === LINES_UNREADABLE) {
    return { body: { error: LINES_UNREADABLE, message: linesUnreadableMessage('the delivery order lines', 'shipped'), reverted: true }, status: 503 };
  }
  return { body: stockTxFailureBody('shipped', f), status: 503 };
}

/**
 * Create-as-confirmed inserts the DO as LOADED before its ship runs. When the
 * ship's transaction rolled back, no stock moved, so the DO goes back to DRAFT
 * (over the LOADED this request wrote, and nothing else) and the operator is sent
 * to it: a retry of the CREATE would make a second DO.
 */
export async function keepCreatedDoAsDraft(
  sb: Db, doId: string, companyId: number, doNo: string, f: { reason: string; detail?: string },
): Promise<object> {
  let reverted = false;
  try {
    const { data, error } = (await scopeToCompanyId(
      sb.from('delivery_orders').update({ status: 'DRAFT', updated_at: new Date().toISOString() }).eq('id', doId), companyId,
    ).eq('status', 'LOADED').select('id').maybeSingle()) as { data: unknown; error: unknown };
    reverted = !error && !!data;
  } catch { /* reported below */ }
  return {
    error: f.reason,
    message: reverted
      ? `Nothing was shipped: the stock change was rolled back. ${doNo} was kept as a DRAFT: open it and confirm it again.`
      : `Nothing was shipped: the stock change was rolled back, and ${doNo} could not be put back to DRAFT. Reload it before doing anything else.`,
    reverted,
    ...(f.detail ? { detail: f.detail } : {}),
  };
}
