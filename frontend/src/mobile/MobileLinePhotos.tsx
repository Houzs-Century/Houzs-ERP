/* ──────────────────────────────────────────────────────────────────────────
   MobileLinePhotos — the phone twin of desktop's SoLinePhotoStrip
   ──────────────────────────────────────────────────────────────────────────
   `photo_urls` has been in the SO detail endpoint's `ITEM` column list since
   migration 0076 (backend/src/scm/routes/mfg-sales-orders.ts, "PR-F — per-line
   photo keys"), so MobileSODetail has been receiving the keys on every request
   and rendered none of them: the only way to see an imported AutoCount
   reference shot on a phone was to open the desktop site.

   That is the third instance of one shape in that file's history and the
   second on this exact field — the desktop V2 detail carried `photo_urls` and
   drew nothing until 2026-08-10, and `remark` was "served by GET /:docNo all
   along and rendered on neither platform until 2026-08-11", its own comment
   four lines above where the field now sits.

   ── ONE LOGIC LAYER, TWO PRESENTATIONS (the owner's standing rule) ─────────
   LOADING is `useScmLinePhoto` — the identical state machine the desktop tile
   runs (signed URL -> authed proxy -> thumb tier, attempt state scoped per
   effect run). Hand-mirroring it is what made an earlier desktop draft render
   NOTHING in production, and all three regressions that have lived in that
   machine were found on screen rather than in CI.

   VIEWING is `MediaLightbox`, already the phone's full-screen previewer on
   MobilePMS. It brings prev/next, Escape-to-close, body-scroll lock and
   Download for free, and owns and revokes its own object URL.

   Only the CHROME differs from desktop: 64px tiles, because a 32px table-cell
   thumbnail is not a finger target.

   ── WHY THIS IS ITS OWN FILE ──────────────────────────────────────────────
   MobileSODetail is at 2,110 lines against a 2,118 ceiling, so the file-size
   ratchet leaves it eight lines of headroom. That is the gate working: this
   is a self-contained widget and it belongs beside the screen, not inside it.
   ────────────────────────────────────────────────────────────────────────── */
import { useState } from "react";
import { MediaLightbox, type MediaItem } from "../components/MediaLightbox";
import {
  photoContentType,
  soLinePhotoLightboxBase,
  useScmLinePhoto,
} from "../vendor/scm/lib/so-line-photo";

/** The line as the detail payload delivers it — dual-read camelCase ??
 *  snake_case, the same convention every other field on that row uses. */
export type MobileLinePhotoLine = {
  id: string;
  photoUrls?: string[] | null;
  photo_urls?: string[] | null;
};

export const linePhotoKeys = (line: MobileLinePhotoLine): string[] =>
  (Array.isArray(line.photoUrls) ? line.photoUrls
    : Array.isArray(line.photo_urls) ? line.photo_urls
    : []);

function Thumb({ docNo, itemId, photoKey, onOpen }: {
  docNo: string; itemId: string; photoKey: string; onOpen: () => void;
}) {
  const { src, error, onImgError } = useScmLinePhoto("so", photoKey, docNo, itemId);

  /* "err" is kept, never softened: when the proxy ALSO fails (404 missing
     object, 401/403 refused) a missing photo has to read AS missing. It is not
     a button — a retry that re-runs the same failing request is theatre — and
     the title carries the real reason for a bug report. */
  if (!src) {
    return (
      <span
        title={error ?? undefined}
        style={{
          width: 64, height: 64, borderRadius: 10,
          display: "inline-flex", alignItems: "center", justifyContent: "center",
          border: "1px solid var(--line2, #e3e6e0)", background: "#f4f6f3",
          fontSize: 10, fontWeight: 700,
          color: error ? "#b4443a" : "var(--mut2, #9aa093)",
        }}
      >
        {error ? "err" : "…"}
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label="View line photo"
      style={{
        width: 64, height: 64, padding: 0, borderRadius: 10, overflow: "hidden",
        border: "1px solid var(--line2, #e3e6e0)", background: "#f4f6f3", cursor: "pointer",
      }}
    >
      <img
        src={src}
        alt="Line photo"
        onError={onImgError}
        style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
      />
    </button>
  );
}

export function MobileLinePhotos({ docNo, line }: { docNo: string; line: MobileLinePhotoLine }) {
  const [openAt, setOpenAt] = useState<number | null>(null);
  const photoKeys = linePhotoKeys(line);
  if (!docNo || !line.id || !photoKeys.length) return null;

  /* MediaLightbox joins `${baseUrl}/${r2_key}` verbatim, so the key is
     PRE-ENCODED: an SO photo key is `so-items/<docNo>/<itemId>/<name>.jpg` and
     its slashes have to survive as ONE path segment or Hono's `:photoKey`
     param never matches and the proxy 404s. `caption` carries the bare file
     name because MediaLightbox derives its Download filename from
     `caption || r2_key.split("/").pop()` — and the encoded key has no "/" left
     to split on, so without this a download saves as one %2F-mangled blob. */
  const items = photoKeys.map((k): MediaItem => ({
    r2_key: encodeURIComponent(k),
    content_type: photoContentType(k),
    caption: k.split("/").pop() || k,
  }));

  return (
    <>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
        {photoKeys.map((k, i) => (
          <Thumb key={k} docNo={docNo} itemId={line.id} photoKey={k} onOpen={() => setOpenAt(i)} />
        ))}
      </div>
      {/* The viewer must NOT reuse a tile's `src`: under the proxy arm that is a
          blob: URL scoped to the tile's current effect run AND it holds THUMB
          bytes. MediaLightbox re-fetches the FULL object from the same authed
          proxy route — which is the point, not waste. */}
      {openAt !== null && (
        <MediaLightbox
          items={items}
          index={openAt}
          onChange={setOpenAt}
          onClose={() => setOpenAt(null)}
          baseUrl={soLinePhotoLightboxBase(docNo, line.id)}
          badge="Line photo"
        />
      )}
    </>
  );
}
