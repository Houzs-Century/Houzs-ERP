/* Delivery Planning — the inline edits the NON-SO job types allow (owner
   2026-10-29: the DP manual jobs and the service-case rows must be adjustable
   like SO rows — message, date, driver/lorry/helper).
   SO/DO keep their own rich paths in the route; crew for DP (on a trip) and ASSR
   is the trip / schedule machinery already there. What lives here is the small,
   type-specific rest that would otherwise bloat the router past its size ceiling:
     · a DP job's DATE   → scm.dp_orders.requested_date (+ the trip's date when it
                           rides one), company-bounded to the caller's companies.
     · a DP / ASSR row's MESSAGE status → scm.dp_orders.delivery_message_status,
                           or public.assr_cases.delivery_message_status (c.env.DB,
                           the plane the ASSR board union reads). For a service
                           case the Service-Arrangement WhatsApp reply still
                           overlays its own value when the customer has answered,
                           so a hand-set status shows until then (owner-accepted). */
import { scopeToAllowedCompanies } from './companyScope';
import { dateOrNull } from './date-coerce';
import { assrOpenCaseGuardSql } from './assr-board-scope';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Hono ctx / the untyped scm PostgREST client, as elsewhere in this route
type Ctx = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sb = any;

export type EditResult = { status: 200 | 400 | 404 | 500; body: Record<string, unknown> };

/* The HcFieldsResult shape the frontend expects, for a write that is neither SO
   nor DO (nothing lands on a delivery order). */
const OK_FIELDS = { ok: true, written: { so: false, do: false }, do_id: null, so_doc_no: null, no_do_hint: null } as const;

/* The board's inline DATE edit on a DP (manual job) row. Date-only: crew is the
   trip's, assigned through PATCH /trips/:id (an already-scheduled job) or
   POST /dp-orders/:id/schedule (a pending one). Moving the trip date is
   best-effort — the requested_date has already saved, so a trip-date failure
   never rolls the date back (the SO/ASSR trip wiring follows the same rule). */
export async function scheduleDpDate(c: Ctx, sb: Sb, id: string, scheduleDate: string | null | undefined): Promise<EditResult> {
  if (scheduleDate === undefined) {
    return { status: 400, body: { error: 'no_changes', reason: 'Only the date is editable here; assign crew on the trip.' } };
  }
  const { data: dpRow, error: dpErr } = await scopeToAllowedCompanies(
    sb.from('dp_orders').select('id, trip_id').eq('id', id), c,
  ).maybeSingle();
  if (dpErr) return { status: 500, body: { error: 'lookup_failed', reason: dpErr.message } };
  if (!dpRow) return { status: 404, body: { error: 'not_found' } };
  const newDate = dateOrNull(scheduleDate);
  const { error: upErr } = await scopeToAllowedCompanies(
    sb.from('dp_orders').update({ requested_date: newDate, updated_at: new Date().toISOString() }).eq('id', id), c,
  );
  if (upErr) return { status: 500, body: { error: 'update_failed', reason: upErr.message } };
  const tripId = ((dpRow as { trip_id?: string | null; tripId?: string | null }).trip_id
    ?? (dpRow as { tripId?: string | null }).tripId) ?? null;
  if (tripId && newDate) {
    await sb.from('trips').update({ trip_date: newDate, updated_at: new Date().toISOString() }).eq('id', tripId);
  }
  return { status: 200, body: { ok: true, dp: { id, requested_date: newDate } } };
}

/* The board's inline NON-SO field edits on a DP or service-case row: the MESSAGE
   status (dp + assr), and the Time Slot (dp only — a DP job has no DO to carry it,
   so it lives on the order; owner 2026-10-31). Each value present is whitelisted by
   the caller (the route) before this runs; the board sends one cell at a time. */
export async function writeNonSoFields(
  c: Ctx, sb: Sb, type: 'dp' | 'assr', id: string,
  fields: { deliveryMessageStatus?: string | null; timeRange?: string | null },
): Promise<EditResult> {
  const { deliveryMessageStatus, timeRange } = fields;
  if (deliveryMessageStatus === undefined && timeRange === undefined) {
    return { status: 400, body: { error: 'no_changes', reason: 'Only the delivery message status and time slot are editable here.' } };
  }
  const msg = deliveryMessageStatus === '' ? null : deliveryMessageStatus;
  if (type === 'dp') {
    // Time Slot is DP-only — assr_cases has no such column (below writes message only).
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (deliveryMessageStatus !== undefined) patch.delivery_message_status = msg;
    if (timeRange !== undefined) patch.time_range = timeRange === '' ? null : timeRange;
    const { data, error } = await scopeToAllowedCompanies(
      sb.from('dp_orders').update(patch).eq('id', id), c,
    ).select('id').maybeSingle();
    if (error) return { status: 500, body: { error: 'update_failed', reason: error.message } };
    if (!data) return { status: 404, body: { error: 'not_found' } };
    return { status: 200, body: { ...OK_FIELDS } };
  }
  // assr carries only the message status here; a time-only edit has nothing to write.
  if (deliveryMessageStatus === undefined) {
    return { status: 400, body: { error: 'no_changes', reason: 'Only the delivery message status is editable on a service case here.' } };
  }
  // assr — public.assr_cases via c.env.DB; the open-case guard carries the
  // caller's granted-company predicate, so an out-of-scope case 404s here.
  const caseId = Number(id);
  if (!Number.isFinite(caseId)) return { status: 400, body: { error: 'bad_id', reason: 'assr id must be numeric' } };
  const openCase = (await c.env.DB.prepare(assrOpenCaseGuardSql(c)).bind(caseId).first()) as { id: number } | null;
  if (!openCase) return { status: 404, body: { error: 'not_found' } };
  try {
    const res = await c.env.DB.prepare(
      `UPDATE assr_cases SET delivery_message_status = ?, updated_at = datetime('now')
        WHERE id = ? AND closed_at IS NULL AND archived_at IS NULL`,
    ).bind(msg, caseId).run();
    if (!res.meta.changes) return { status: 404, body: { error: 'not_found' } };
  } catch (e) {
    return { status: 500, body: { error: 'update_failed', reason: String((e as Error).message).slice(0, 200) } };
  }
  return { status: 200, body: { ...OK_FIELDS } };
}
