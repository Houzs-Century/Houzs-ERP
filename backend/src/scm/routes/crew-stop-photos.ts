/* The photos a stop's crew have uploaded and not yet completed, shared by the
   whole crew (owner, 2026-11-10: when the driver and the helper work the same
   delivery, their screens must show the same thing).

   Before this, GET /slips/field-photos listed only the caller's OWN uploads, so
   the driver and the helper each saw half the photos and either one's Complete
   sent only theirs.

     GET  /delivery-jobs/stop-photos?context=             every crew member's pending
                                                          photos for the stop, with who
                                                          took each (polled)
     GET  /delivery-jobs/stop-photos/:session?context=    one of those photos
     POST /delivery-jobs/stop-photos/:session/discard?context=
                                                          remove one: its uploader, or the
                                                          stop's lead (a driver on its crew,
                                                          or office with the whole board)

   Who may see a stop's photos is who may complete it: a crew member of that stop
   (DO crew for a delivery order; trip / project crew for a job — the same check
   the POD write makes), or office whose delivery scope is the whole board. A
   driver or helper NOT on the crew is refused, in the same company or not. The
   rows read are those uploaded inside the caller's granted companies. Mounted
   under the /delivery-jobs guard (transportation read, Last Mile viewers
   included; POST via scm.do.dispatch), never under /slips, whose guard admits
   any salesperson. */
import { Hono, type Context } from 'hono';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';
import { scopeToAllowedCompanies } from '../lib/companyScope';
import { resolveDeliveryScope, scopeMatchesAssignment } from '../lib/deliveryScope';
import { fieldPhotoOwnerPrefix, parseFieldPhotoContext, parseFieldPhotoDraftId, slipBindings } from '../lib/slip';
import { fetchDoCrewAssignment } from './delivery-pod-context';
import { loadJob, parseJobParts, userNamesById } from './delivery-job-progress';
import { houzsUserIdOf } from '../lib/crew-stop-complete';

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

export const crewStopPhotos = new Hono<{ Bindings: Env; Variables: Variables }>();
crewStopPhotos.use('*', supabaseAuth);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A stop holds at most 20 photos (MAX_POD_KEYS); the rest of a long list is several phones' retakes.
const STOP_PHOTO_LIST_MAX = 100;

export type StopRef =
  | { kind: 'do'; doId: string }
  | { kind: 'job'; sourceType: 'dp' | 'project' | 'assr'; sourceId: string; leg: string };

export function parseStopContext(raw: unknown): StopRef | null {
  const ctx = parseFieldPhotoContext(raw);
  if (!ctx) return null;
  if (ctx.startsWith('do:')) {
    const doId = ctx.slice(3);
    return UUID.test(doId) ? { kind: 'do', doId } : null;
  }
  const parts = ctx.split(':');
  if (parts.length !== 4 || parts[0] !== 'job') return null;
  const job = parseJobParts(parts[1]!, parts[2]!, parts[3]!);
  return 'error' in job ? null : { kind: 'job', ...job };
}


type Access = { ok: true; lead: boolean } | { ok: false; status: 403 | 404 | 500; error: string; reason: string };

/* May the caller see this stop's photos, and are they its lead? */
export async function stopAccess(c: Ctx, stop: StopRef): Promise<Access> {
  const sb = c.get('supabase');
  const scope = await resolveDeliveryScope(sb, c.get('houzsUser'));
  const notYours = { ok: false as const, status: 403 as const, error: 'not_your_job', reason: 'Only the crew of this stop can see its photos.' };
  if (stop.kind === 'do') {
    const { data, error } = await scopeToAllowedCompanies(sb.from('delivery_orders').select('id').eq('id', stop.doId), c).maybeSingle();
    if (error) return { ok: false, status: 500, error: 'load_failed', reason: error.message };
    if (!data) return { ok: false, status: 404, error: 'not_found', reason: 'This delivery order could not be found.' };
    if (scope.mode === 'all') return { ok: true, lead: true };
    const crew = await fetchDoCrewAssignment(sb, stop.doId);
    if (!scopeMatchesAssignment(scope, crew)) return notYours;
    return { ok: true, lead: crew.driverIds.some((d) => !!d && scope.driverIds.has(String(d))) };
  }
  const loaded = await loadJob(c, stop.sourceType, stop.sourceId, stop.leg);
  if (!loaded.ok) return loaded.status === 403 ? notYours : { ok: false, status: loaded.status, error: loaded.error, reason: loaded.reason };
  if (scope.mode === 'all') return { ok: true, lead: true };
  if (stop.sourceType === 'project') {
    const col = stop.leg === 'SETUP' ? 'setup_driver_user_id' : 'dismantle_driver_user_id';
    return { ok: true, lead: Number(loaded.row[col]) === houzsUserIdOf(c) };
  }
  if (!loaded.tripId) return { ok: true, lead: false };
  const { data: trip, error } = await sb.from('trips').select('driver_id').eq('id', loaded.tripId).maybeSingle();
  if (error) return { ok: false, status: 500, error: 'load_failed', reason: error.message };
  const driverId = (trip as { driver_id?: string | null } | null)?.driver_id;
  return { ok: true, lead: !!driverId && scope.driverIds.has(String(driverId)) };
}

async function admit(c: Ctx): Promise<{ context: string; access: Extract<Access, { ok: true }> } | Response> {
  const context = parseFieldPhotoContext(c.req.query('context'));
  const stop = context ? parseStopContext(context) : null;
  if (!context || !stop) return c.json({ error: 'invalid_request', reason: 'missing or invalid context' }, 400);
  if (houzsUserIdOf(c) == null) return c.json({ error: 'Sign in again to see the photos.' }, 401);
  const access = await stopAccess(c, stop);
  if (!access.ok) return c.json({ error: access.error, reason: access.reason }, access.status);
  return { context, access };
}

type SlipRow = { id: string; upload_session_id: string; r2_key: string; content_type: string | null; status: string; order_draft_id: string | null; created_at: string; expires_at: string };

crewStopPhotos.get('/stop-photos', async (c) => {
  const admitted = await admit(c);
  if (admitted instanceof Response) return admitted;
  const { context, access } = admitted;
  const me = houzsUserIdOf(c)!;
  // `like` narrows by the stop; the exact context is checked on each row below,
  // since `_` in a leg name is a LIKE wildcard.
  const { data, error } = await scopeToAllowedCompanies(
    c.get('supabase').from('pending_slip_uploads')
      .select('upload_session_id, r2_key, content_type, created_at, order_draft_id')
      .like('order_draft_id', `field:u%:${context}`)
      .eq('status', 'uploaded')
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: true })
      .limit(STOP_PHOTO_LIST_MAX),
    c,
  );
  if (error) return c.json({ error: 'db_fetch_failed', reason: error.message }, 500);
  const rows = (data as SlipRow[])
    .map((r) => ({ r, owner: parseFieldPhotoDraftId(r.order_draft_id) }))
    .filter((x): x is { r: SlipRow; owner: { uploaderId: number; context: string } } => x.owner?.context === context);
  const names = await userNamesById(c, rows.map((x) => x.owner.uploaderId));
  return c.json({
    photos: rows.map(({ r, owner }) => ({
      uploadSessionId: r.upload_session_id,
      r2Key: r.r2_key,
      contentType: r.content_type,
      createdAt: r.created_at,
      uploadedBy: { id: owner.uploaderId, name: names[String(owner.uploaderId)] || null },
      mine: owner.uploaderId === me,
      canRemove: owner.uploaderId === me || access.lead,
    })),
  });
});

async function stopPhoto(c: Ctx, context: string, sessionId: string): Promise<SlipRow | null | { error: string }> {
  const { data, error } = await scopeToAllowedCompanies(
    c.get('supabase').from('pending_slip_uploads')
      .select('id, upload_session_id, r2_key, content_type, status, order_draft_id, created_at, expires_at')
      .eq('upload_session_id', sessionId),
    c,
  ).maybeSingle();
  if (error) return { error: error.message };
  const row = data as SlipRow | null;
  return row && parseFieldPhotoDraftId(row.order_draft_id)?.context === context ? row : null;
}

crewStopPhotos.get('/stop-photos/:session', async (c) => {
  const admitted = await admit(c);
  if (admitted instanceof Response) return admitted;
  const row = await stopPhoto(c, admitted.context, c.req.param('session'));
  if (row && 'error' in row) return c.json({ error: 'db_fetch_failed', reason: row.error }, 500);
  if (!row || row.status !== 'uploaded') return c.json({ error: 'photo_not_found' }, 404);
  let bindings;
  try { bindings = slipBindings(c.env); }
  catch (e) { return c.json({ error: 'r2_not_configured', reason: (e as Error).message }, 500); }
  const obj = await bindings.bucket.get(row.r2_key);
  if (!obj) return c.json({ error: 'photo_not_found' }, 404);
  return new Response(obj.body as unknown as ReadableStream, {
    headers: { 'content-type': row.content_type ?? 'image/jpeg', 'cache-control': 'private, max-age=600' },
  });
});

/* Expiring the session hands it to the slip reaper, the same end as every
   unclaimed upload. A photo a Complete already claimed is part of the delivery
   record and is refused. */
crewStopPhotos.post('/stop-photos/:session/discard', async (c) => {
  const admitted = await admit(c);
  if (admitted instanceof Response) return admitted;
  const row = await stopPhoto(c, admitted.context, c.req.param('session'));
  if (row && 'error' in row) return c.json({ error: 'db_fetch_failed', reason: row.error }, 500);
  if (!row) return c.json({ error: 'photo_not_found' }, 404);
  const mine = (row.order_draft_id ?? '').startsWith(fieldPhotoOwnerPrefix(houzsUserIdOf(c)!));
  if (!mine && !admitted.access.lead) {
    return c.json({ error: 'not_yours', reason: 'Only the person who took this photo, or the driver, can remove it.' }, 403);
  }
  if (row.status === 'promoted') {
    return c.json({ error: 'already_completed', reason: 'This photo is already part of a completed job and cannot be removed here.' }, 409);
  }
  if (row.status !== 'pending' && row.status !== 'uploaded') return c.json({ ok: true });
  const { error } = await scopeToAllowedCompanies(
    c.get('supabase').from('pending_slip_uploads')
      .update({ expires_at: new Date().toISOString() })
      .eq('id', row.id)
      .in('status', ['pending', 'uploaded']),
    c,
  );
  if (error) return c.json({ error: 'db_update_failed', reason: error.message }, 500);
  return c.json({ ok: true });
});

export default crewStopPhotos;
