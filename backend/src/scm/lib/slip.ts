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
