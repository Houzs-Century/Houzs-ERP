// ----------------------------------------------------------------------------
// DoLinePhotoStrip — read-only line-photo thumbnails for the V2 DO detail,
// with a click-to-open full-size viewer.
//
// Owner 2026-08-10 rule, DO leg (mig 20260828T0746): a DO raised from an SO
// line carries that line's photos — 送货时照片要跟着 line — so the DO detail must
// show them, exactly as the SO detail's SoLinePhotoStrip does.
//
// WHY THIS IS NOT SoLinePhotoStrip WITH DIFFERENT PROPS. That strip's loader is
// useSoLinePhoto, whose fetchers are hard-wired to the SO routes
// (vendor/scm/lib/sales-order-queries) — reusing it here would authorise DO
// photos against mfg_sales_order_items, which is the wrong document. What IS
// reused is everything that has already been debugged the hard way:
//
//   · VIEWING is MediaLightbox — the app's existing full-screen R2 previewer.
//     It fetches the FULL object itself via api.fetchBlobUrl, so the viewer
//     never reuses a tile's blob: URL (revoked on unmount, and thumb bytes).
//   · LOADING is api.fetchBlobUrl against the DO proxy route — the same authed
//     transport MediaLightbox uses. PROXY-ONLY on purpose: the R2 S3 signing
//     credentials have never been provisioned in production (2026-08-10
//     incident, scm/lib/photoProxyFallback.ts), so the /signed route answers
//     its proxy arm for every photo anyway; going straight to the proxy is one
//     fewer round-trip and cannot regress a signing path that does not run. An
//     <img src> cannot carry the bearer header, hence blob: object URLs.
//   · The two SO-tile traps are inherited as RULES: attempt state is scoped
//     PER EFFECT RUN (StrictMode's discarded first pass must not spend the
//     live pass's fallback), and the tile asks for the `.thumb` sibling first,
//     falling back to the full object only on failure (pre-thumb photos).
//
// "err" is deliberately kept for the genuinely-broken case: a missing photo
// must read AS missing rather than silently rendering nothing.
// ----------------------------------------------------------------------------
import { useEffect, useState } from "react";
import { api } from "../../api/client";
import { MediaLightbox } from "../MediaLightbox";
import { photoContentType } from "../../vendor/scm/lib/so-line-photo";
import { THUMB_KEY_SUFFIX } from "../../lib/imagePipeline";

/** API path prefix (absolute from the site root, the form api.fetchBlobUrl and
 *  MediaLightbox take) for one DO line's photos. */
export const doLinePhotoLightboxBase = (doId: string, itemId: string): string =>
  `/api/scm/delivery-orders-mfg/${encodeURIComponent(doId)}/items/${encodeURIComponent(itemId)}/photos`;

function Thumb({
  doId, itemId, photoKey, onOpen,
}: {
  doId: string;
  itemId: string;
  photoKey: string;
  onOpen: () => void;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    /* Attempt state scoped to THIS effect run — StrictMode runs the effect,
       cleans it up, and runs it again, so anything longer-lived would let the
       discarded first pass cancel or spend the live one (the exact bug the SO
       tile shipped once; see so-line-photo.ts's StrictMode note). */
    const attempt = { cancelled: false, objectUrl: null as string | null };
    const base = doLinePhotoLightboxBase(doId, itemId);
    void (async () => {
      let url: string | null = null;
      try {
        // Thumb tier first — tens of KB instead of the full photo.
        url = await api.fetchBlobUrl(`${base}/${encodeURIComponent(photoKey + THUMB_KEY_SUFFIX)}`, photoContentType(photoKey));
      } catch {
        try {
          // Pre-thumb photo (no `.thumb` object) — fall back to the full image.
          url = await api.fetchBlobUrl(`${base}/${encodeURIComponent(photoKey)}`, photoContentType(photoKey));
        } catch (e) {
          if (!attempt.cancelled) setError(e instanceof Error ? e.message : "Photo unavailable");
          return;
        }
      }
      if (attempt.cancelled) {
        // Late resolve after unmount — revoke immediately, nothing may leak.
        if (url) URL.revokeObjectURL(url);
        return;
      }
      attempt.objectUrl = url;
      setSrc(url);
      setError(null);
    })();
    return () => {
      attempt.cancelled = true;
      if (attempt.objectUrl) URL.revokeObjectURL(attempt.objectUrl);
    };
  }, [doId, itemId, photoKey]);

  /* A failed photo must read AS missing. Not a button — a retry that re-runs
     the same failing request is theatre; the title carries the real reason. */
  if (!src) {
    return error ? (
      <span
        title={error}
        className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded border border-err/40 bg-err-bg text-[9px] font-semibold text-err"
      >
        err
      </span>
    ) : (
      <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded border border-border bg-surface-2 text-[10px] text-ink-muted">
        …
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={onOpen}
      title="Open full size"
      className="h-8 w-8 shrink-0 cursor-zoom-in overflow-hidden rounded border border-black/10 transition-shadow hover:shadow-md"
    >
      <img src={src} alt="Line photo" className="h-full w-full object-cover" />
    </button>
  );
}

export function DoLinePhotoStrip({
  doId, itemId, photoKeys,
}: {
  doId: string;
  itemId: string;
  photoKeys: string[];
}) {
  const [openAt, setOpenAt] = useState<number | null>(null);

  if (!doId || !itemId || photoKeys.length === 0) {
    return <span className="text-[11px] text-ink-muted">—</span>;
  }

  /* MediaLightbox joins `${baseUrl}/${r2_key}` verbatim, so the key is
     PRE-ENCODED: a carried key is `so-items/<docNo>/<soItemId>/<name>.jpg` and
     its slashes have to survive as ONE path segment or Hono's `:photoKey`
     param never matches and the proxy 404s. `caption` carries the bare file
     name because MediaLightbox derives its Download filename from
     `caption || r2_key.split("/").pop()` — and the encoded key has no "/" left
     to split on. */
  const items = photoKeys.map((k) => ({
    r2_key: encodeURIComponent(k),
    content_type: photoContentType(k),
    caption: k.split("/").pop() || k,
  }));

  return (
    <>
      <span className="flex flex-wrap items-center gap-1">
        {photoKeys.map((k, i) => (
          <Thumb
            key={k}
            doId={doId}
            itemId={itemId}
            photoKey={k}
            onOpen={() => setOpenAt(i)}
          />
        ))}
      </span>
      {openAt !== null && (
        <MediaLightbox
          items={items}
          index={openAt}
          onChange={setOpenAt}
          onClose={() => setOpenAt(null)}
          baseUrl={doLinePhotoLightboxBase(doId, itemId)}
          badge="Line photo"
        />
      )}
    </>
  );
}
