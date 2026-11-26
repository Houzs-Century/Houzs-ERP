
import { thumbKeyFor } from '../../services/photoThumbs';

/** Success: a presigned R2 URL usable directly as an <img src>. */
export interface SignedPhotoPayload {
  mode: 'signed';
  signedUrl: string;
  thumbUrl: string;
  expiresAt: string;
}

/**
 * Fallback: signing was impossible, so the client must stream the bytes back
 * through the authenticated Worker proxy. NOT an <img src> — see the header.
 */
export interface ProxyPhotoPayload {
  mode: 'proxy';
  proxyPath: string;
  thumbProxyPath: string;
  expiresAt: null;
  reason: string;
}

export type PhotoUrlPayload = SignedPhotoPayload | ProxyPhotoPayload;

/**
 * `basePath` is the route prefix UP TO (not including) `/photos`, in
 * API-client-relative form — e.g. `/mfg-sales-orders/SO-1/items/abc`.
 */
export function photoProxyPath(basePath: string, photoKey: string): string {
  return `${basePath}/photos/${encodeURIComponent(photoKey)}`;
}

const warnedOnce = new Set<string>();

export function resetSigningWarnLog(): void {
  warnedOnce.clear();
}

export function warnSigningFailedOnce(tag: string, reason: string): void {
  const dedupeKey = `${tag}:${reason}`;
  if (warnedOnce.has(dedupeKey)) return;
  warnedOnce.add(dedupeKey);
  // eslint-disable-next-line no-console
  console.warn(
    `[${tag}] signed-URL minting failed, serving photos through the authenticated proxy instead: ${reason}`,
  );
}

/**
 * Build the proxy-fallback payload for a failed signing attempt, and log the
 * reason once per isolate.
 */
export function proxyFallbackPayload(
  tag: string,
  basePath: string,
  photoKey: string,
  err: unknown,
): ProxyPhotoPayload {
  const reason = err instanceof Error ? err.message : String(err);
  warnSigningFailedOnce(tag, reason);
  return {
    mode: 'proxy',
    proxyPath: photoProxyPath(basePath, photoKey),
    thumbProxyPath: photoProxyPath(basePath, thumbKeyFor(photoKey)),
    expiresAt: null,
    reason,
  };
}
