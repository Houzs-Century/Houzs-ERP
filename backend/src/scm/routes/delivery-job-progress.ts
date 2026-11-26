import { Hono, type Context } from 'hono';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';
import { scopeToAllowedCompanies, allowedCompaniesSql, allowedCompanyIds } from '../lib/companyScope';
import { claimPodPhotos, jobStopContext } from '../lib/pod-photo-claim';
import { appendDoPodPhotos } from '../lib/do-pod-photos';
import { houzsUserIdOf, mytClock } from '../lib/crew-stop-complete';
import { ASSR_LEG_BY_STOP, podPhotoResponse } from './delivery-pod-context';
import { resolveDeliveryScope, scopeMatchesAssignment, type CrewAssignment } from '../lib/deliveryScope';
import { ASSR_BOARD_LEGS } from '../lib/assr-board-scope';
import { saveAttachment, logActivity, patchAssrCase, transitionStage } from '../../services/assr';
import { setChecklistStatus, getUserPhasesOnProject } from '../../services/projects';
import { sendCompletionSurvey } from '../../services/assrCompletionSurvey';
import { todayMyt } from '../lib/my-time';
import { paginateAll } from '../lib/paginate-all';
import { formatCaseAddress, type CaseAddressParts } from '../shared/assr-case-address';

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;
export const JOB_SOURCE_TYPES = ['dp', 'project', 'assr'] as const;
type SourceType = (typeof JOB_SOURCE_TYPES)[number];

const PROJECT_LEGS = ['SETUP', 'DISMANTLE'] as const;
const MAX_PHOTOS = 10;

export const deliveryJobProgress = new Hono<{ Bindings: Env; Variables: Variables }>();
deliveryJobProgress.use('*', supabaseAuth);

export function parseJob(c: Ctx): { sourceType: SourceType; sourceId: string; leg: string } | { error: string } {
  return parseJobParts(c.req.param('sourceType') ?? '', c.req.param('sourceId') ?? '', c.req.param('leg') ?? '');
}

export function parseJobParts(rawType: string, sourceId: string, leg: string): { sourceType: SourceType; sourceId: string; leg: string } | { error: string } {
  const sourceType = rawType as SourceType;
  if (!(JOB_SOURCE_TYPES as readonly string[]).includes(sourceType)) return { error: 'Unknown job type.' };
  if (!sourceId) return { error: 'Missing job id.' };
  if (sourceType === 'project' && !(PROJECT_LEGS as readonly string[]).includes(leg)) return { error: 'A project job is SETUP or DISMANTLE.' };
  if (sourceType === 'assr' && !(ASSR_BOARD_LEGS as readonly string[]).includes(leg)) return { error: 'A service case job is customer_pickup, inspection or delivery.' };
  if (sourceType !== 'dp' && !/^\d+$/.test(sourceId)) return { error: 'Invalid job id.' };
  return { sourceType, sourceId, leg };
}


async function alreadyCompleted(c: Ctx, cur: Record<string, unknown> | null) {
  const by = cur?.completed_by == null ? null : (await userNamesById(c, [Number(cur.completed_by)]))[String(cur.completed_by)] || null;
  const at = typeof cur?.completed_at === 'string' ? mytClock(cur.completed_at) : null;
  return c.json({
    error: 'already_completed',
    reason: `This job was already completed${by ? ` by ${by}` : ''}${at ? ` at ${at}` : ''}.`,
    completedBy: by, completedAt: cur?.completed_at ?? null, progress: cur,
  }, 409);
}

const tripCrew = (t: Record<string, unknown> | null | undefined): CrewAssignment => ({
  driverIds: [(t?.driver_id as string | null) ?? null],
  helperIds: [(t?.helper_1_id as string | null) ?? null, (t?.helper_2_id as string | null) ?? null],
});

export async function loadJob(c: Ctx, sourceType: SourceType, sourceId: string, leg: string): Promise<
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
        WHERE p.id = ?${allowedCompaniesSql(c, 'p.company_id')}`,
    ).bind(Number(sourceId)).first<Record<string, unknown>>();
    if (!row) return { ok: false, status: 404, error: 'not_found', reason: 'This project could not be found.' };
    if (scope.mode !== 'all') {
      const me = Number(c.get('houzsUser')?.id);
      const phases = await getUserPhasesOnProject(c.env, Number(sourceId), me, c.get('houzsUser')?.name ?? null);
      if (!phases.includes(leg === 'SETUP' ? 'setup' : 'dismantle')) return notYours;
    }
    return { ok: true, row, tripId: null, companyId: (row.company_id as number | null) ?? null };
  }

  const row = await c.env.DB.prepare(
    `SELECT id, assr_no, customer_name, phone, addr1, addr2, addr3, addr4, location, item_code,
            complaint_issue, issue_category, doc_no, stage, sub_status, company_id,
            customer_pickup_at, inspection_visit_at, do_date, ca.postcode, ca.city, ca.state
       FROM assr_cases LEFT JOIN assr_case_address ca ON ca.assr_id = assr_cases.id
      WHERE assr_cases.id = ?${allowedCompaniesSql(c)}`,
  ).bind(Number(sourceId)).first<Record<string, unknown>>();
  if (!row) return { ok: false, status: 404, error: 'not_found', reason: 'This service case could not be found.' };
  const { data: stops, error: sErr } = await sb.from('trip_stops').select('trip_id, stop_type').eq('assr_case_id', Number(sourceId));
  if (sErr) return { ok: false, status: 500, error: 'load_failed', reason: sErr.message };
  const tripIds = [...new Set(((stops ?? []) as Array<{ trip_id: string | null; stop_type: string }>)
    .filter((s) => ASSR_LEG_BY_STOP[s.stop_type] === leg).map((s) => s.trip_id).filter(Boolean))] as string[];
  if (scope.mode !== 'all') {
    if (!tripIds.length) return notYours;
    const { data: trips, error: tErr } = await sb.from('trips').select('driver_id, helper_1_id, helper_2_id').in('id', tripIds);
    if (tErr) return { ok: false, status: 500, error: 'load_failed', reason: tErr.message };
    if (!((trips ?? []) as Array<Record<string, unknown>>).some((t) => scopeMatchesAssignment(scope, tripCrew(t)))) return notYours;
  }
  return { ok: true, row, tripId: tripIds[0] ?? null, companyId: (row.company_id as number | null) ?? null };
}

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
      address: formatCaseAddress(row as unknown as CaseAddressParts) ?? '', state: row.state ?? row.location,
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
    stock_transfer_id: row.stock_transfer_id, lorry_id: row.lorry_id, work_order_id: row.work_order_id,
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the scm PostgREST client, untyped like every other route helper
export async function startTripIfPlanned(sb: any, tripId: string | null): Promise<void> {
  if (!tripId) return;
  const now = new Date().toISOString();
  const { error } = await sb.from('trips').update({ status: 'IN_PROGRESS', clock_in_at: now, updated_at: now })
    .eq('id', tripId).eq('status', 'PLANNED');
  if (error) throw new Error(error.message);
}

export async function loadJobProgressSince(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- scm-scoped supabase-js client
  sb: any,
  since: string,
  companyIds: number[] | undefined,
): Promise<{ ok: true; rows: Record<string, unknown>[] } | { ok: false; reason: string }> {
  const { data, error, truncated } = await paginateAll<Record<string, unknown>>((from, to) => {
    let q = sb.from('job_progress')
      .select('source_type, source_id, leg, departed_at, arrived_at, completed_at, pod_photo_keys')
      .gte('updated_at', since);
    if (companyIds !== undefined) q = companyIds.length ? q.or(`company_id.in.(${companyIds.join(',')}),company_id.is.null`) : q.is('company_id', null);
    return q.order('id').range(from, to);
  });
  if (error) return { ok: false, reason: error.message };
  if (truncated) return { ok: false, reason: 'More job progress rows than one read can take; narrow the window.' };
  return { ok: true, rows: data ?? [] };
}

deliveryJobProgress.get('/progress', async (c) => {
  const since = c.req.query('since') ?? '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) return c.json({ error: 'invalid_since', reason: 'since must be YYYY-MM-DD.' }, 400);
  const floor = todayMyt(-62);
  const r = await loadJobProgressSince(c.get('supabase'), since < floor ? floor : since, allowedCompanyIds(c));
  if (!r.ok) return c.json({ error: 'load_failed', reason: r.reason }, 500);
  return c.json({ progress: r.rows });
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
    const people = progress ? await namesFor(c, [progress]) : {};
    return c.json({ job: { ...job, trip_id: loaded.tripId }, context, progress, people });
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
    if (cur?.completed_at) return await alreadyCompleted(c, cur);
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
     dp linked to a document -> that DO's POD / Service Case / project phase (fileDpLinkedPhotos)
     dp (every type)         -> dp_orders.status = 'COMPLETED'
   and then makes the ONE move a person would otherwise make right after that
   job (owner, 2026-10-08) — see advanceServiceCase / tickProjectImageRow. */
deliveryJobProgress.post('/:sourceType/:sourceId/:leg/complete', async (c) => {
  const job = parseJob(c);
  if ('error' in job) return c.json({ error: 'invalid_job', reason: job.error }, 400);
  let body: { photoKeys?: unknown; notes?: unknown; lat?: unknown; lng?: unknown; accuracyM?: unknown; locatedAt?: unknown };
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const rawKeys = Array.isArray(body.photoKeys) ? body.photoKeys : [];
  if (!rawKeys.length) return c.json({ error: 'photo_required', reason: 'Take at least one POD photo before completing the job.' }, 400);
  if (rawKeys.length > MAX_PHOTOS) return c.json({ error: 'too_many_photos', reason: `At most ${MAX_PHOTOS} photos per job.` }, 400);
  const loaded = await loadJob(c, job.sourceType, job.sourceId, job.leg);
  if (!loaded.ok) return c.json({ error: loaded.error, reason: loaded.reason }, loaded.status);
  if (job.sourceType === 'dp' && String(loaded.row.status ?? '').toUpperCase() === 'CANCELLED')
    return c.json({ error: 'job_cancelled', reason: 'This job was cancelled; it cannot be completed.' }, 409);

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
    if (cur?.completed_at) return await alreadyCompleted(c, cur);
    const claim = await claimPodPhotos(sb, c, { houzsUserId: houzsUserIdOf(c), stopContext: jobStopContext(job) }, rawKeys);
    if (!claim.ok) return c.json({ error: 'photo_not_accepted', reason: claim.reason }, 400);
    const photoKeys = claim.keys;
    if (!photoKeys.length) return c.json({ error: 'photo_required', reason: 'Take at least one POD photo before completing the job.' }, 400);
    const key = { source_type: job.sourceType, source_id: job.sourceId, leg: job.leg };
    if (!cur) {
      const { error: insErr } = await sb.from('job_progress')
        .upsert({ ...key, company_id: loaded.companyId, trip_id: loaded.tripId, updated_at: now }, { onConflict: 'source_type,source_id,leg', ignoreDuplicates: true });
      if (insErr) return c.json({ error: 'update_failed', reason: insErr.message }, 500);
    }
    const { data: won, error } = await sb.from('job_progress').update({
      departed_at: cur?.departed_at ?? now, departed_by: cur?.departed_by ?? me,
      arrived_at: cur?.arrived_at ?? now, arrived_by: cur?.arrived_by ?? me,
      completed_at: now, completed_by: me, pod_photo_keys: photoKeys,
      pod_notes: typeof body.notes === 'string' && body.notes.trim() ? body.notes.trim().slice(0, 2000) : null,
      ...gps, updated_at: now,
    }).eq('source_type', key.source_type).eq('source_id', key.source_id).eq('leg', key.leg).is('completed_at', null).select('*');
    if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);
    if (!won?.length) return await alreadyCompleted(c, await readProgress(c, job.sourceType, job.sourceId, job.leg));

    try {
      await fileJobPhotos(c, job, loaded.row, photoKeys, me, 'completed by the crew');
      if (job.sourceType === 'project') {
        await tickProjectImageRow(c, Number(job.sourceId), job.leg, me);
      } else if (job.sourceType === 'assr') {
        await advanceServiceCase(c, Number(job.sourceId), job.leg, me);
      } else {
        const { error: dpErr } = await scopeToAllowedCompanies(
          sb.from('dp_orders').update({ status: 'COMPLETED', updated_at: now }).eq('id', job.sourceId), c,
        );
        if (dpErr) throw new Error(dpErr.message);
      }
    } catch (e) {
      await sb.from('job_progress').update({ completed_at: null, completed_by: null, updated_at: new Date().toISOString() })
        .eq('source_type', key.source_type).eq('source_id', key.source_id).eq('leg', key.leg);
      return c.json({ error: 'update_failed', reason: `The job was not completed: ${(e as Error).message}. Try again.` }, 500);
    }
    return c.json({ progress: won[0] });
  } catch (e) {
    return c.json({ error: 'update_failed', reason: (e as Error).message }, 500);
  }
});

async function advanceServiceCase(c: Ctx, caseId: number, leg: string, me: number | null) {
  // Read NOW, not the row loadJob read before the photos were filed.
  // company-scope: the case loadJob already admitted under the caller's company predicate
  const fresh = await c.env.DB.prepare(`SELECT stage, sub_status FROM assr_cases WHERE id = ?`).bind(caseId)
    .first<{ stage: string | null; sub_status: string | null }>();
  const stage = String(fresh?.stage ?? '');
  const sub = String(fresh?.sub_status ?? '');
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

async function tickProjectImageRow(c: Ctx, projectId: number, leg: string, me: number | null) {
  const like = leg === 'SETUP' ? 'Setup Image%' : 'Dismantle Image%';
  // company-scope: rows of the one project the crew-checked job just completed (loadJob)
  const rows = await c.env.DB.prepare(
    `SELECT id FROM project_checklist WHERE project_id = ? AND title LIKE ? AND status <> 'done' ORDER BY id`,
  ).bind(projectId, like).all<{ id: number }>();
  for (const r of rows.results ?? []) await setChecklistStatus(c.env, r.id, 'done', me ?? 0);
}

async function fileJobPhotos(c: Ctx, job: { sourceType: SourceType; sourceId: string; leg: string },
  row: Record<string, unknown>, photoKeys: string[], me: number | null, what: string) {
  if (job.sourceType === 'project') {
    await fileProjectPhotos(c, Number(job.sourceId), job.leg === 'SETUP' ? 'setup' : 'dismantle', photoKeys, me);
  } else if (job.sourceType === 'assr') {
    const legWord = job.leg === 'customer_pickup' ? 'Pickup' : job.leg === 'inspection' ? 'Inspection' : 'Delivery / service';
    await fileAssrPhotos(c, Number(job.sourceId), photoKeys, me, `${legWord} POD`, `${legWord} ${what}`);
  } else {
    if (job.leg === 'LORRY_SERVICE' && row.work_order_id) {
      const sb = c.get('supabase');
      const { data: wo, error: woErr } = await sb.from('lorry_work_orders').select('photo_refs').eq('id', row.work_order_id).maybeSingle();
      if (woErr) throw new Error(woErr.message);
      const refs = Array.isArray(wo?.photo_refs) ? (wo.photo_refs as string[]) : [];
      const { error: upErr } = await sb.from('lorry_work_orders')
        .update({ photo_refs: [...refs, ...photoKeys.filter((k) => !refs.includes(k))], updated_at: new Date().toISOString() })
        .eq('id', row.work_order_id);
      if (upErr) throw new Error(upErr.message);
    }
    await fileDpLinkedPhotos(c, job.leg, row, photoKeys, me, what);
  }
}

async function fileProjectPhotos(c: Ctx, projectId: number, phase: string, photoKeys: string[], me: number | null) {
  // company-scope: callers pass a project already read under the caller's company predicate
  const have = await c.env.DB.prepare(
    `SELECT r2_key FROM project_phase_photos WHERE project_id = ? AND r2_key IN (${photoKeys.map(() => '?').join(',')})`,
  ).bind(projectId, ...photoKeys).all<{ r2_key: string }>();
  const filed = new Set((have.results ?? []).map((r) => r.r2_key));
  for (const key of photoKeys.filter((k) => !filed.has(k))) {
    await c.env.DB.prepare(
      `INSERT INTO project_phase_photos (project_id, phase, r2_key, content_type, caption, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(projectId, phase, key, 'image/jpeg', 'POD', me).run();
  }
}

async function fileAssrPhotos(c: Ctx, caseId: number, photoKeys: string[], me: number | null, title: string, what: string) {
  // company-scope: callers pass a case already read under the caller's company predicate
  const have = await c.env.DB.prepare(
    `SELECT r2_key FROM assr_attachments WHERE assr_id = ? AND r2_key IN (${photoKeys.map(() => '?').join(',')})`,
  ).bind(caseId, ...photoKeys).all<{ r2_key: string }>();
  const filed = new Set((have.results ?? []).map((r) => r.r2_key));
  const fresh = photoKeys.filter((k) => !filed.has(k));
  if (!fresh.length) return;
  for (const key of fresh) await saveAttachment(c.env, caseId, key, null, 'image/jpeg', 'completion', me);
  await logActivity(c.env, caseId, 'attachment_added', null, title,
    `${what} (${fresh.length} POD photo${fresh.length === 1 ? '' : 's'})`,
    me, { category: 'service', source_channel: 'app' });
}

const DP_PROJECT_PHASE: Record<string, string> = {
  SETUP: 'setup', DELIVERY: 'setup', DISMANTLE: 'dismantle', PICKUP: 'dismantle', SERVICE: 'service',
};

/* A Delivery Planning job made from another document (owner, 2026-11-17: the POD
   goes back to the related document too): the Delivery Order's POD, the Service
   Case's completion photos + timeline, the project's phase photos. Each target is
   re-read under the caller's companies (and the job's own company for the DO); a
   link to a document outside them files nothing there. */
async function fileDpLinkedPhotos(c: Ctx, jobType: string, row: Record<string, unknown>, photoKeys: string[], me: number | null, what: string) {
  const jobWord = `${jobType.charAt(0)}${jobType.slice(1).toLowerCase().replace(/_/g, ' ')} job${row.dp_no ? ` ${String(row.dp_no)}` : ''}`;
  if (row.do_id) {
    const r = await appendDoPodPhotos(c.get('supabase'), c, String(row.do_id), (row.company_id as number | null) ?? null, photoKeys);
    if (!r.ok) throw new Error(r.reason);
  }
  if (row.assr_case_id != null) {
    const hit = await c.env.DB.prepare(`SELECT id FROM assr_cases WHERE id = ?${allowedCompaniesSql(c)}`)
      .bind(Number(row.assr_case_id)).first<{ id: number }>();
    if (hit) await fileAssrPhotos(c, Number(hit.id), photoKeys, me, `${jobWord} POD`, `${jobWord} ${what}`);
  }
  const phase = DP_PROJECT_PHASE[jobType];
  if (row.project_id != null && phase) {
    const hit = await c.env.DB.prepare(`SELECT id FROM projects WHERE id = ?${allowedCompaniesSql(c)}`)
      .bind(Number(row.project_id)).first<{ id: number }>();
    if (hit) await fileProjectPhotos(c, Number(hit.id), phase, photoKeys, me);
  }
}

deliveryJobProgress.post('/:sourceType/:sourceId/:leg/add-photos', async (c) => {
  const job = parseJob(c);
  if ('error' in job) return c.json({ error: 'invalid_job', reason: job.error }, 400);
  let body: { photoKeys?: unknown };
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const rawKeys = Array.isArray(body.photoKeys) ? body.photoKeys : [];
  if (!rawKeys.length) return c.json({ error: 'photo_required', reason: 'Choose at least one photo.' }, 400);
  const loaded = await loadJob(c, job.sourceType, job.sourceId, job.leg);
  if (!loaded.ok) return c.json({ error: loaded.error, reason: loaded.reason }, loaded.status);
  try {
    const claim = await claimPodPhotos(c.get('supabase'), c, { houzsUserId: houzsUserIdOf(c), stopContext: jobStopContext(job) }, rawKeys);
    if (!claim.ok) return c.json({ error: 'photo_not_accepted', reason: claim.reason }, 400);
    const photoKeys = claim.keys;
    if (!photoKeys.length) return c.json({ error: 'photo_required', reason: 'Choose at least one photo.' }, 400);
    const cur = await readProgress(c, job.sourceType, job.sourceId, job.leg);
    if (!cur?.completed_at) return c.json({ error: 'not_completed', reason: 'Complete the job first; its first photos are part of completing it.' }, 409);
    const had = (cur.pod_photo_keys as string[] | null) ?? [];
    const keys = [...had, ...photoKeys.filter((k) => !had.includes(k))];
    if (keys.length > MAX_PHOTOS * 2) return c.json({ error: 'too_many_photos', reason: `At most ${MAX_PHOTOS * 2} photos per job.` }, 400);
    const { data: progress, error } = await c.get('supabase').from('job_progress')
      .update({ pod_photo_keys: keys, updated_at: new Date().toISOString() })
      .eq('source_type', job.sourceType).eq('source_id', job.sourceId).eq('leg', job.leg).select('*').single();
    if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);
    await fileJobPhotos(c, job, loaded.row, photoKeys, Number(c.get('houzsUser')?.id) || null, 'photos added');
    return c.json({ progress });
  } catch (e) {
    return c.json({ error: 'update_failed', reason: (e as Error).message }, 500);
  }
});

deliveryJobProgress.get('/:sourceType/:sourceId/:leg/photo/:n', async (c) => {
  const job = parseJob(c);
  if ('error' in job) return c.json({ error: 'invalid_job', reason: job.error }, 400);
  const loaded = await loadJob(c, job.sourceType, job.sourceId, job.leg);
  if (!loaded.ok) return c.json({ error: loaded.error, reason: loaded.reason }, loaded.status);
  try {
    const cur = await readProgress(c, job.sourceType, job.sourceId, job.leg);
    return await streamPhoto(c, ((cur?.pod_photo_keys as string[] | null) ?? [])[Number(c.req.param('n'))]);
  } catch (e) {
    return c.json({ error: 'load_failed', reason: (e as Error).message }, 500);
  }
});

export async function streamPhoto(c: Ctx, key: string | undefined): Promise<Response> {
  if (!key) return c.json({ error: 'not_found', reason: 'No such photo.' }, 404);
  const obj = await c.env.POD_BUCKET.get(key);
  if (!obj) return c.json({ error: 'not_found', reason: 'The photo file is missing from storage.' }, 404);
  return podPhotoResponse(obj);
}

export const stockTransferDeliveryPodHandler = async (c: Ctx) => {
  const sb = c.get('supabase');
  const { data: dps, error } = await scopeToAllowedCompanies(
    sb.from('dp_orders').select('id, dp_no, status, requested_date').eq('stock_transfer_id', c.req.param('id') ?? ''), c,
  );
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  const ids = ((dps ?? []) as Array<{ id: string }>).map((d) => d.id);
  const { data: prog, error: pErr } = ids.length
    ? await sb.from('job_progress').select('*').eq('source_type', 'dp').in('source_id', ids)
    : { data: [], error: null };
  if (pErr) return c.json({ error: 'load_failed', reason: pErr.message }, 500);
  const people = await namesFor(c, (prog ?? []) as Array<Record<string, unknown>>);
  return c.json({ jobs: dps ?? [], progress: prog ?? [], people });
};
export const stockTransferDeliveryPhotoHandler = async (c: Ctx) => {
  const { data, error } = await scopeToAllowedCompanies(
    c.get('supabase').from('dp_orders').select('id').eq('id', c.req.param('dpId') ?? '').eq('stock_transfer_id', c.req.param('id') ?? ''), c,
  ).maybeSingle();
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  if (!data) return c.json({ error: 'not_found', reason: 'No such transfer job.' }, 404);
  try {
    const cur = await readProgress(c, 'dp', String((data as { id: string }).id), 'TRANSFER');
    return await streamPhoto(c, ((cur?.pod_photo_keys as string[] | null) ?? [])[Number(c.req.param('n'))]);
  } catch (e) {
    return c.json({ error: 'load_failed', reason: (e as Error).message }, 500);
  }
};

async function namesFor(c: Ctx, rows: Array<Record<string, unknown>>): Promise<Record<string, string>> {
  return userNamesById(c, rows.flatMap((r) => [r.departed_by, r.arrived_by, r.completed_by]).filter((v) => v != null).map(Number));
}

export async function userNamesById(c: Ctx, rawIds: number[]): Promise<Record<string, string>> {
  const ids = [...new Set(rawIds.filter((n) => Number.isSafeInteger(n)))];
  if (!ids.length) return {};
  // company-scope: staff names for ids already read from the caller's own job rows
  const res = await c.env.DB.prepare(`SELECT id, name FROM users WHERE id IN (${ids.map(() => '?').join(',')})`)
    .bind(...ids).all<{ id: number; name: string | null }>();
  return Object.fromEntries((res.results ?? []).map((u) => [String(u.id), u.name ?? '']));
}
