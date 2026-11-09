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
