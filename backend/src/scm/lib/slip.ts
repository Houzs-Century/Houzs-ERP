import type { R2Bucket } from '@cloudflare/workers-types';

export interface SlipEnv {
  // Optional so the route's c.env (Houzs Env) is assignable; slipBindings below
  // guards it (throws if unset) for a clear runtime error.
  //
  // 2026-07-04 — the slip flow no longer needs R2 S3-API creds
  // (R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_ENDPOINT / R2_BUCKET_NAME):
  // browser presigned PUT/HEAD/GET were replaced by Worker-proxy upload +
  // binding-served reads (slips.ts / mfg-sales-orders.ts slip-url routes).
  // Everything goes through the SLIPS binding, now bound in wrangler.toml.
  SLIPS?: R2Bucket;
}

export interface SlipBindings {
  bucket: R2Bucket;
}

export function slipBindings(env: SlipEnv): SlipBindings {
  if (!env.SLIPS) throw new Error('R2 binding SLIPS not configured');
  return { bucket: env.SLIPS };
}

export function hashesMatch(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

export function isExpired(isoTimestamp: string): boolean {
  return new Date(isoTimestamp).getTime() < Date.now();
}

export function expiresInOneHour(now = new Date()): string {
  return new Date(now.getTime() + 60 * 60 * 1000).toISOString();
}

/* A field photo (POD / job stop) is uploaded the moment it is taken, but the
   job is completed - and the upload claimed - only when the crew finishes,
   which on an installation can be hours later. An hour-long session would let
   the slip reaper delete the photo first, so these sessions are held for a day.
   An unclaimed one (a photo the crew removed, a job never completed) is still
   reaped after that. */
export const FIELD_PHOTO_HOLD_HOURS = 24;

export type SlipPurpose = 'field_photo';

export function parseSlipPurpose(raw: unknown): SlipPurpose | null {
  return raw === 'field_photo' ? 'field_photo' : null;
}

export function slipSessionExpiry(purpose: SlipPurpose | null, now = new Date()): string {
  if (purpose === 'field_photo') return new Date(now.getTime() + FIELD_PHOTO_HOLD_HOURS * 60 * 60 * 1000).toISOString();
  return expiresInOneHour(now);
}

/* Which stop a field photo belongs to, so the photos already uploaded can be
   listed again after the page reloads (iOS often reloads it under the camera).
   Stored in pending_slip_uploads.order_draft_id - "the draft this upload is
   for", a nullable text column nothing else in this codebase reads or writes
   (checked against the prod schema dump, run 42635335025) - so no migration.
   The REAL Houzs user id is part of it because staff_id on this table is the
   pinned SCM system staff for every caller (scm/middleware/auth.ts), so it
   cannot tell two users apart; the prefix is what keeps a list to the
   caller's own photos. */
export const FIELD_PHOTO_CONTEXT_MAX = 200;

export function parseFieldPhotoContext(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s || s.length > FIELD_PHOTO_CONTEXT_MAX) return null;
  // eslint-disable-next-line no-control-regex -- refusing control characters is the point
  if (/[\u0000-\u001f\u007f]/.test(s)) return null;
  return s;
}

export function fieldPhotoOwnerPrefix(houzsUserId: number): string {
  return `field:u${houzsUserId}:`;
}

export function fieldPhotoDraftId(houzsUserId: number, context: string): string {
  return `${fieldPhotoOwnerPrefix(houzsUserId)}${context}`;
}

/* Who uploaded a slip and for which stop. Every upload records its real
   uploader since crew sharing (2026-11-10): a crew member's photos are listed
   and claimed by the stop, so the uploader is the only thing left that says
   whose a photo is. context '' = an upload for no stop (a payment slip, a
   problem photo). null = a row from before the uploader was recorded. */
export function parseFieldPhotoDraftId(draftId: string | null | undefined): { uploaderId: number; context: string } | null {
  const m = /^field:u(\d+):(.*)$/s.exec(draftId ?? '');
  if (!m) return null;
  const uploaderId = Number(m[1]);
  return Number.isSafeInteger(uploaderId) ? { uploaderId, context: m[2]! } : null;
}
