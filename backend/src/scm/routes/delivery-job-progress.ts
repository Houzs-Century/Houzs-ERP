/* The crew's run of a NON-delivery-order job: Setup / Dismantle (a project),
   a Service Case leg (pickup, inspection, delivery back), and the manual DP jobs
   (Supplier pickup, Transfer, Lorry service). A Delivery Order keeps its own
   chain on scm.delivery_orders (PATCH /delivery-orders-mfg/:id/status|arrival).

   One job is addressed as /:sourceType/:sourceId/:leg — the same identity the
   delivery board uses for its rows:
     dp       scm.dp_orders.id      leg = dp job_type
     project  public.projects.id    leg = SETUP | DISMANTLE
     assr     public.assr_cases.id  leg = customer_pickup | inspection | delivery

   GET  …               what the crew needs to see for that job + its progress
   POST …/depart        stamps departed_at (server time) — "On the way"
   POST …/arrive        stamps arrived_at — "Arrived"
   POST …/complete      photos (at least one), notes, GPS; stamps completed_at
                        and files the photos where that job's document keeps them

   Every write is the caller's OWN job unless their delivery scope is 'all'
   (office). Times are server times; a repeat tap keeps the first one. */
import { Hono, type Context } from 'hono';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';
import { scopeToAllowedCompanies } from '../lib/companyScope';
import { resolveDeliveryScope, scopeMatchesAssignment, type CrewAssignment } from '../lib/deliveryScope';
import { ASSR_BOARD_LEGS } from '../lib/assr-board-scope';
import { saveAttachment, logActivity, patchAssrCase, transitionStage } from '../../services/assr';
import { setChecklistStatus } from '../../services/projects';
import { sendCompletionSurvey } from '../../services/assrCompletionSurvey';

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;
type SourceType = 'dp' | 'project' | 'assr';

const PROJECT_LEGS = ['SETUP', 'DISMANTLE'] as const;
const MAX_PHOTOS = 10;

export const deliveryJobProgress = new Hono<{ Bindings: Env; Variables: Variables }>();
deliveryJobProgress.use('*', supabaseAuth);

function parseJob(c: Ctx): { sourceType: SourceType; sourceId: string; leg: string } | { error: string } {
  const sourceType = c.req.param('sourceType') as SourceType;
  const sourceId = c.req.param('sourceId') ?? '';
  const leg = c.req.param('leg') ?? '';
  if (!['dp', 'project', 'assr'].includes(sourceType)) return { error: 'Unknown job type.' };
  if (!sourceId) return { error: 'Missing job id.' };
  if (sourceType === 'project' && !(PROJECT_LEGS as readonly string[]).includes(leg)) return { error: 'A project job is SETUP or DISMANTLE.' };
  if (sourceType === 'assr' && !(ASSR_BOARD_LEGS as readonly string[]).includes(leg)) return { error: 'A service case job is customer_pickup, inspection or delivery.' };
  if (sourceType !== 'dp' && !/^\d+$/.test(sourceId)) return { error: 'Invalid job id.' };
  return { sourceType, sourceId, leg };
}

const tripCrew = (t: Record<string, unknown> | null | undefined): CrewAssignment => ({
  driverIds: [(t?.driver_id as string | null) ?? null],
  helperIds: [(t?.helper_1_id as string | null) ?? null, (t?.helper_2_id as string | null) ?? null],
});

/* The job's own row (for the context read and the write-backs) plus whether the
   caller may act on it, and the trip it rides when there is one. */
async function loadJob(c: Ctx, sourceType: SourceType, sourceId: string, leg: string): Promise<
  { ok: true; row: Record<string, unknown>; tripId: string | null; companyId: number | null }
  | { ok: false; status: 403 | 404 | 500; error: string; reason: string }
> {
  const sb = c.get('supabase');
  const scope = await resolveDeliveryScope(sb, c.get('houzsUser'));
  const notYours = { ok: false as const, status: 403 as const, error: 'not_your_job', reason: 'You can only update a job assigned to you.' };

  if (sourceType === 'dp') {
    const { data, error } = await scopeToAllowedCompanies(sb.from('dp_orders').select('*').eq('id', sourceId), c).maybeSingle();
    if (error) return { ok: false, status: 500, error: 'load_failed', reason: error.message };
    if (!data || (data as { job_type: string }).job_type !== leg) return { ok: false, status: 404, error: 'not_found', reason: 'This job could not be found.' };
    const row = data as Record<string, unknown>;
    const tripId = (row.trip_id as string | null) ?? null;
    if (scope.mode !== 'all') {
      if (!tripId) return notYours;
      const { data: trip, error: tErr } = await sb.from('trips').select('driver_id, helper_1_id, helper_2_id').eq('id', tripId).maybeSingle();
      if (tErr) return { ok: false, status: 500, error: 'load_failed', reason: tErr.message };
      if (!scopeMatchesAssignment(scope, tripCrew(trip as Record<string, unknown> | null))) return notYours;
    }
    return { ok: true, row, tripId, companyId: (row.company_id as number | null) ?? null };
  }

  if (sourceType === 'project') {
    const row = await c.env.DB.prepare(
      `SELECT p.id, p.code, p.name, p.venue, p.venue_address, p.state, p.booth_no, p.size_sqm,
              p.organizer, p.brand, p.contractor, p.schedule_remark, p.notes, p.company_id,
              p.setup_start_at, p.setup_end_at, p.dismantle_start_at, p.dismantle_end_at,
              p.setup_driver_user_id, p.setup_helper_1_id, p.setup_helper_2_id,
              p.dismantle_driver_user_id, p.dismantle_helper_1_id, p.dismantle_helper_2_id,
              pic.name AS pic_name, pic.phone AS pic_phone
         FROM projects p LEFT JOIN users pic ON pic.id = p.pic_id
        WHERE p.id = ?`,
    ).bind(Number(sourceId)).first<Record<string, unknown>>();
    if (!row) return { ok: false, status: 404, error: 'not_found', reason: 'This project could not be found.' };
    if (scope.mode !== 'all') {
      const me = Number(c.get('houzsUser')?.id);
      const crew = leg === 'SETUP'
        ? [row.setup_driver_user_id, row.setup_helper_1_id, row.setup_helper_2_id]
        : [row.dismantle_driver_user_id, row.dismantle_helper_1_id, row.dismantle_helper_2_id];
      if (!crew.some((v) => v != null && Number(v) === me)) return notYours;
    }
    return { ok: true, row, tripId: null, companyId: (row.company_id as number | null) ?? null };
  }

  const row = await c.env.DB.prepare(
    `SELECT id, assr_no, customer_name, phone, addr1, addr2, addr3, addr4, location, item_code,
            complaint_issue, issue_category, doc_no, stage, sub_status, company_id,
            customer_pickup_at, inspection_visit_at, do_date
       FROM assr_cases WHERE id = ?`,
  ).bind(Number(sourceId)).first<Record<string, unknown>>();
  if (!row) return { ok: false, status: 404, error: 'not_found', reason: 'This service case could not be found.' };
  // The case's leg rides the trip its stop was put on by Time Arrangement.
  const { data: stops, error: sErr } = await sb.from('trip_stops').select('trip_id').eq('assr_case_id', Number(sourceId));
  if (sErr) return { ok: false, status: 500, error: 'load_failed', reason: sErr.message };
  const tripIds = [...new Set(((stops ?? []) as Array<{ trip_id: string | null }>).map((s) => s.trip_id).filter(Boolean))] as string[];
  if (scope.mode !== 'all') {
    if (!tripIds.length) return notYours;
    const { data: trips, error: tErr } = await sb.from('trips').select('driver_id, helper_1_id, helper_2_id').in('id', tripIds);
    if (tErr) return { ok: false, status: 500, error: 'load_failed', reason: tErr.message };
    if (!((trips ?? []) as Array<Record<string, unknown>>).some((t) => scopeMatchesAssignment(scope, tripCrew(t)))) return notYours;
  }
  return { ok: true, row, tripId: tripIds[0] ?? null, companyId: (row.company_id as number | null) ?? null };
}

/* What the crew sees for one job, by type. Only what the run needs. */
async function contextFor(c: Ctx, sourceType: SourceType, leg: string, row: Record<string, unknown>) {
  const sb = c.get('supabase');
  if (sourceType === 'project') {
    const setup = leg === 'SETUP';
    return {
      kind: leg, title: row.name, ref: row.code,
      venue: row.venue, address: row.venue_address, state: row.state,
      booth_no: row.booth_no, size_sqm: row.size_sqm, organizer: row.organizer, brand: row.brand,
      contractor: row.contractor, contact_name: row.pic_name, contact_phone: row.pic_phone,
      window_start: setup ? row.setup_start_at : row.dismantle_start_at,
      window_end: setup ? row.setup_end_at : row.dismantle_end_at,
      remark: row.schedule_remark ?? row.notes,
    };
  }
  if (sourceType === 'assr') {
    const complaintPhotos = await c.env.DB.prepare(
      `SELECT r2_key, content_type FROM assr_attachments WHERE assr_id = ? AND category = 'complaint' ORDER BY id`,
    ).bind(Number(row.id)).all<{ r2_key: string; content_type: string | null }>();
    return {
      kind: leg, title: row.customer_name, ref: row.assr_no,
      contact_name: row.customer_name, contact_phone: row.phone,
      address: [row.addr1, row.addr2, row.addr3, row.addr4].filter(Boolean).join(', '), state: row.location,
      product: row.item_code, issue: row.complaint_issue, issue_category: row.issue_category, so_doc_no: row.doc_no,
      stage: row.stage, sub_status: row.sub_status,
      date: leg === 'customer_pickup' ? row.customer_pickup_at : leg === 'inspection' ? row.inspection_visit_at : row.do_date,
      complaint_photos: complaintPhotos.results ?? [],
    };
  }
  const base = {
    kind: leg, title: row.party_name, ref: row.dp_no,
    contact_name: row.contact_name, contact_phone: row.contact_phone,
    address: [row.address1, row.address2, row.address3, row.address4, row.postcode, row.city].filter(Boolean).join(', '),
    state: row.state, date: row.requested_date, remark: row.remark,
  };
  if (leg === 'TRANSFER' && row.stock_transfer_id) {
    const [{ data: st, error: e1 }, { data: lines, error: e2 }] = await Promise.all([
      sb.from('stock_transfers').select('transfer_no, from_warehouse_id, to_warehouse_id').eq('id', row.stock_transfer_id).maybeSingle(),
      sb.from('stock_transfer_lines').select('item_code, product_name, qty').eq('stock_transfer_id', row.stock_transfer_id),
    ]);
    if (e1 || e2) throw new Error((e1 ?? e2)!.message);
    const whIds = [st?.from_warehouse_id, st?.to_warehouse_id].filter(Boolean);
    const { data: whs, error: e3 } = whIds.length ? await sb.from('warehouses').select('id, name').in('id', whIds) : { data: [], error: null };
    if (e3) throw new Error(e3.message);
    const wh = (id: unknown) => ((whs ?? []) as Array<{ id: unknown; name: string }>).find((w) => w.id === id)?.name ?? null;
    return { ...base, transfer_no: st?.transfer_no ?? null, from_warehouse: wh(st?.from_warehouse_id), to_warehouse: wh(st?.to_warehouse_id), lines: lines ?? [] };
  }
  if (leg === 'LORRY_SERVICE') {
    const [{ data: lorry, error: e1 }, { data: wo, error: e2 }] = await Promise.all([
      row.lorry_id ? sb.from('lorries').select('plate').eq('id', row.lorry_id).maybeSingle() : Promise.resolve({ data: null, error: null }),
      row.work_order_id ? sb.from('lorry_work_orders').select('wo_no, problem, workshop').eq('id', row.work_order_id).maybeSingle() : Promise.resolve({ data: null, error: null }),
    ]);
    if (e1 || e2) throw new Error((e1 ?? e2)!.message);
    return { ...base, lorry_plate: lorry?.plate ?? null, work_order_no: wo?.wo_no ?? null, problem: wo?.problem ?? null, workshop: wo?.workshop ?? null };
  }
  return base;
}

async function readProgress(c: Ctx, sourceType: SourceType, sourceId: string, leg: string) {
  const { data, error } = await c.get('supabase').from('job_progress').select('*')
    .eq('source_type', sourceType).eq('source_id', sourceId).eq('leg', leg).maybeSingle();
  if (error) throw new Error(error.message);
  return (data ?? null) as Record<string, unknown> | null;
}

/* A trip moves PLANNED -> IN_PROGRESS on its first "On the way", so the phone's
   live location (trip_locations, accepted only while IN_PROGRESS) starts. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the scm PostgREST client, untyped like every other route helper
export async function startTripIfPlanned(sb: any, tripId: string | null): Promise<void> {
  if (!tripId) return;
  const now = new Date().toISOString();
  const { error } = await sb.from('trips').update({ status: 'IN_PROGRESS', clock_in_at: now, updated_at: now })
    .eq('id', tripId).eq('status', 'PLANNED');
  if (error) throw new Error(error.message);
}

/* GET /progress?since=YYYY-MM-DD — every job's progress touched since that day,
   so the run-sheet and the board can show On the way / Arrived / Done on
   non-DO rows without one read per row. Times and photo keys only, no party
   data; the window is capped at 62 days. */
deliveryJobProgress.get('/progress', async (c) => {
  const since = c.req.query('since') ?? '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) return c.json({ error: 'invalid_since', reason: 'since must be YYYY-MM-DD.' }, 400);
  const floor = new Date(Date.now() - 62 * 86400_000).toISOString().slice(0, 10);
  const { data, error } = await scopeToAllowedCompanies(
    c.get('supabase').from('job_progress')
      .select('source_type, source_id, leg, departed_at, arrived_at, completed_at, pod_photo_keys')
      .gte('updated_at', since < floor ? floor : since),
    c,
  ).limit(5000);
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  return c.json({ progress: data ?? [] });
});

deliveryJobProgress.get('/:sourceType/:sourceId/:leg', async (c) => {
  const job = parseJob(c);
  if ('error' in job) return c.json({ error: 'invalid_job', reason: job.error }, 400);
  const loaded = await loadJob(c, job.sourceType, job.sourceId, job.leg);
  if (!loaded.ok) return c.json({ error: loaded.error, reason: loaded.reason }, loaded.status);
  try {
    const [context, progress] = await Promise.all([
      contextFor(c, job.sourceType, job.leg, loaded.row),
      readProgress(c, job.sourceType, job.sourceId, job.leg),
    ]);
    return c.json({ job: { ...job, trip_id: loaded.tripId }, context, progress });
  } catch (e) {
    return c.json({ error: 'load_failed', reason: (e as Error).message }, 500);
  }
});

async function stamp(c: Ctx, step: 'depart' | 'arrive') {
  const job = parseJob(c);
  if ('error' in job) return c.json({ error: 'invalid_job', reason: job.error }, 400);
  const loaded = await loadJob(c, job.sourceType, job.sourceId, job.leg);
  if (!loaded.ok) return c.json({ error: loaded.error, reason: loaded.reason }, loaded.status);
  const sb = c.get('supabase');
  const me = Number(c.get('houzsUser')?.id) || null;
  const now = new Date().toISOString();
  const atCol = step === 'depart' ? 'departed_at' : 'arrived_at';
  const byCol = step === 'depart' ? 'departed_by' : 'arrived_by';
  try {
    const cur = await readProgress(c, job.sourceType, job.sourceId, job.leg);
    if (cur?.completed_at) return c.json({ error: 'already_completed', reason: 'This job is already completed.' }, 409);
    if (cur?.[atCol]) return c.json({ progress: cur });
    const { data, error } = await sb.from('job_progress').upsert({
      source_type: job.sourceType, source_id: job.sourceId, leg: job.leg,
      company_id: loaded.companyId, trip_id: loaded.tripId,
      [atCol]: now, [byCol]: me, updated_at: now,
    }, { onConflict: 'source_type,source_id,leg' }).select('*').single();
    if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);
    if (step === 'depart') await startTripIfPlanned(sb, loaded.tripId);
    return c.json({ progress: data });
  } catch (e) {
    return c.json({ error: 'update_failed', reason: (e as Error).message }, 500);
  }
}
deliveryJobProgress.post('/:sourceType/:sourceId/:leg/depart', (c) => stamp(c, 'depart'));
deliveryJobProgress.post('/:sourceType/:sourceId/:leg/arrive', (c) => stamp(c, 'arrive'));

/* Complete — the POD. The photos go where the job's own document keeps photos,
   so the office sees them there without a second upload:
     project SETUP/DISMANTLE -> project_phase_photos (phase setup / dismantle)
     assr leg                -> assr_attachments (category 'completion') + timeline
     dp LORRY_SERVICE        -> lorry_work_orders.photo_refs (when linked)
     dp (every type)         -> dp_orders.status = 'COMPLETED'
   and then makes the ONE move a person would otherwise make right after that
   job (owner, 2026-10-08) — see advanceServiceCase / tickProjectImageRow. */
deliveryJobProgress.post('/:sourceType/:sourceId/:leg/complete', async (c) => {
  const job = parseJob(c);
  if ('error' in job) return c.json({ error: 'invalid_job', reason: job.error }, 400);
  let body: { photoKeys?: unknown; notes?: unknown; lat?: unknown; lng?: unknown; accuracyM?: unknown; locatedAt?: unknown };
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const photoKeys = Array.isArray(body.photoKeys) ? body.photoKeys.filter((k): k is string => typeof k === 'string' && /^slips\//.test(k)) : [];
  if (!photoKeys.length) return c.json({ error: 'photo_required', reason: 'Take at least one POD photo before completing the job.' }, 400);
  if (photoKeys.length > MAX_PHOTOS) return c.json({ error: 'too_many_photos', reason: `At most ${MAX_PHOTOS} photos per job.` }, 400);
  const loaded = await loadJob(c, job.sourceType, job.sourceId, job.leg);
  if (!loaded.ok) return c.json({ error: loaded.error, reason: loaded.reason }, loaded.status);

  const sb = c.get('supabase');
  const me = Number(c.get('houzsUser')?.id) || null;
  const now = new Date().toISOString();
  const lat = Number(body.lat), lng = Number(body.lng);
  const gps = Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180
    ? { pod_lat: lat, pod_lng: lng, pod_accuracy_m: Number.isFinite(Number(body.accuracyM)) ? Number(body.accuracyM) : null,
        pod_located_at: typeof body.locatedAt === 'string' ? body.locatedAt : now }
    : {};
  try {
    const cur = await readProgress(c, job.sourceType, job.sourceId, job.leg);
    if (cur?.completed_at) return c.json({ error: 'already_completed', reason: 'This job is already completed.' }, 409);
    const { data: progress, error } = await sb.from('job_progress').upsert({
      source_type: job.sourceType, source_id: job.sourceId, leg: job.leg,
      company_id: loaded.companyId, trip_id: loaded.tripId,
      // Completing implies the crew got there; keep any earlier taps.
      departed_at: cur?.departed_at ?? now, departed_by: cur?.departed_by ?? me,
      arrived_at: cur?.arrived_at ?? now, arrived_by: cur?.arrived_by ?? me,
      completed_at: now, completed_by: me, pod_photo_keys: photoKeys,
      pod_notes: typeof body.notes === 'string' && body.notes.trim() ? body.notes.trim().slice(0, 2000) : null,
      ...gps, updated_at: now,
    }, { onConflict: 'source_type,source_id,leg' }).select('*').single();
    if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);

    if (job.sourceType === 'project') {
      const phase = job.leg === 'SETUP' ? 'setup' : 'dismantle';
      for (const key of photoKeys) {
        await c.env.DB.prepare(
          `INSERT INTO project_phase_photos (project_id, phase, r2_key, content_type, caption, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)`,
        ).bind(Number(job.sourceId), phase, key, 'image/jpeg', 'POD', me).run();
      }
      await tickProjectImageRow(c, Number(job.sourceId), job.leg, me);
    } else if (job.sourceType === 'assr') {
      const legWord = job.leg === 'customer_pickup' ? 'Pickup' : job.leg === 'inspection' ? 'Inspection' : 'Delivery / service';
      for (const key of photoKeys) await saveAttachment(c.env, Number(job.sourceId), key, null, 'image/jpeg', 'completion', me);
      await logActivity(c.env, Number(job.sourceId), 'attachment_added', null, `${legWord} POD`,
        `${legWord} completed by the crew (${photoKeys.length} POD photo${photoKeys.length === 1 ? '' : 's'})`,
        me, { category: 'service', source_channel: 'app' });
      await advanceServiceCase(c, Number(job.sourceId), job.leg, loaded.row, me);
    } else {
      const { error: dpErr } = await scopeToAllowedCompanies(
        sb.from('dp_orders').update({ status: 'COMPLETED', updated_at: now }).eq('id', job.sourceId), c,
      );
      if (dpErr) return c.json({ error: 'update_failed', reason: dpErr.message }, 500);
      const woId = loaded.row.work_order_id as string | null;
      if (job.leg === 'LORRY_SERVICE' && woId) {
        const { data: wo, error: woErr } = await sb.from('lorry_work_orders').select('photo_refs').eq('id', woId).maybeSingle();
        if (woErr) return c.json({ error: 'update_failed', reason: woErr.message }, 500);
        const refs = Array.isArray(wo?.photo_refs) ? (wo.photo_refs as string[]) : [];
        const { error: upErr } = await sb.from('lorry_work_orders')
          .update({ photo_refs: [...refs, ...photoKeys.filter((k) => !refs.includes(k))], updated_at: now }).eq('id', woId);
        if (upErr) return c.json({ error: 'update_failed', reason: upErr.message }, 500);
      }
    }
    return c.json({ progress });
  } catch (e) {
    return c.json({ error: 'update_failed', reason: (e as Error).message }, 500);
  }
});

/* Service case: the step staff take by hand once the crew has done the leg —
   and ONLY when the case is still sitting on that step, so a case moved on in
   the meantime is never pushed somewhere else.
     customer_pickup  Pickup/Return: pending_customer_pickup -> pending_supplier_pickup
     inspection       Verify:        pending_inspection     -> qc_issue_result (staff record the result)
     delivery         Delivery stage -> completed (closing sends the CSAT survey, as a manual close does) */
async function advanceServiceCase(c: Ctx, caseId: number, leg: string, row: Record<string, unknown>, me: number | null) {
  const stage = String(row.stage ?? '');
  const sub = String(row.sub_status ?? '');
  const by = me ?? 0;
  if (leg === 'customer_pickup' && stage === 'pending_supplier_pickup' && sub === 'pending_customer_pickup') {
    await patchAssrCase(c.env, caseId, { sub_status: 'pending_supplier_pickup' }, by);
  } else if (leg === 'inspection' && stage === 'under_verification' && sub === 'pending_inspection') {
    await patchAssrCase(c.env, caseId, { sub_status: 'qc_issue_result' }, by);
  } else if (leg === 'delivery' && stage === 'pending_delivery_service') {
    await transitionStage(c.env, caseId, 'completed', by, 'Delivered by the crew (POD)');
    await sendCompletionSurvey(c.env, caseId);
  }
}

/* Project: the crew's setup / dismantle photos already show under the
   "Setup Image" / "Dismantle Image" checklist rows, which nobody ticked; the
   POD ticks the open one. The project stage is left alone — nothing maintains
   it and the P&L "completed" view reads it. */
async function tickProjectImageRow(c: Ctx, projectId: number, leg: string, me: number | null) {
  const like = leg === 'SETUP' ? 'Setup Image%' : 'Dismantle Image%';
  // company-scope: rows of the one project the crew-checked job just completed (loadJob)
  const rows = await c.env.DB.prepare(
    `SELECT id FROM project_checklist WHERE project_id = ? AND title LIKE ? AND status <> 'done' ORDER BY id`,
  ).bind(projectId, like).all<{ id: number }>();
  for (const r of rows.results ?? []) await setChecklistStatus(c.env, r.id, 'done', me ?? 0);
}
