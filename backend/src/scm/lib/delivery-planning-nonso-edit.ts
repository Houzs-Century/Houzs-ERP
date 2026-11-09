/* Delivery Planning — the inline edits the NON-SO job types allow (owner
   2026-10-29: the DP manual jobs and the service-case rows must be adjustable
   like SO rows — message, date, driver/lorry/helper).
   SO/DO keep their own rich paths in the route; crew for DP (on a trip) and ASSR
   is the trip / schedule machinery already there. What lives here is the small,
   type-specific rest that would otherwise bloat the router past its size ceiling:
     · a DP job's DATE   → scm.dp_orders.requested_date (+ the trip's date when it
                           rides one), company-bounded to the caller's companies.
     · a DP / ASSR row's MESSAGE status → scm.dp_orders.delivery_message_status,
                           or public.assr_cases.<leg>_message_status (c.env.DB,
                           the plane the ASSR board union reads). A service
                           case's row shows the newest of send / customer tap /
                           staff pick, so the pick is logged too.
     · a DP / ASSR / project row's REMARKS → scm.dp_orders.remark,
                           public.assr_cases.<leg>_remark, or the project's one
                           projects.delivery_remark (its own column, not the
                           Projects team's schedule_remark). */
import { scopeToAllowedCompanies, allowedCompaniesSql } from './companyScope';
import { dateOrNull } from './date-coerce';
import { assrLegGuardSql, ASSR_LEG_TIME_COL, ASSR_LEG_MSG_COL, ASSR_LEG_REMARK_COL, ASSR_STATUS_PICK_SOURCE, ASSR_ACTUAL_COL, ASSR_CANCELLED_COL } from './assr-board-scope';
import { logActivity } from '../../services/assr';
import { todayMyt } from './my-time';

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

/* The board's inline NON-SO field edits on a DP, service-case or project row: the
   MESSAGE status (dp + assr), the Time Slot (dp: on the order, owner 2026-10-31; assr:
   one column per leg, HC-0194), and the Remarks (all three). Each value present is
   whitelisted by the caller (the route) before this runs; the board sends one cell at a time. */
export async function writeNonSoFields(
  c: Ctx, sb: Sb, type: 'dp' | 'assr' | 'project', id: string,
  fields: { deliveryMessageStatus?: string | null; timeRange?: string | null; remark?: string | null; jobKind?: keyof typeof ASSR_LEG_TIME_COL },
): Promise<EditResult> {
  const { deliveryMessageStatus, timeRange, remark, jobKind } = fields;
  if (type === 'project') return writeProjectRemark(c, id, remark);
  if (deliveryMessageStatus === undefined && timeRange === undefined && remark === undefined) {
    return { status: 400, body: { error: 'no_changes', reason: 'Only the delivery message status, time slot and remarks are editable here.' } };
  }
  const msg = deliveryMessageStatus === '' ? null : deliveryMessageStatus;
  const note = remark === '' ? null : remark;
  if (type === 'dp') {
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (deliveryMessageStatus !== undefined) patch.delivery_message_status = msg;
    if (timeRange !== undefined) patch.time_range = timeRange === '' ? null : timeRange;
    if (remark !== undefined) patch.remark = note;
    const { data, error } = await scopeToAllowedCompanies(
      sb.from('dp_orders').update(patch).eq('id', id), c,
    ).select('id').maybeSingle();
    if (error) return { status: 500, body: { error: 'update_failed', reason: error.message } };
    if (!data) return { status: 404, body: { error: 'not_found' } };
    return { status: 200, body: { ...OK_FIELDS } };
  }
  // A service case's message status and Time Slot are per leg (HC-0193, HC-0194), so the write names the leg.
  if (!jobKind) {
    return { status: 400, body: { error: 'job_kind_required', reason: 'A service-case message status, time slot or remark belongs to one job; send jobKind.' } };
  }
  // assr — public.assr_cases via c.env.DB; the open-case guard carries the
  // caller's granted-company predicate, so an out-of-scope case 404s here.
  const caseId = Number(id);
  if (!Number.isFinite(caseId)) return { status: 400, body: { error: 'bad_id', reason: 'assr id must be numeric' } };
  // Message status and Time Slot are planning notes, not scheduling: allowed on any leg the board lists, done or not; only an archived or out-of-scope case 404s.
  const legCase = await c.env.DB.prepare(assrLegGuardSql(c)).bind(caseId).first();
  if (!legCase) return { status: 404, body: { error: 'not_found' } };
  try {
    // The column names come from the ASSR_LEG_* maps, never from the request.
    const sets: string[] = []; const binds: unknown[] = [];
    if (deliveryMessageStatus !== undefined) { sets.push(`${ASSR_LEG_MSG_COL[jobKind]} = ?`); binds.push(msg); }
    if (timeRange !== undefined) { sets.push(`${ASSR_LEG_TIME_COL[jobKind]} = ?`); binds.push(timeRange === '' ? null : timeRange); }
    if (remark !== undefined) { sets.push(`${ASSR_LEG_REMARK_COL[jobKind]} = ?`); binds.push(note); }
    const res = await c.env.DB.prepare(
      `UPDATE assr_cases SET ${sets.join(', ')}, updated_at = datetime('now')
        WHERE id = ? AND archived_at IS NULL`,
    ).bind(...binds, caseId).run();
    if (!res.meta.changes) return { status: 404, body: { error: 'not_found' } };
    if (deliveryMessageStatus !== undefined) {
      // Without this row the leg's last send or tap would hide the pick on the next read, so a failure reports "not saved".
      const { error } = await sb.from('wa_message_log').insert({
        batch_id: crypto.randomUUID(),
        company_id: legCase.company_id ?? null,
        doc_no: `${legCase.assr_no}#${jobKind}`,
        phone: '',
        payload: JSON.stringify({ status: msg }),
        http_code: null,
        success: true,
        error: null,
        source: ASSR_STATUS_PICK_SOURCE,
        created_by: c.get('user')?.id ?? null,
      });
      if (error) return { status: 500, body: { error: 'update_failed', reason: String(error.message).slice(0, 200) } };
    }
  } catch (e) {
    return { status: 500, body: { error: 'update_failed', reason: String((e as Error).message).slice(0, 200) } };
  }
  return { status: 200, body: { ...OK_FIELDS } };
}

/* Board per-leg status for one service-case leg (owner 2026-11-06), the dropdown's
   Delivered / Cancelled / — (pending):
     delivered -> stamp actual_* (leg shows DELIVERED), clear cancelled_*
     cancelled -> stamp cancelled_* (leg DROPS off the board), clear actual_*
     pending   -> clear both (leg back to pending)
   It records the step and NEVER closes the case (closure stays a separate ASSR-
   module action). The caller has already run assrLegGuardSql, so this re-reads
   nothing — it writes + logs. Here (not in the router) to keep delivery-planning.ts
   under its size ceiling. */
export async function writeAssrLegStatus(
  c: Ctx, caseId: number, jobKind: keyof typeof ASSR_ACTUAL_COL, status: 'delivered' | 'cancelled' | 'pending', by: string,
): Promise<EditResult> {
  const today = todayMyt();
  const deliveredAt = status === 'delivered' ? today : null;
  const cancelledAt = status === 'cancelled' ? today : null;
  const action = status === 'delivered' ? 'leg_delivered' : status === 'cancelled' ? 'leg_cancelled' : 'leg_reopened';
  const verb = status === 'delivered' ? 'marked delivered' : status === 'cancelled' ? 'cancelled' : 'reopened';
  try {
    const res = await c.env.DB.prepare(
      `UPDATE assr_cases SET ${ASSR_ACTUAL_COL[jobKind]} = ?, ${ASSR_CANCELLED_COL[jobKind]} = ?, updated_at = datetime('now')
        WHERE id = ? AND archived_at IS NULL`,
    ).bind(deliveredAt, cancelledAt, caseId).run();
    if (!res.meta.changes) return { status: 404, body: { error: 'not_found' } };
    await logActivity(c.env, caseId, action, null, status === 'pending' ? null : today,
      `${jobKind} leg ${verb} on the Delivery Planning board by ${by}`, null, 'service');
  } catch (e) {
    return { status: 500, body: { error: 'update_failed', reason: String((e as Error).message).slice(0, 200) } };
  }
  return { status: 200, body: { ok: true, assr: { id: caseId, job_kind: jobKind, status, delivered_at: deliveredAt, cancelled_at: cancelledAt } } };
}

/* A project row's Remarks: projects.delivery_remark, shared by its SETUP and
   DISMANTLE rows. Only the remark is editable from the board; crew and dates stay
   in Projects. Bounded to the caller's companies like the other writes here. */
async function writeProjectRemark(c: Ctx, id: string, remark: string | null | undefined): Promise<EditResult> {
  if (remark === undefined) {
    return { status: 400, body: { error: 'no_changes', reason: 'Only the remarks are editable on a project row; edit the rest in Projects.' } };
  }
  const projectId = Number(id);
  if (!Number.isInteger(projectId)) return { status: 400, body: { error: 'bad_id', reason: 'project id must be numeric' } };
  try {
    const res = await c.env.DB.prepare(
      `UPDATE projects SET delivery_remark = ?, updated_at = datetime('now')
        WHERE id = ? AND archived_at IS NULL${allowedCompaniesSql(c)}`,
    ).bind(remark === '' ? null : remark, projectId).run();
    if (!res.meta.changes) return { status: 404, body: { error: 'not_found' } };
  } catch (e) {
    return { status: 500, body: { error: 'update_failed', reason: String((e as Error).message).slice(0, 200) } };
  }
  return { status: 200, body: { ...OK_FIELDS } };
}
