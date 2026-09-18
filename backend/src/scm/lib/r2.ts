import type { R2Bucket } from '@cloudflare/workers-types';

export type SlipMime = 'image/jpeg' | 'image/png' | 'image/webp' | 'application/pdf';

const MIME_EXT: Record<SlipMime, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
};

export function extensionFromMime(mime: SlipMime): string {
  const ext = MIME_EXT[mime];
  if (!ext) throw new Error(`unsupported mime: ${mime}`);
  return ext;
}

export function mimeFromKey(key: string): SlipMime {
  const ext = key.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'jpg': case 'jpeg': return 'image/jpeg';
    case 'png': return 'image/png';
    case 'webp': return 'image/webp';
    case 'pdf': return 'application/pdf';
    default: throw new Error(`unknown slip extension: ${key}`);
  }
}

export function buildSlipKey(uploadSessionId: string, mime: SlipMime, now = new Date()): string {
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `slips/${yyyy}/${mm}/${uploadSessionId}.${extensionFromMime(mime)}`;
}

export interface PresignArgs {
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  endpoint: string;
  key: string;
  method: 'GET' | 'PUT' | 'HEAD';
  expiresInSeconds: number;
  contentType?: string;
}

// Cloudflare R2 supports presigned URLs only via the S3-compatible API,
// not the native Workers binding. Sign manually with Web Crypto to avoid
// bundling the AWS SDK.
//
// 2026-07-04 — the payment-slip flow NO LONGER uses presign: it was converted
// to a Worker-proxy upload + binding-served reads (routes/slips.ts,
// mfg-sales-orders.ts slip-url routes) because the R2 S3 creds were never
// provisioned. presign() remains ONLY for the SO-item-photo signed GET URLs
// below (soItemPhotoBindings), which still need those creds.
export async function presign(args: PresignArgs): Promise<string> {
  const { bucket, accessKeyId, secretAccessKey, endpoint, key, method, expiresInSeconds } = args;
  const url = new URL(`${endpoint}/${bucket}/${encodeURI(key)}`);
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const region = 'auto';
  const service = 's3';
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;

  const params: Record<string, string> = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${accessKeyId}/${credentialScope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(expiresInSeconds),
    'X-Amz-SignedHeaders': 'host',
  };
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const canonicalQuery = [...url.searchParams.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');

  const canonicalHeaders = `host:${url.host}\n`;
  const canonicalRequest = [
    method,
    url.pathname,
    canonicalQuery,
    canonicalHeaders,
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const enc = new TextEncoder();
  const hash = async (data: string | Uint8Array): Promise<string> => {
    const buf = typeof data === 'string' ? enc.encode(data) : data;
    const out = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(out)).map((b) => b.toString(16).padStart(2, '0')).join('');
  };

  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    await hash(canonicalRequest),
  ].join('\n');

  const hmac = async (keyBytes: ArrayBuffer | Uint8Array, msg: string): Promise<ArrayBuffer> => {
    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      keyBytes as ArrayBuffer,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    return crypto.subtle.sign('HMAC', cryptoKey, enc.encode(msg));
  };

  const kDate = await hmac(enc.encode(`AWS4${secretAccessKey}`), dateStamp);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  const kSigning = await hmac(kService, 'aws4_request');
  const sig = Array.from(new Uint8Array(await hmac(kSigning, stringToSign)))
    .map((b) => b.toString(16).padStart(2, '0')).join('');

  url.searchParams.set('X-Amz-Signature', sig);
  return url.toString();
}

// ── Task #92 — SO item photo signed-URL helpers ──────────────────────
//
// The slip flow uses presigned PUTs (browser → R2 direct upload). The
// SO item photo flow goes the other direction: upload still proxies
// through the Worker (multipart parse), but READS hand out short-lived
// signed GET URLs so thumbnail rendering doesn't pay an N² Worker cost.
//
// We sign with the account-wide R2 access key (R2_ACCESS_KEY_ID +
// R2_SECRET_ACCESS_KEY) scoped to the SO photo bucket by name.

export interface SoItemPhotoBindings {
  bucketName: string;
  accessKeyId: string;
  secretAccessKey: string;
  endpoint: string;
}

export interface SoItemPhotoEnv {
  // Optional so the route's c.env (Houzs Env) is assignable; soItemPhotoBindings
  // below guards each (throws if unset) for a clear runtime error.
  SO_ITEM_PHOTOS_BUCKET_NAME?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_ENDPOINT?: string;
}

export function soItemPhotoBindings(env: SoItemPhotoEnv): SoItemPhotoBindings {
  if (!env.SO_ITEM_PHOTOS_BUCKET_NAME) {
    throw new Error('SO_ITEM_PHOTOS_BUCKET_NAME not configured');
  }
  if (!env.R2_ACCESS_KEY_ID) throw new Error('R2_ACCESS_KEY_ID not configured');
  if (!env.R2_SECRET_ACCESS_KEY) throw new Error('R2_SECRET_ACCESS_KEY not configured');
  if (!env.R2_ENDPOINT) throw new Error('R2_ENDPOINT not configured');
  return {
    bucketName: env.SO_ITEM_PHOTOS_BUCKET_NAME,
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    endpoint: env.R2_ENDPOINT,
  };
}

// Default TTL for SO item photo signed URLs. 1 hour matches the
// browser cache-control on the legacy proxy and stays well under R2's
// 7-day SigV4 maximum. Long enough that a coordinator browsing an SO
// won't have URLs expire mid-session; short enough that a leaked URL
// rotates quickly.
export const SO_PHOTO_URL_TTL_SECONDS = 60 * 60;

export interface SignedPhotoUrl {
  signedUrl: string;
  expiresAt: string; // ISO-8601, when the URL stops working
}

export async function signSoItemPhotoUrl(
  bindings: SoItemPhotoBindings,
  key: string,
  ttlSeconds: number = SO_PHOTO_URL_TTL_SECONDS,
  now: Date = new Date(),
): Promise<SignedPhotoUrl> {
  const signedUrl = await presign({
    bucket: bindings.bucketName,
    region: 'auto',
    accessKeyId: bindings.accessKeyId,
    secretAccessKey: bindings.secretAccessKey,
    endpoint: bindings.endpoint,
    key,
    method: 'GET',
    expiresInSeconds: ttlSeconds,
  });
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString();
  return { signedUrl, expiresAt };
}

export async function r2Head(bucket: R2Bucket, key: string): Promise<{ size: number; etag: string } | null> {
  const obj = await bucket.head(key);
  if (!obj) return null;
  return { size: obj.size, etag: obj.etag };
}

export async function r2Delete(bucket: R2Bucket, key: string): Promise<void> {
  await bucket.delete(key);
}

// (r2HeadViaS3 — the S3-API HEAD used to verify browser presigned PUTs —
// was deleted 2026-07-04 with the proxy-upload conversion. Both /upload and
// /confirm now go through the SLIPS binding, so dev Miniflare and prod hit
// the same backend by construction.)
