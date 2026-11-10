/* What a delivery order does when a read in front of its stock write fails.
 * Kept out of routes/delivery-orders-mfg.ts, which sits at its size ceiling.
 * The rule is lib/failed-read-refusal.ts: a failed read is not an empty list.
 *
 * Two cases, because the two writers sit at different points:
 *
 *   SHIP (PATCH /:id/status). The status flip lands BEFORE deductInventoryForDo
 *   reads the lines (the flip is the CAS that stops a double ship). If that read
 *   fails, the DO would stay LOADED/DISPATCHED with no stock OUT. The flip is
 *   put back, over the status this request wrote and nothing else, so the
 *   operator sees the DO where it was and can confirm again.
 *
 *   RESYNC (a line edit on an already-shipped DO). The edit has committed; the
 *   delta is best-effort by design. A failed read used to look like "no lines"
 *   (delta = return every unit shipped) or "no movements" (delta = ship it all
 *   again). Now it writes nothing and leaves the same RECOUNT_FAILED trail a
 *   failed delta write leaves. */
import { recordEntityAudit } from './entity-audit';
import { scopeToCompanyId } from './companyScope';
import { LINES_UNREADABLE, linesUnreadableMessage } from './failed-read-refusal';

type PgError = { message?: string | null } | null | undefined;

/* The columns the ship flip stamps that a pre-ship DO does not have yet. The
   first ship always leaves a pre-ship status (deductInventoryForDo no-ops on a
   DO that already wrote its OUT), so null is the value they held before. */
const SHIP_STAMPS = ['dispatched_at', 'departure_at', 'signed_at', 'delivered_at'] as const;

export async function revertShipOnUnreadLines(
  sb: any, // eslint-disable-line @typescript-eslint/no-explicit-any -- the route's untyped client
  doId: string,
  companyId: number,
  wroteStatus: string,
  prevStatus: string,
  stamped: Record<string, unknown>,
  prevCustomerDeliveredDate: string | null,
  movementErrors: string[],
  /* Set by the create paths: the DO they made is kept as a DRAFT, and a retry of
     the CREATE would make a second one, so the operator is sent to that draft. */
  keptAsDraftDocNo: string | null,
) {
  const back: Record<string, unknown> = { status: prevStatus, updated_at: new Date().toISOString() };
  for (const k of SHIP_STAMPS) if (k in stamped) back[k] = null;
  if ('customer_delivered_date' in stamped) back.customer_delivered_date = prevCustomerDeliveredDate;
  const { data, error } = await scopeToCompanyId(
    sb.from('delivery_orders').update(back).eq('id', doId), companyId,
  ).eq('status', wroteStatus).select('id').maybeSingle();
  const reverted = !error && !!data;
  return {
    error: LINES_UNREADABLE,
    message: reverted && keptAsDraftDocNo
      ? `Could not read the delivery order lines, so no stock was moved. ${keptAsDraftDocNo} was kept as a DRAFT: open it and confirm it again.`
      : reverted
      ? linesUnreadableMessage('the delivery order lines', 'shipped')
      : 'Could not read the delivery order lines, so no stock was moved, and the status could not be put back. Reload the delivery order before doing anything else.',
    reverted,
    movementErrors,
    ...(error ? { revertError: error.message } : {}),
  };
}

export async function noteResyncReadFailure(
  sb: any, // eslint-disable-line @typescript-eslint/no-explicit-any -- the route's untyped client
  doId: string,
  doHeader: { do_number?: string | null; company_id?: number | null },
  what: string,
  err: PgError,
): Promise<void> {
  const note = `could not read ${what} (${err?.message ?? 'unknown read error'}), so no delta was written`;
  /* eslint-disable-next-line no-console */
  console.error(`[do-resync] DO ${doId}: ${note}`);
  try {
    await recordEntityAudit(sb, {
      entityType: 'DELIVERY_ORDER',
      entityId: doId,
      entityDocNo: doHeader.do_number ?? null,
      action: 'RECOUNT_FAILED',
      companyId: doHeader.company_id ?? null,
      source: 'resyncInventoryForDo',
      note: `Line edit committed on a shipped DO but ${note}. The ledger does not reflect this edit until a re-save repairs it.`,
    });
  } catch { /* the console line above still stands */ }
}
