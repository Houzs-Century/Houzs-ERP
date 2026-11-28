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
import { useRef, useState } from "react";
import { MediaLightbox } from "../MediaLightbox";
import {
  photoContentType,
  poLinePhotoLightboxBase,
  soLinePhotoLightboxBase,
  useScmLinePhoto,
  type LinePhotoSource,
} from "../../vendor/scm/lib/so-line-photo";


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

export type LinePhotoEdit = {
  onUpload: (file: File) => Promise<void>;
  onDelete: (photoKey: string) => Promise<void>;
  canDeleteKey: (photoKey: string) => boolean;
};

export function SoLinePhotoStrip({
  source, docId, itemId, photoKeys, edit = null,
}: {
  source: LinePhotoSource;
  docId: string;
  itemId: string;
  photoKeys: string[];
  edit?: LinePhotoEdit | null;
}) {
  const [openAt, setOpenAt] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  if (!docId || !itemId || (photoKeys.length === 0 && !edit)) {
    return <span className="text-[11px] text-ink-muted">—</span>;
  }

  const items = photoKeys.map((k) => ({
    r2_key: encodeURIComponent(k),
    content_type: photoContentType(k),
    caption: k.split("/").pop() || k,
  }));

  return (
    <>
      <span className="flex flex-wrap items-center gap-1">
        {photoKeys.map((k, i) => (
          <span key={k} className="relative inline-flex">
            <Thumb
              source={source}
              docId={docId}
              itemId={itemId}
              photoKey={k}
              onOpen={() => setOpenAt(i)}
            />
            {edit && edit.canDeleteKey(k) && (
              <button
                type="button"
                aria-label="Delete photo"
                title="Delete photo"
                disabled={busy}
                className="absolute -right-1 -top-1 h-4 w-4 rounded-full border border-line bg-surface text-[10px] leading-none text-ink-secondary hover:text-red-600 dark:hover:text-red-300 disabled:opacity-50"
                onClick={async (e) => {
                  e.stopPropagation();
                  setBusy(true);
                  try { await edit.onDelete(k); } finally { setBusy(false); }
                }}
              >
                x
              </button>
            )}
          </span>
        ))}
        {edit && (
          <>
            <button
              type="button"
              disabled={busy}
              title="Add photo"
              className="inline-flex h-9 w-9 items-center justify-center rounded border border-dashed border-line text-[16px] leading-none text-ink-muted hover:text-ink disabled:opacity-50"
              onClick={() => fileRef.current?.click()}
            >
              +
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (!file) return;
                setBusy(true);
                try { await edit.onUpload(file); } finally { setBusy(false); }
              }}
            />
          </>
        )}
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
