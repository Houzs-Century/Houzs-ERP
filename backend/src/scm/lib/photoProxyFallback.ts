/* ── Photo URL contract: signed-first, proxy-fallback ──────────────────────
   2026-08-10 incident. The `/photos/:photoKey/signed` routes (SO, PO,
   consignment) mint a presigned S3 GET URL via soItemPhotoBindings(), which
   THROWS per-variable when the R2 S3 credentials are unset. Those creds
   (R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_ENDPOINT) are wrangler SECRETS
   and were never provisioned in production, so every one of those routes
   answered 500 {"error":"signing_failed","reason":"R2_ACCESS_KEY_ID not
   configured"} and the SO line card rendered the literal text "err".

   The photos themselves were never missing. Verified live 2026-08-10 against
   prod: the SAME object that 500s through /signed returns 200 image/jpeg
   through the PROXY route, because the proxy reads the R2 *binding*
   (c.env.SO_ITEM_PHOTOS), which needs no S3 credential at all. So the failure
   was entirely in the URL-minting path, and a fallback costs nothing to serve.

   ── WHY THIS IS NOT JUST "return the proxy URL as signedUrl" ───────────────
   A signed R2 URL carries its SigV4 signature in the QUERY STRING, so it works
   as a bare <img src>: the browser needs to send no headers. The proxy route
   does NOT have that property. It sits behind the global auth gate
   (src/index.ts `app.use("/api/*", auth)`), and that gate reads the bearer
   token from the Authorization HEADER only:

       const header = c.req.header("Authorization") || "";      middleware/auth.ts

   There is no cookie session anywhere in this app — `Set-Cookie` appears
   nowhere in backend/src, and the SPA stamps the header explicitly in
   authedFetch. A browser does NOT attach that header to an <img src>, so
   handing a proxy path back as `signedUrl` would swap a visible 500 for an
   invisible 401 and the tile would still be blank. That is strictly worse: it
   LOOKS fixed in the code and is still broken on screen.

   Hence the discriminated union below. The proxy branch deliberately does NOT
   populate `signedUrl`, so no caller can accidentally pipe it into an <img src>
   and think it works. A client that gets `mode: 'proxy'` must fetch the path
   with its authed fetch, take the response as a Blob, and hand
   URL.createObjectURL(blob) to the <img> — the pattern already used by
   frontend/src/vendor/scm/lib/slip.ts and lorries-queries.ts. (Those object
   URLs must be revoked on unmount; a grid of tiles leaks otherwise.)

   ── PATH CONVENTION (load-bearing — read before changing) ──────────────────
   `proxyPath` is API-CLIENT-RELATIVE: it begins `/mfg-sales-orders/...`, NOT
   `/api/scm/mfg-sales-orders/...`. The frontend's API_URL constant already ends
   in `/api/scm` (vendor/scm/lib/authed-fetch.ts) and every helper passes it a
   path in exactly this form. This matches the convention the existing upload
   fallbacks already emit. It is therefore NOT a URL you can drop into an <img>
   or an <a href> — resolving it against the page origin gives a 404 at the site
   root. It is an argument for the API client. */

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
  /** API-client-relative path; fetch with the authed client, read as a Blob. */
  proxyPath: string;
  /** Same, for the `.thumb` sibling. 404s when no thumb was ever generated. */
  thumbProxyPath: string;
  /** Null because a proxy path never expires — it is authorised per request. */
  expiresAt: null;
  /** Why signing failed, e.g. "R2_ACCESS_KEY_ID not configured". */
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

/* The creds are either configured or they are not — the reason is identical on
   every request, so logging per photo would emit one line per tile per page
   load (an SO with 40 lines = 40 identical lines). Dedupe per isolate: the
   first occurrence of each distinct tag+reason is logged, the rest are silent.
   Exported for tests only. */
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
