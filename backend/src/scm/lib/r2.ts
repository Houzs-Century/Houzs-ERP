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


export interface SoItemPhotoBindings {
  bucketName: string;
  accessKeyId: string;
  secretAccessKey: string;
  endpoint: string;
}

export interface SoItemPhotoEnv {
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

export const SO_PHOTO_URL_TTL_SECONDS = 60 * 60;

export interface SignedPhotoUrl {
  signedUrl: string;
  expiresAt: string;
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

