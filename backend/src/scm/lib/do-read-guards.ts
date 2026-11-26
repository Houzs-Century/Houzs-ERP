import { recordEntityAudit } from './entity-audit';
import { scopeToCompanyId } from './companyScope';
import { LINES_UNREADABLE, linesUnreadableMessage } from './failed-read-refusal';

type PgError = { message?: string | null } | null | undefined;

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
  } catch { }
}
