// ---------------------------------------------------------------------------
// /slips — payment-slip Worker-proxy upload session (init → upload → confirm).
// Ported from 2990's apps/api/src/routes/slips.ts and adapted to Houzs
// conventions.
//
// 2026-07-04 — CONVERTED from 2990's browser presigned-PUT flow to a
// Worker-proxy upload (like the branding-logo raw-binary POST and the scan
// multipart uploads). The presign path needed R2 S3-API creds
// (R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY) that were never created, so every
// /slips/init 500'd "R2 binding SLIPS not configured". Now ONLY the SLIPS R2
// binding (wrangler.toml) is needed; presign/r2HeadViaS3 are gone from this
// flow entirely.
//
// The frontend (frontend/src/vendor/scm/lib/slip.ts: initSlipUpload →
// uploadSlipBytes → confirmUpload, via uploadSlipFull ← SlipUploadField ←
// PaymentsTable ← New SO, + the mobile PayCard / MobilePOD callers) calls:
//   POST /slips/init               { fileSize, contentType, contentHash }
//                                  → { uploadSessionId, r2Key }   (NO putUrl)
//   POST /slips/:session/upload    raw binary body (content-type header)
//                                  → { ok: true }
//   POST /slips/:session/confirm   → { ok: true } (frontend only checks res.ok)
//
// The SO-create + add-payment handlers (mfg-sales-orders.ts) CONSUME the
// resulting pending_slip_uploads row by upload_session_id, accepting only
// status 'uploaded' (then promoting to 'promoted'). This route PRODUCES that
// row. The session vocabulary (pending → uploaded → promoted/failed, r2_key
// via buildSlipKey, reaper deletes via the SLIPS binding) is unchanged.
//
// Houzs adaptations vs 2990:
//   - Auth: supabaseAuth (same as the other ported routes) attaches the
//     scm-scoped service client + the SCM_SYSTEM_STAFF_ID user. RLS does not
//     apply (service role), so the showroom fallback below is purely to
//     satisfy the NOT NULL FK pending_slip_uploads.showroom_id → scm.showrooms.
//   - R2: native SLIPS binding put/head/delete — no S3 API, no presigned URLs.
//   - camelCase??snake_case dual-read on the request body.
// ---------------------------------------------------------------------------

import { Hono } from 'hono';
import type { User } from '@supabase/supabase-js';
import { supabaseAuth } from '../middleware/auth';
import { activeCompanyId, scopeToCompany } from '../lib/companyScope';
import type { Env, Variables } from '../env';
import { slipBindings, expiresInOneHour, hashesMatch, isExpired } from '../lib/slip';
import { buildSlipKey, r2Head, type SlipMime } from '../lib/r2';

export const slips = new Hono<{ Bindings: Env; Variables: Variables }>();
slips.use('*', supabaseAuth);

const ALLOWED_MIMES: ReadonlySet<SlipMime> = new Set<SlipMime>([
  'image/jpeg', 'image/png', 'image/webp', 'application/pdf',
]);
// Mirror the frontend's MAX_SLIP_SIZE_BYTES (5 MiB) — a hard ceiling so a
// bad/huge upload can't land an oversized R2 object.
const MAX_SLIP_SIZE_BYTES = 5 * 1024 * 1024;

slips.post('/init', async (c) => {
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; }
  catch { return c.json({ error: 'invalid_json' }, 400); }

  // Dual-read camelCase ?? snake_case (the frontend sends camelCase).
  const contentType = (body.contentType ?? body.content_type) as string | undefined;
  const fileSize = Number(body.fileSize ?? body.file_size ?? NaN);
  const contentHash = (body.contentHash ?? body.content_hash) as string | undefined;

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
  // Fail fast when the SLIPS binding is missing — better a clear 500 on init
  // than a session row whose /upload can never succeed.
  try { slipBindings(c.env); }
  catch (e) { return c.json({ error: 'r2_not_configured', reason: (e as Error).message }, 500); }

  // pending_slip_uploads.showroom_id is NOT NULL (FK → scm.showrooms). Houzs
  // has no showroom concept and the system staff carries none, so stamp the
  // first active showroom (by sort_order). 2990 did the same fallback for
  // elevated roles. No showroom seeded → a clear error rather than a FK 500.
  // Multi-company (mig 0089): pick the ACTIVE company's showroom.
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
  if (!showroomId) return c.json({ error: 'no_active_showroom' }, 400);

  const sessionId = crypto.randomUUID();
  const r2Key = buildSlipKey(sessionId, contentType as SlipMime);
  const expiresAt = expiresInOneHour();

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
  });
  if (insertErr) return c.json({ error: 'db_insert_failed', reason: insertErr.message }, 500);

  // Proxy-upload flow: the browser next POSTs the raw bytes to
  // /slips/:session/upload — no presigned putUrl (see header comment).
  return c.json({ uploadSessionId: sessionId, r2Key });
});

/* Worker-proxy upload — raw binary body (like the branding-logo POST), written
   straight through the SLIPS binding. Replaces the browser presigned PUT.
   Validations mirror /init and are now STRICT on content: the Worker holds the
   bytes, so size AND sha-256 hash are asserted against the session row (the
   presign flow could only check size after the fact). */
slips.post('/:session/upload', async (c) => {
  const sessionId = c.req.param('session');
  const sb = c.get('supabase');
  let bindings;
  try { bindings = slipBindings(c.env); }
  catch (e) { return c.json({ error: 'r2_not_configured', reason: (e as Error).message }, 500); }

  // The session id is an unguessable random uuid, but that is obscurity, not an
  // authorization boundary — it travels to the client and rides in SO-create
  // bodies. The client is service-role, so this ACTIVE-company filter (matching
  // /init's stamp) is the real one. All three legs of uploadSlipFull send the
  // same X-Company-Id, so a legitimate upload always matches; a session from the
  // other company falls into the existing session_not_found 404 and reveals
  // nothing more than an unknown id already did.
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
  // Idempotent re-POST of an already-uploaded session is a no-op success (the
  // frontend retries the upload step once on failure). Promoted/failed rows
  // are a hard state error; expired sessions are refused so the reaper and a
  // late upload can't race (client just re-inits).
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

  // Status stays 'pending' — /confirm verifies the object landed and flips to
  // 'uploaded', preserving the session vocabulary the consumers + reaper use.
  return c.json({ ok: true });
});

slips.post('/:session/confirm', async (c) => {
  const sessionId = c.req.param('session');
  const sb = c.get('supabase');
  let bindings;
  try { bindings = slipBindings(c.env); }
  catch (e) { return c.json({ error: 'r2_not_configured', reason: (e as Error).message }, 500); }

  // Same isolation boundary as /upload — see the note there. The status UPDATEs
  // below stay keyed on upload_session_id alone: they are reachable only through
  // this scoped fetch, which has already proved the row is the active company's.
  let rowQ = sb
    .from('pending_slip_uploads')
    .select('id, r2_key, content_size, status')
    .eq('upload_session_id', sessionId);
  rowQ = scopeToCompany(rowQ, c);
  const { data: row, error: fetchErr } = await rowQ.maybeSingle();
  if (fetchErr) return c.json({ error: 'db_fetch_failed', reason: fetchErr.message }, 500);
  if (!row) return c.json({ error: 'session_not_found' }, 404);

  const r = row as { id: string; r2_key: string; content_size: number | null; status: string };
  // Idempotent confirm — a re-confirm of an already-uploaded session is a no-op
  // success (the frontend only checks res.ok). A promoted/failed row is a hard
  // state error.
  if (r.status === 'uploaded') return c.json({ ok: true });
  if (r.status !== 'pending') {
    return c.json({ error: 'invalid_state', currentStatus: r.status }, 409);
  }

  // Verify the proxy upload actually landed in R2 — via the SLIPS binding
  // (both /upload and /confirm go through the binding now, so dev Miniflare
  // and prod hit the same backend; the old r2HeadViaS3 dual-backend concern
  // died with the presign flow).
  const head = await r2Head(bindings.bucket, r.r2_key);
  if (!head) return c.json({ error: 'file_not_in_r2' }, 404);

  // Size check (belt-and-braces — /upload already asserted size AND sha-256
  // against the session row before writing).
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

export default slips;
