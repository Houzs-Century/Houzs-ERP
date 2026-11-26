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

  if (!src) {
    return (
      <span
        title={error ?? undefined}
        style={{
          width: 64, height: 64, borderRadius: 10,
          display: "inline-flex", alignItems: "center", justifyContent: "center",
          border: "1px solid var(--line2, var(--hz-c-border-subtle))", background: "var(--hz-c-surface-2)",
          fontSize: 10, fontWeight: 700,
          color: error ? "#b4443a" : "var(--mut2, var(--hz-c-ink-soft))",
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
        border: "1px solid var(--line2, var(--hz-c-border-subtle))", background: "var(--hz-c-surface-2)", cursor: "pointer",
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
