/* ──────────────────────────────────────────────────────────────────────────
   useSoLinePhoto — the ONE resolver for an SO line photo tile
   ──────────────────────────────────────────────────────────────────────────
   Extracted verbatim from SoLineCard's PhotoThumb (Task #92 signed-URL flow)
   so every surface that shows a line photo runs the SAME state machine. It is
   a hook rather than a component because the two call sites want different
   chrome — the edit card's 48px tile with a delete X, the V2 read-only strip's
   32px tile that opens a viewer — but must not want different LOADING.

   WHY EXTRACTION, NOT A SECOND COPY. Three separate production regressions
   have lived in this state machine (a one-shot guard, the StrictMode
   double-invoke, and the full-size-instead-of-thumb cost), and each was found
   on screen rather than in CI. A second surface that "mirrors the same
   discipline" by hand is a second place for all three to come back, and it
   starts out already wrong: written against the signed arm alone, it renders
   nothing at all in today's production (see the proxy note below).

   ── The resolution ladder ─────────────────────────────────────────────────
   1. Module-level signed-URL cache, keyed by photoKey — survives component
      unmounts (drawer open/close) within one page load, so reopening an SO
      does not re-sign every thumb.
   2. SIGNED_URL_SKEW_BUFFER_MS — treat URLs within 30s of expiry as already
      expired. Avoids the race where a URL passes our check, then 401s at the
      browser because the clock drifted or R2's check fires slightly later.
   3. On <img onError>, retry once with a fresh URL. The signed URL MIGHT have
      expired between cache check and HTTP fetch, or the cached entry pre-dated
      an R2 token rotation. One retry is enough; a second failure means the
      photo is genuinely gone.

   ── PROXY FALLBACK (2026-08-10 incident) — THE PRODUCTION PATH ────────────
   Signing needs the R2 S3-API credentials (R2_ACCESS_KEY_ID /
   R2_SECRET_ACCESS_KEY / R2_ENDPOINT) as wrangler SECRETS. Production never
   had them, so /signed answered 500 {"error":"signing_failed"} for EVERY photo
   and every tile rendered the literal text "err" — while the objects were
   sitting in R2, readable, and the Worker's R2 BINDING could serve them
   through the proxy route the whole time.

   So a signing failure is not evidence the photo is missing. /signed no longer
   500s at all: since the fix it answers its `mode: 'proxy'` arm, which is what
   EVERY request gets today. Either way — thrown 500 from an old deploy, or the
   proxy arm from the current one — stream the bytes through the authed proxy.

   The proxy URL CANNOT be an <img src>: it is behind bearer auth and an <img>
   tag sends no Authorization header — this app has no cookie session at all
   (see slip.ts + lorries-queries.ts, same constraint, same solution). The
   bytes are fetched with the token and handed to <img> as a blob: object URL,
   which MUST be revoked on unmount or every tile leaks its image.

   "err" is deliberately KEPT for the genuinely-broken case: if the proxy also
   fails (404 missing key, 401/403 refused), a missing photo must still be
   visible AS missing rather than silently rendering nothing.

   ── STRICTMODE (2026-08-11 — the first fix shipped still showed "err") ────
   The app mounts under <React.StrictMode> (main.tsx:228), so in DEV every
   effect runs, is cleaned up, and runs AGAIN. The first fix kept its one-shot
   proxy guard and its "unmounted" flag in refs scoped to the COMPONENT's
   lifetime, which made both single-use for the life of the tile:

     - run 1 burned the proxy guard, then its cleanup cancelled it;
     - run 2 — the live one — reached the guard already spent and took the
       `setError(reason)` branch, rendering the exact "err" the fix existed to
       remove;
     - the unmount flag latched true at run 1's cleanup and nothing ever reset
       it, so for the rest of the tile's life BOTH <img onError> retry paths
       treated themselves as unmounted and any late blob was revoked on arrival.

   So attempt state is scoped PER EFFECT RUN, in a PhotoAttempt object the
   effect creates and its cleanup cancels. A cancelled attempt can never veto a
   later one. `attemptRef` always points at the CURRENT attempt, which is what
   the <img onError> paths (not effects, so they have no cleanup of their own)
   read to decide whether they are still live.

   COST (same fix round): under fallback the tile used to fetch the BASE key
   and revoke on unmount, so a 40-line SO re-streamed 40 FULL-SIZE JPEGs
   through the Worker on every drawer open. Now the proxy asks for the `.thumb`
   sibling first — the proxy route already authorises a thumb against its base
   row (mfg-sales-orders.ts, baseKeyOf) — and the BYTES are cached at module
   level so a reopen costs no network at all. The object URL is still
   per-attempt and still revoked, because the cache holds Blobs, not URLs.
   ────────────────────────────────────────────────────────────────────────── */

import { useEffect, useRef, useState } from 'react';
import {
  fetchSoItemPhotoSignedUrl,
  fetchSoItemPhotoBlob,
  fetchPoItemPhotoSignedUrl,
  fetchPoItemPhotoBlob,
  isDirectlyLoadableUrl,
  isProxyPhotoPayload,
  PhotoProxyError,
  type PhotoUrlPayload,
} from './sales-order-queries';
import { THUMB_KEY_SUFFIX } from '../../../lib/imagePipeline';

/* ── The fetcher seam (mig 0274 follow-through) ────────────────────────────
   The PO carries the SAME photo keys (an SO→PO convert copies the key list;
   both point at one R2 object) behind mirrored routes keyed by the PO id.
   The state machine below is endpoint-agnostic — `source` picks the fetcher
   pair, and the module-level caches stay keyed by the R2 key, which is
   CORRECT to share across sources: same key, same bytes, so a thumb loaded on
   the SO detail is free on the PO detail. */
export type LinePhotoSource = 'so' | 'po';

/* Wrappers, not bare references, ON PURPOSE: a bare reference dereferences the
   sales-order-queries module namespace while THIS module evaluates, and every
   page test that mocks that module with a plain factory (no importOriginal
   spread — e.g. so-v2-history-and-activity.test.tsx) makes that access THROW
   under vitest ("No export is defined on the mock"). The pre-seam code only
   touched the fetchers inside function bodies, i.e. at call time — these
   wrappers keep that timing. */
const PHOTO_FETCHERS: Record<LinePhotoSource, {
  signedUrl: (docId: string, itemId: string, photoKey: string) => Promise<PhotoUrlPayload>;
  blob: (docId: string, itemId: string, photoKey: string) => Promise<Blob>;
}> = {
  so: {
    signedUrl: (d, i, k) => fetchSoItemPhotoSignedUrl(d, i, k),
    blob: (d, i, k) => fetchSoItemPhotoBlob(d, i, k),
  },
  po: {
    signedUrl: (d, i, k) => fetchPoItemPhotoSignedUrl(d, i, k),
    blob: (d, i, k) => fetchPoItemPhotoBlob(d, i, k),
  },
};

const SIGNED_URL_SKEW_BUFFER_MS = 30_000;

type SignedUrlCacheEntry = { signedUrl: string; thumbUrl?: string; expiresAt: number };

const signedUrlCache = new Map<string, SignedUrlCacheEntry>();

/* WO-7 — photoKeys whose `.thumb` sibling 404'd (every photo uploaded before
   thumbnails shipped). Remembered at module level so reopening the SO doesn't
   re-attempt a thumb we already know is missing. */
const thumbMissingKeys = new Set<string>();

const isCachedUrlFresh = (entry: { expiresAt: number } | undefined): boolean =>
  !!entry && entry.expiresAt - SIGNED_URL_SKEW_BUFFER_MS > Date.now();

/** Seed the cache with a URL the API just minted (the upload response), so the
 *  first render of a just-uploaded photo does no redundant /signed round-trip.
 *  Only ever called with an ABSOLUTE URL — see isDirectlyLoadableUrl. */
export function cacheSoLinePhotoSignedUrl(
  photoKey: string,
  entry: SignedUrlCacheEntry,
): void {
  signedUrlCache.set(photoKey, entry);
}

/* ── Proxy byte cache ──────────────────────────────────────────────────────
   Keyed by the R2 key actually fetched (thumb or base). Blobs, not object
   URLs: an object URL is owned by one mount and must be revoked when that
   mount ends, whereas the bytes are what we do not want to re-stream. Budget
   is by SIZE rather than count because thumbs are tens of KB and a pre-thumb
   full-size photo is hundreds — a count-based cap would mean something wildly
   different for each. Oldest-first eviction (Map iterates in insertion order).
   A single blob larger than the whole budget is served but not retained. */
const PHOTO_BLOB_CACHE_MAX_BYTES = 24 * 1024 * 1024;
const photoBlobCache = new Map<string, Blob>();
let photoBlobCacheBytes = 0;

function rememberPhotoBlob(r2Key: string, blob: Blob): void {
  const prev = photoBlobCache.get(r2Key);
  if (prev) { photoBlobCache.delete(r2Key); photoBlobCacheBytes -= prev.size; }
  photoBlobCache.set(r2Key, blob);
  photoBlobCacheBytes += blob.size;
  while (photoBlobCacheBytes > PHOTO_BLOB_CACHE_MAX_BYTES) {
    const oldest = photoBlobCache.keys().next();
    if (oldest.done) break;
    photoBlobCacheBytes -= photoBlobCache.get(oldest.value)!.size;
    photoBlobCache.delete(oldest.value);
  }
}

/* StrictMode's double-invoke, and a fast drawer close/reopen, both ask for the
   same key while the first request is still in flight. Sharing the promise
   keeps that at ONE Worker round-trip. */
const photoBlobInflight = new Map<string, Promise<Blob>>();

/** Thumb-first, base-on-404, cached by bytes. Throws the base-key error when
 *  the photo is genuinely unreachable — that is what still renders "err". */
async function loadPhotoBytes(
  source: LinePhotoSource,
  docId: string,
  itemId: string,
  photoKey: string,
): Promise<Blob> {
  const fetchBlob = PHOTO_FETCHERS[source].blob;
  if (!thumbMissingKeys.has(photoKey)) {
    const thumbKey = photoKey + THUMB_KEY_SUFFIX;
    const cachedThumb = photoBlobCache.get(thumbKey);
    if (cachedThumb) return cachedThumb;
    try {
      const blob = await fetchBlob(docId, itemId, thumbKey);
      rememberPhotoBlob(thumbKey, blob);
      return blob;
    } catch (e) {
      /* ONLY a 404 proves this photo has no thumb. A 401/408/500 says nothing
         about the thumb's existence, so it must not poison thumbMissingKeys
         for the rest of the page's life — rethrow and let the caller show it. */
      if (!(e instanceof PhotoProxyError) || e.status !== 404) throw e;
      thumbMissingKeys.add(photoKey);
    }
  }
  const cachedFull = photoBlobCache.get(photoKey);
  if (cachedFull) return cachedFull;
  const blob = await fetchBlob(docId, itemId, photoKey);
  rememberPhotoBlob(photoKey, blob);
  return blob;
}

function loadPhotoBytesShared(
  source: LinePhotoSource,
  docId: string,
  itemId: string,
  photoKey: string,
): Promise<Blob> {
  const inflightKey = `${source}|${docId}|${itemId}|${photoKey}`;
  const existing = photoBlobInflight.get(inflightKey);
  if (existing) return existing;
  const pending = loadPhotoBytes(source, docId, itemId, photoKey)
    .finally(() => { photoBlobInflight.delete(inflightKey); });
  photoBlobInflight.set(inflightKey, pending);
  return pending;
}

/* One pass at resolving a tile's image. Created by the effect, cancelled by
   that effect's cleanup — so StrictMode's discarded first run can never spend
   the second run's single proxy attempt, and a real unmount still stops a
   late resolve from touching state or stranding an object URL. */
type PhotoAttempt = {
  cancelled: boolean;
  proxyTried: boolean;
  signedRetried: boolean;
  objectUrl: string | null;
};

export type SoLinePhoto = {
  /** What to put in <img src>. null while resolving, and null on failure. */
  src: string | null;
  /** Non-null once the photo is genuinely unreachable — the "err" tile. */
  error: string | null;
  /** Wire to <img onError>. Owns the thumb→full and the one signed refetch. */
  onImgError: () => void;
};

/**
 * Resolve one line photo to something an <img> can display.
 *
 * `source` names the document family whose routes serve the key — the whole
 * state machine is shared, only the fetcher pair differs (see PHOTO_FETCHERS).
 * `docId` (SO doc_no / PO id) and `itemId` are optional because a DRAFT line
 * has neither yet; with either missing the hook stays inert (no request, no
 * error, no tile) rather than reporting a failure the operator cannot act on.
 */
export function useScmLinePhoto(
  source: LinePhotoSource,
  photoKey: string,
  docId?: string,
  itemId?: string,
): SoLinePhoto {
  const docNo = docId;
  const [urls, setUrls] = useState<{ signedUrl: string; thumbUrl?: string } | null>(() => {
    const cached = signedUrlCache.get(photoKey);
    return isCachedUrlFresh(cached) ? cached! : null;
  });
  const [error, setError] = useState<string | null>(null);
  /* WO-7 — start on the thumb unless this key is already known thumbless.
     A failed thumb load flips to the full signedUrl (the required fallback
     for pre-thumb photos); a failed FULL load keeps the original
     refetch-once behaviour below. */
  const [useFull, setUseFull] = useState<boolean>(() => thumbMissingKeys.has(photoKey));
  /* The attempt owning the CURRENT effect run. The <img onError> paths are not
     effects, so they have no cleanup of their own — this is how they find out
     whether they are still the live pass. */
  const attemptRef = useRef<PhotoAttempt | null>(null);

  const releaseAttemptUrl = (attempt: PhotoAttempt) => {
    if (attempt.objectUrl) {
      URL.revokeObjectURL(attempt.objectUrl);
      attempt.objectUrl = null;
    }
  };

  const showBlob = (attempt: PhotoAttempt, blob: Blob) => {
    releaseAttemptUrl(attempt);
    const objectUrl = URL.createObjectURL(blob);
    attempt.objectUrl = objectUrl;
    /* The blob IS the final image — thumb bytes or full bytes, the tile has no
       second tier to fall back to once it is holding them. */
    setUseFull(true);
    setUrls({ signedUrl: objectUrl });
    setError(null);
  };

  /* Signing is unavailable or the signed URL is unusable — stream the bytes
     through the authed proxy instead. A failure HERE is the genuinely-broken
     case, so it surfaces as "err". One attempt per PASS, not per component:
     see the StrictMode note in the header. */
  const loadViaProxy = async (attempt: PhotoAttempt, reason: string) => {
    if (!docNo || !itemId) return;
    if (attempt.proxyTried) {
      if (!attempt.cancelled) setError(reason);
      return;
    }
    attempt.proxyTried = true;
    try {
      const blob = await loadPhotoBytesShared(source, docNo, itemId, photoKey);
      /* Cancelled mid-flight: return BEFORE minting an object URL, so there is
         nothing to leak. The bytes stay in the module cache for the next pass,
         which is what makes StrictMode's second run free. */
      if (attempt.cancelled) return;
      showBlob(attempt, blob);
    } catch (e) {
      if (!attempt.cancelled) setError(e instanceof Error ? e.message : reason);
    }
  };

  const loadSignedUrl = async (attempt: PhotoAttempt) => {
    if (!docNo || !itemId) return;
    try {
      const payload = await PHOTO_FETCHERS[source].signedUrl(docNo, itemId, photoKey);
      if (attempt.cancelled) return;
      /* THE PRODUCTION ARM. The R2 S3 credentials have never been provisioned,
         so the route reports `mode: 'proxy'` for every photo and there is no
         signedUrl to hand an <img>. Stream the bytes instead. */
      if (isProxyPhotoPayload(payload)) {
        await loadViaProxy(attempt, payload.reason);
        return;
      }
      /* Signing "succeeded" but handed back something an <img> cannot load
         directly. Invariant check, not a live path — see isDirectlyLoadableUrl. */
      if (!isDirectlyLoadableUrl(payload.signedUrl)) {
        await loadViaProxy(attempt, 'image_load_failed');
        return;
      }
      signedUrlCache.set(photoKey, {
        signedUrl: payload.signedUrl,
        thumbUrl: payload.thumbUrl,
        expiresAt: new Date(payload.expiresAt).getTime(),
      });
      setUrls({ signedUrl: payload.signedUrl, thumbUrl: payload.thumbUrl });
      setError(null);
    } catch (e) {
      /* THE 2026-08-10 CASE, as an OLD deploy still serves it: /signed 500s
         because the R2 S3-API secrets were never provisioned. The photo itself
         is fine — serve it via the proxy rather than showing "err". */
      if (attempt.cancelled) return;
      await loadViaProxy(attempt, e instanceof Error ? e.message : 'Something went wrong.');
    }
  };

  useEffect(() => {
    const attempt: PhotoAttempt = {
      cancelled: false, proxyTried: false, signedRetried: false, objectUrl: null,
    };
    attemptRef.current = attempt;
    const cached = signedUrlCache.get(photoKey);
    if (isCachedUrlFresh(cached)) {
      setUrls(cached!);
    } else {
      // Cache miss or stale entry — fetch a fresh signed URL.
      void loadSignedUrl(attempt);
    }
    /* Cleanup runs on unmount AND on every dep change, so this is the only
       revoke site needed. It revokes only THIS attempt's object URL — a pass
       can never revoke the blob a later pass is showing. */
    return () => { attempt.cancelled = true; releaseAttemptUrl(attempt); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, docNo, itemId, photoKey]);

  const showingThumb = !useFull && !!urls?.thumbUrl;

  const onImgError = () => {
    const attempt = attemptRef.current;
    // Cancelled pass (or a stray error after unmount) — nothing live to fix.
    if (!attempt || attempt.cancelled) return;
    /* Thumb tier failed — almost always a pre-thumb photo whose `.thumb`
       object does not exist (signed URL 404s). Fall back to the full image
       WITHOUT burning the retry: the full URL is already in hand. */
    if (showingThumb) {
      thumbMissingKeys.add(photoKey);
      setUseFull(true);
      return;
    }
    // The signed URL we handed to <img src> didn't load. Most likely
    // it expired (cache survived a tab being suspended for >1 hour);
    // could also be an R2 transient. Drop the cache entry and refetch
    // once. signedRetried prevents an infinite onError → setState loop
    // if the new URL also fails.
    if (attempt.signedRetried) {
      /* A freshly-minted signed URL still would not load. The object may yet
         be readable through the R2 binding (the signing credential and the
         binding are different access paths), so try the proxy before
         declaring the photo broken. */
      signedUrlCache.delete(photoKey);
      setUrls(null);
      void loadViaProxy(attempt, 'image_load_failed');
      return;
    }
    attempt.signedRetried = true;
    signedUrlCache.delete(photoKey);
    setUrls(null);
    void loadSignedUrl(attempt);
  };

  const src = urls ? (showingThumb ? urls.thumbUrl! : urls.signedUrl) : null;

  return { src, error, onImgError };
}

/** The SO-shaped entry point every pre-0274 call site uses — same signature
 *  as before the fetcher seam existed, so SoLineCard's PhotoThumb and friends
 *  did not change a line. */
export function useSoLinePhoto(
  photoKey: string,
  docNo?: string,
  itemId?: string,
): SoLinePhoto {
  return useScmLinePhoto('so', photoKey, docNo, itemId);
}

/* ── Full-size viewing ─────────────────────────────────────────────────────
   The tile above resolves the THUMB tier. A viewer must show the FULL object,
   and must not reuse the tile's `src`: under the proxy arm that src is a
   blob: URL owned by the tile's current effect run and revoked when the tile
   unmounts, and it holds THUMB bytes, not the full image.

   The full object is served by the same authed proxy route the tile falls back
   to, so the viewer just needs its path. `MediaLightbox` fetches
   `${baseUrl}/${r2_key}` with the shared authed client and turns it into its
   own object URL, which it owns and revokes — hence the pre-encoded key: the
   R2 key contains '/' and must survive as ONE path segment for Hono's
   `:photoKey` param to match. */

/** API path prefix `MediaLightbox` should hang line photos off, for one SO
 *  line. Absolute from the site root (api/client.ts's baseUrl is "" in prod),
 *  NOT the scm-vendor-relative form `authedFetch` takes. */
export const soLinePhotoLightboxBase = (docNo: string, itemId: string): string =>
  `/api/scm/mfg-sales-orders/${encodeURIComponent(docNo)}/items/${encodeURIComponent(itemId)}/photos`;

/** PO twin — same contract against the mirrored mig-0274 routes, keyed by the
 *  PO row id rather than a doc_no. */
export const poLinePhotoLightboxBase = (poId: string, itemId: string): string =>
  `/api/scm/mfg-purchase-orders/${encodeURIComponent(poId)}/items/${encodeURIComponent(itemId)}/photos`;

/** Content type for a photo key, from its extension. R2 hands back
 *  `application/octet-stream` for objects stored without a type, and an
 *  <img>/blob: URL of that type will DOWNLOAD instead of rendering — the hint
 *  is what lets MediaLightbox re-type the blob so it displays inline. */
export function photoContentType(photoKey: string): string {
  const ext = /\.([a-z0-9]+)$/i.exec(photoKey)?.[1]?.toLowerCase();
  switch (ext) {
    case 'png':  return 'image/png';
    case 'webp': return 'image/webp';
    case 'gif':  return 'image/gif';
    case 'heic': return 'image/heic';
    case 'heif': return 'image/heif';
    case 'avif': return 'image/avif';
    /* Everything the SO upload route and the AutoCount importer emit is jpg
       (extFromMime / `ac-<DtlKey>-<n>.jpg`), so jpeg is the right default
       rather than octet-stream — which would render as a download tile. */
    default:     return 'image/jpeg';
  }
}
