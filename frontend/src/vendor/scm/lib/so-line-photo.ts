
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

export type LinePhotoSource = 'so' | 'po';

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

const photoBlobInflight = new Map<string, Promise<Blob>>();

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

type PhotoAttempt = {
  cancelled: boolean;
  proxyTried: boolean;
  signedRetried: boolean;
  objectUrl: string | null;
};

export type SoLinePhoto = {
  src: string | null;
  error: string | null;
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
  const [useFull, setUseFull] = useState<boolean>(() => thumbMissingKeys.has(photoKey));
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
    setUseFull(true);
    setUrls({ signedUrl: objectUrl });
    setError(null);
  };

  const loadViaProxy = async (attempt: PhotoAttempt, reason: string) => {
    if (!docNo || !itemId) return;
    if (attempt.proxyTried) {
      if (!attempt.cancelled) setError(reason);
      return;
    }
    attempt.proxyTried = true;
    try {
      const blob = await loadPhotoBytesShared(source, docNo, itemId, photoKey);
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
      if (isProxyPhotoPayload(payload)) {
        await loadViaProxy(attempt, payload.reason);
        return;
      }
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
      void loadSignedUrl(attempt);
    }
    return () => { attempt.cancelled = true; releaseAttemptUrl(attempt); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, docNo, itemId, photoKey]);

  const showingThumb = !useFull && !!urls?.thumbUrl;

  const onImgError = () => {
    const attempt = attemptRef.current;
    if (!attempt || attempt.cancelled) return;
    if (showingThumb) {
      thumbMissingKeys.add(photoKey);
      setUseFull(true);
      return;
    }
    if (attempt.signedRetried) {
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
    default:     return 'image/jpeg';
  }
}
