// ----------------------------------------------------------------------------
// SoLinePhotoStrip — read-only line-photo thumbnails with a click-to-open
// full-size viewer. Born on the V2 SO detail; since the mig-0274 carry it also
// serves the PO detail through the same state machine — `source` picks the
// endpoint pair, nothing else differs (the PO strip is read-only BY DESIGN:
// photos are authored on the SO and carried across, so there is no upload or
// delete UI to add here).
//
// Owner 2026-08-10: "我在外面的 UI 看不到照片了吗?不能点开照片来看吗?" — the
// V2 read-only detail carried `photo_urls` on the wire the whole time
// (mfg-sales-orders.ts ITEM_COLS) and simply never rendered it, so the only way
// to see an imported AutoCount reference shot was to enter EDIT mode.
//
// TWO DELIBERATE REUSES, because both wheels already exist and both have
// already been debugged the hard way:
//
//   · LOADING is `useSoLinePhoto` — the exact state machine SoLineCard's
//     PhotoThumb runs (signed URL → authed-proxy fallback → thumb tier →
//     per-effect-run attempt). Hand-mirroring it here is what an earlier draft
//     of this component did, and that draft rendered NOTHING in production: it
//     read `signedUrl` off the `mode: 'proxy'` payload the route actually
//     returns, got undefined, and sat on the "…" placeholder forever.
//
//   · VIEWING is `MediaLightbox` — the app's existing full-screen R2 previewer
//     (ServiceCases, Projects, announcements). It brings prev/next across the
//     line's photos, Escape-to-close, body-scroll lock and Download for free,
//     and it owns and revokes its own object URL.
//
// The viewer must NOT reuse a tile's `src`: under the proxy arm that is a
// blob: URL scoped to the tile's current effect run (revoked on unmount) AND it
// holds THUMB bytes. MediaLightbox therefore re-fetches the FULL object from
// the same authed proxy route — which is the point, not waste.
// ----------------------------------------------------------------------------
import { useState } from "react";
import { MediaLightbox } from "../MediaLightbox";
import {
  photoContentType,
  poLinePhotoLightboxBase,
  soLinePhotoLightboxBase,
  useScmLinePhoto,
  type LinePhotoSource,
} from "../../vendor/scm/lib/so-line-photo";

/* `source` decides which document family's routes serve the keys — REQUIRED,
   because a strip that silently defaulted to 'so' would 404 every thumb the
   day a PO surface forgot to pass it (the optional-param-noop bug class).
   `docId` is the SO doc_no or the PO row id, whichever the routes key on. */

function Thumb({
  source, docId, itemId, photoKey, onOpen,
}: {
  source: LinePhotoSource;
  docId: string;
  itemId: string;
  photoKey: string;
  onOpen: () => void;
}) {
  const { src, error, onImgError } = useScmLinePhoto(source, photoKey, docId, itemId);

  /* "err" survives here for the same reason it does on the edit card: when the
     proxy ALSO fails (404 missing object, 401/403 refused) a missing photo must
     read AS missing. It is not a button — a retry that re-runs the same failing
     request is theatre, and the title carries the real reason for a bug report. */
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
      <img
        src={src}
        alt="Line photo"
        className="h-full w-full object-cover"
        onError={onImgError}
      />
    </button>
  );
}

export function SoLinePhotoStrip({
  source, docId, itemId, photoKeys,
}: {
  source: LinePhotoSource;
  docId: string;
  itemId: string;
  photoKeys: string[];
}) {
  const [openAt, setOpenAt] = useState<number | null>(null);

  if (!docId || !itemId || photoKeys.length === 0) {
    return <span className="text-[11px] text-ink-muted">—</span>;
  }

  /* MediaLightbox joins `${baseUrl}/${r2_key}` verbatim, so the key is
     PRE-ENCODED: an SO photo key is `so-items/<docNo>/<itemId>/<name>.jpg` and
     its slashes have to survive as ONE path segment or Hono's `:photoKey`
     param never matches and the proxy 404s. `caption` carries the bare file
     name because MediaLightbox derives its Download filename from
     `caption || r2_key.split("/").pop()` — and the encoded key has no "/" left
     to split on, so without this a download saves as one %2F-mangled blob. */
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
            source={source}
            docId={docId}
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
          baseUrl={
            source === "po"
              ? poLinePhotoLightboxBase(docId, itemId)
              : soLinePhotoLightboxBase(docId, itemId)
          }
          badge="Line photo"
        />
      )}
    </>
  );
}
