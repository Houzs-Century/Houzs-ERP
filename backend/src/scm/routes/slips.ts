
import { Hono, type Context } from 'hono';
import type { User } from '@supabase/supabase-js';
import { supabaseAuth } from '../middleware/auth';
import { activeCompanyId, scopeToCompany } from '../lib/companyScope';
import type { Env, Variables } from '../env';
import {
  slipBindings, slipSessionExpiry, parseSlipPurpose, hashesMatch, isExpired,
  parseFieldPhotoContext, fieldPhotoDraftId, fieldPhotoOwnerPrefix,
} from '../lib/slip';
import { buildSlipKey, r2Head, type SlipMime } from '../lib/r2';

export const slips = new Hono<{ Bindings: Env; Variables: Variables }>();
slips.use('*', supabaseAuth);

function houzsUserIdOf(c: Context<{ Bindings: Env; Variables: Variables }>): number | null {
  const id = c.get('houzsUser')?.id;
  return typeof id === 'number' && Number.isFinite(id) ? id : null;
}

const FIELD_PHOTO_LIST_MAX = 100;

const ALLOWED_MIMES: ReadonlySet<SlipMime> = new Set<SlipMime>([
  'image/jpeg', 'image/png', 'image/webp', 'application/pdf',
]);
const MAX_SLIP_SIZE_BYTES = 5 * 1024 * 1024;

slips.post('/init', async (c) => {
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; }
  catch { return c.json({ error: 'invalid_json' }, 400); }

  const contentType = (body.contentType ?? body.content_type) as string | undefined;
  const fileSize = Number(body.fileSize ?? body.file_size ?? NaN);
  const contentHash = (body.contentHash ?? body.content_hash) as string | undefined;
  const purpose = parseSlipPurpose(body.purpose);
  const rawContext = body.fieldContext ?? body.field_context;
  const fieldContext = purpose === 'field_photo' && rawContext != null ? parseFieldPhotoContext(rawContext) : null;
  if (purpose === 'field_photo' && rawContext != null && !fieldContext) {
    return c.json({ error: 'invalid_request', reason: 'invalid field_context' }, 400);
  }

  if (!contentType || !ALLOWED_MIMES.has(contentType as SlipMime)) {
    return c.json({ error: 'invalid_request', reason: 'unsupported content_type' }, 400);
  }
  if (!Number.isFinite(fileSize) || fileSize <= 0 || fileSize > MAX_SLIP_SIZE_BYTES) {
    return c.json({ error: 'invalid_request', reason: 'invalid file_size' }, 400);
  }
  if (!contentHash || typeof contentHash !== 'string') {
    return c.json({ error: 'invalid_request', reason: 'missing content_hash' }, 400);
  }

  const sb = c.get('supabase');
  const staffId = (c.get('user') as User).id;
  try { slipBindings(c.env); }
  catch (e) { return c.json({ error: 'r2_not_configured', reason: (e as Error).message }, 500); }

  let roomQ = sb
    .from('showrooms')
    .select('id')
    .eq('active', true)
    .order('sort_order', { ascending: true })
    .limit(1);
  roomQ = scopeToCompany(roomQ, c);
  const { data: defaultRoom, error: roomErr } = await roomQ.maybeSingle();
  if (roomErr) return c.json({ error: 'showroom_lookup_failed', reason: roomErr.message }, 500);
  const showroomId = (defaultRoom as { id?: string } | null)?.id ?? null;

  const sessionId = crypto.randomUUID();
  const r2Key = buildSlipKey(sessionId, contentType as SlipMime);
  const expiresAt = slipSessionExpiry(purpose);
  const uid = houzsUserIdOf(c);
  const draftId = uid != null ? fieldPhotoDraftId(uid, fieldContext ?? '') : null;

  const { error: insertErr } = await sb.from('pending_slip_uploads').insert({
    company_id: activeCompanyId(c),
    id: sessionId,
    upload_session_id: sessionId,
    staff_id: staffId,
    showroom_id: showroomId,
    r2_key: r2Key,
    content_type: contentType,
    content_hash: contentHash,
    content_size: Math.round(fileSize),
    status: 'pending',
    expires_at: expiresAt,
    ...(draftId ? { order_draft_id: draftId } : {}),
  });
  if (insertErr) return c.json({ error: 'db_insert_failed', reason: insertErr.message }, 500);

  return c.json({ uploadSessionId: sessionId, r2Key });
});

slips.post('/:session/upload', async (c) => {
  const sessionId = c.req.param('session');
  const sb = c.get('supabase');
  let bindings;
  try { bindings = slipBindings(c.env); }
  catch (e) { return c.json({ error: 'r2_not_configured', reason: (e as Error).message }, 500); }

  let rowQ = sb
    .from('pending_slip_uploads')
    .select('id, r2_key, content_type, content_hash, content_size, status, expires_at')
    .eq('upload_session_id', sessionId);
  rowQ = scopeToCompany(rowQ, c);
  const { data: row, error: fetchErr } = await rowQ.maybeSingle();
  if (fetchErr) return c.json({ error: 'db_fetch_failed', reason: fetchErr.message }, 500);
  if (!row) return c.json({ error: 'session_not_found' }, 404);

  const r = row as {
    id: string; r2_key: string; content_type: string; content_hash: string;
    content_size: number | null; status: string; expires_at: string;
  };
  if (r.status === 'uploaded') return c.json({ ok: true });
  if (r.status !== 'pending') {
    return c.json({ error: 'invalid_state', currentStatus: r.status }, 409);
  }
  if (isExpired(r.expires_at)) return c.json({ error: 'session_expired' }, 410);

  const contentType = c.req.header('content-type') ?? '';
  if (contentType !== r.content_type) {
    return c.json({ error: 'invalid_request', reason: 'content-type mismatch with init' }, 400);
  }

  const buf = await c.req.arrayBuffer();
  if (buf.byteLength <= 0 || buf.byteLength > MAX_SLIP_SIZE_BYTES) {
    return c.json({ error: 'invalid_request', reason: 'invalid body size' }, 400);
  }
  if (r.content_size != null && buf.byteLength !== r.content_size) {
    return c.json({ error: 'size_mismatch', expected: r.content_size, actual: buf.byteLength }, 400);
  }
  const digest = await crypto.subtle.digest('SHA-256', buf);
  const actualHash = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0')).join('');
  if (!hashesMatch(actualHash, r.content_hash)) {
    return c.json({ error: 'hash_mismatch' }, 400);
  }

  await bindings.bucket.put(r.r2_key, buf, { httpMetadata: { contentType: r.content_type } });

  return c.json({ ok: true });
});

slips.post('/:session/confirm', async (c) => {
  const sessionId = c.req.param('session');
  const sb = c.get('supabase');
  let bindings;
  try { bindings = slipBindings(c.env); }
  catch (e) { return c.json({ error: 'r2_not_configured', reason: (e as Error).message }, 500); }

  let rowQ = sb
    .from('pending_slip_uploads')
    .select('id, r2_key, content_size, status')
    .eq('upload_session_id', sessionId);
  rowQ = scopeToCompany(rowQ, c);
  const { data: row, error: fetchErr } = await rowQ.maybeSingle();
  if (fetchErr) return c.json({ error: 'db_fetch_failed', reason: fetchErr.message }, 500);
  if (!row) return c.json({ error: 'session_not_found' }, 404);

  const r = row as { id: string; r2_key: string; content_size: number | null; status: string };
  if (r.status === 'uploaded') return c.json({ ok: true });
  if (r.status !== 'pending') {
    return c.json({ error: 'invalid_state', currentStatus: r.status }, 409);
  }

  const head = await r2Head(bindings.bucket, r.r2_key);
  if (!head) return c.json({ error: 'file_not_in_r2' }, 404);

  if (r.content_size != null && head.size !== r.content_size) {
    await sb.from('pending_slip_uploads')
      .update({ status: 'failed', error_msg: 'size_mismatch' })
      .eq('upload_session_id', sessionId);
    await bindings.bucket.delete(r.r2_key).catch(() => {});
    return c.json({ error: 'size_mismatch', expected: r.content_size, actual: head.size }, 400);
  }

  const { error: updateErr } = await sb
    .from('pending_slip_uploads')
    .update({ status: 'uploaded' })
    .eq('upload_session_id', sessionId);
  if (updateErr) return c.json({ error: 'db_update_failed', reason: updateErr.message }, 500);

  return c.json({ ok: true });
});

slips.get('/field-photos', async (c) => {
  const context = parseFieldPhotoContext(c.req.query('context'));
  if (!context) return c.json({ error: 'invalid_request', reason: 'missing or invalid context' }, 400);
  const uid = houzsUserIdOf(c);
  if (uid == null) return c.json({ error: 'Sign in again to see your photos.' }, 401);
  const sb = c.get('supabase');
  let q = sb
    .from('pending_slip_uploads')
    .select('upload_session_id, r2_key, content_type, created_at')
    .eq('order_draft_id', fieldPhotoDraftId(uid, context))
    .eq('status', 'uploaded')
    .gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: true })
    .limit(FIELD_PHOTO_LIST_MAX);
  q = scopeToCompany(q, c);
  const { data, error } = await q;
  if (error) return c.json({ error: 'db_fetch_failed', reason: error.message }, 500);
  const rows = data as Array<{ upload_session_id: string; r2_key: string; content_type: string | null; created_at: string }>;
  return c.json({
    photos: rows.map((r) => ({ uploadSessionId: r.upload_session_id, r2Key: r.r2_key, contentType: r.content_type, createdAt: r.created_at })),
  });
});

async function ownFieldPhoto(c: Context<{ Bindings: Env; Variables: Variables }>, sessionId: string) {
  const uid = houzsUserIdOf(c);
  if (uid == null) return { status: 401 as const };
  let q = c.get('supabase')
    .from('pending_slip_uploads')
    .select('id, r2_key, content_type, status, order_draft_id')
    .eq('upload_session_id', sessionId);
  q = scopeToCompany(q, c);
  const { data, error } = await q.maybeSingle();
  if (error) return { status: 500 as const, reason: error.message };
  const row = data as { id: string; r2_key: string; content_type: string | null; status: string; order_draft_id: string | null } | null;
  if (!row?.order_draft_id?.startsWith(fieldPhotoOwnerPrefix(uid))) return { status: 404 as const };
  return { status: 200 as const, row };
}

slips.get('/field-photos/:session/image', async (c) => {
  const own = await ownFieldPhoto(c, c.req.param('session'));
  if (own.status === 401) return c.json({ error: 'Sign in again to see your photos.' }, 401);
  if (own.status === 500) return c.json({ error: 'db_fetch_failed', reason: own.reason }, 500);
  if (own.status === 404 || own.row.status !== 'uploaded') return c.json({ error: 'photo_not_found' }, 404);
  let bindings;
  try { bindings = slipBindings(c.env); }
  catch (e) { return c.json({ error: 'r2_not_configured', reason: (e as Error).message }, 500); }
  const obj = await bindings.bucket.get(own.row.r2_key);
  if (!obj) return c.json({ error: 'photo_not_found' }, 404);
  return new Response(obj.body as unknown as ReadableStream, {
    headers: { 'content-type': own.row.content_type ?? 'image/jpeg', 'cache-control': 'private, max-age=600' },
  });
});

slips.post('/field-photos/:session/discard', async (c) => {
  const sessionId = c.req.param('session');
  const own = await ownFieldPhoto(c, sessionId);
  if (own.status === 401) return c.json({ error: 'Sign in again to remove this photo.' }, 401);
  if (own.status === 500) return c.json({ error: 'db_fetch_failed', reason: own.reason }, 500);
  if (own.status === 404) return c.json({ error: 'photo_not_found' }, 404);
  if (own.row.status === 'promoted') {
    return c.json({ error: 'This photo is already part of a completed job and cannot be removed here.' }, 409);
  }
  if (own.row.status !== 'pending' && own.row.status !== 'uploaded') return c.json({ ok: true });
  let up = c.get('supabase')
    .from('pending_slip_uploads')
    .update({ expires_at: new Date().toISOString() })
    .eq('id', own.row.id)
    .in('status', ['pending', 'uploaded']);
  up = scopeToCompany(up, c);
  const { error } = await up;
  if (error) return c.json({ error: 'db_update_failed', reason: error.message }, 500);
  return c.json({ ok: true });
});

export default slips;
