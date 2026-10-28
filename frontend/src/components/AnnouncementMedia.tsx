import { useEffect, useMemo, useState } from "react";
import { Play, FileText, File as FileIcon, Download } from "lucide-react";
import { api } from "../api/client";
import { loadThumbFirst } from "../lib/imagePipeline";
import { MediaLightbox, type MediaItem } from "./MediaLightbox";
import { cn } from "../lib/utils";

// ────────────────────────────────────────────────────────────────────────────
// AnnouncementMedia — the ONE desktop renderer for an announcement's attached
// media, honouring the author's layout hint (mig 0140). Used by both the
// pop-up notice (AnnouncementBanner) and the Announcements page rows so the same
// media lays out identically everywhere.
//
//   · Photos → a grid whose column count comes from the `photo` hint
//     (1 big / 2 side-by-side / 3 across / 4 = 2x2), defaulting to a
//     count-derived arrangement when the hint is absent (legacy rows).
//   · Video  → a poster tile shaped by the `video` hint (1x1 square /
//     1x2 portrait); click opens the lightbox which streams + plays it.
//   · Docs   → compact rows with a Download action.
//
// Thumbnails stream from the auth-gated R2 endpoint as blob: URLs (a plain
// <img src> can't carry the bearer), revoked on unmount. Clicking any photo or
// video opens the shared MediaLightbox for full-screen viewing / download.
// ────────────────────────────────────────────────────────────────────────────

export type AnnAttachment = {
  r2Key: string;
  name: string;
  mime: string;
  size?: number;
};

export type PhotoLayout = "1" | "2" | "3" | "4";
export type VideoLayout = "1x1" | "1x2";
export type AnnMediaLayout = { photo?: PhotoLayout; video?: VideoLayout } | null;

const isImage = (m: string) => (m || "").startsWith("image/");
const isVideo = (m: string) => (m || "").startsWith("video/");

// Grid columns for a photo-layout choice. "4" is a 2x2 grid (2 columns), the
// rest map 1:1 to their column count.
function photoCols(layout: PhotoLayout): number {
  return layout === "4" ? 2 : Number(layout);
}

// Count-derived default when no hint is stored (legacy rows render unchanged):
// 1 photo big, 2 side-by-side, 3 across, 4+ as a 2x2 grid.
function defaultPhotoLayout(n: number): PhotoLayout {
  if (n <= 1) return "1";
  if (n === 2) return "2";
  if (n === 3) return "3";
  return "4";
}

// Aspect ratio for the video poster, faithful to the author's 1x1 / 1x2 choice.
function videoAspect(layout: VideoLayout): string {
  return layout === "1x2" ? "1 / 2" : "1 / 1";
}

// A single blob-streamed image tile. Falls back to a neutral placeholder while
// loading or on failure.
function Thumb({
  annId,
  att,
  className,
  onClick,
  preferThumb = false,
}: {
  annId: string;
  att: AnnAttachment;
  className?: string;
  onClick?: () => void;
  /** WO-7 — multi-photo grid tiles load the light `.thumb` sibling first
   *  (fallback: the original, which is all pre-thumb notices have). The
   *  single full-width photo layout keeps the original for sharpness, and
   *  the lightbox click-through always loads the full image. */
  preferThumb?: boolean;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    let made: string | null = null;
    const base = `/api/announcements/${encodeURIComponent(annId)}/attachments/${att.r2Key}`;
    loadThumbFirst((p) => api.fetchBlobUrl(p), base, preferThumb)
      .then((u) => {
        if (!live) {
          URL.revokeObjectURL(u);
          return;
        }
        made = u;
        setUrl(u);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [annId, att.r2Key, preferThumb]);

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "group relative overflow-hidden rounded-lg border border-border bg-surface-dim",
        onClick && "cursor-zoom-in",
        className,
      )}
    >
      {url && !failed ? (
        <img
          src={url}
          alt=""
          className="h-full w-full object-cover transition-transform group-hover:scale-[1.02]"
        />
      ) : (
        <span className="block h-full w-full" />
      )}
    </button>
  );
}

export function AnnouncementMedia({
  annId,
  attachments,
  layout,
  className,
}: {
  annId: string;
  attachments: AnnAttachment[] | undefined;
  layout: AnnMediaLayout;
  className?: string;
}) {
  const atts = attachments ?? [];
  const photos = atts.filter((a) => isImage(a.mime));
  const videos = atts.filter((a) => isVideo(a.mime));
  const docs = atts.filter((a) => !isImage(a.mime) && !isVideo(a.mime));

  // Lightbox participates over photos + videos in DOM order (docs are
  // download-only, handled inline). Index maps into this combined array.
  const lightboxItems: MediaItem[] = useMemo(
    () =>
      [...photos, ...videos].map((a) => ({
        r2_key: a.r2Key,
        content_type: a.mime,
        caption: a.name,
      })),
    [photos, videos],
  );
  const [lightboxIdx, setLightboxIdx] = useState<number | null>(null);

  if (atts.length === 0) return null;

  const photoLayout =
    (layout?.photo as PhotoLayout | undefined) ??
    defaultPhotoLayout(photos.length);
  const cols = photoCols(photoLayout);
  const videoLayout = (layout?.video as VideoLayout | undefined) ?? "1x1";

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {photos.length > 0 && (
        <div
          className="grid gap-1.5"
          style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
        >
          {photos.map((p, i) => (
            <Thumb
              key={p.r2Key}
              annId={annId}
              att={p}
              preferThumb={cols > 1}
              className={cols === 1 ? "aspect-video" : "aspect-square"}
              onClick={() => setLightboxIdx(i)}
            />
          ))}
        </div>
      )}

      {videos.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {videos.map((v, i) => (
            <button
              key={v.r2Key}
              type="button"
              onClick={() => setLightboxIdx(photos.length + i)}
              className="relative w-full overflow-hidden rounded-lg border border-border bg-ink/90"
              style={{ aspectRatio: videoAspect(videoLayout), maxHeight: 420 }}
            >
              <span className="absolute inset-0 grid place-items-center">
                <span className="grid h-12 w-12 place-items-center rounded-full bg-white/15 backdrop-blur-sm">
                  <Play size={20} className="translate-x-[1px] text-white" />
                </span>
              </span>
              <span className="absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/60 to-transparent px-3 py-2 text-left text-[11px] font-semibold text-white">
                {v.name}
              </span>
            </button>
          ))}
        </div>
      )}

      {docs.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {docs.map((d) => (
            <div
              key={d.r2Key}
              className="flex items-center gap-2.5 rounded-lg border border-border bg-surface px-3 py-2"
            >
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-err/10 text-err">
                {(d.mime || "").includes("pdf") ? (
                  <FileText size={15} />
                ) : (
                  <FileIcon size={15} />
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12.5px] font-semibold text-ink">
                  {d.name}
                </span>
                <span className="block text-[10.5px] uppercase tracking-wide text-ink-muted">
                  {(d.mime || "").includes("pdf") ? "PDF" : "File"}
                </span>
              </span>
              <button
                type="button"
                onClick={() =>
                  void api
                    .downloadFile(
                      `/api/announcements/${encodeURIComponent(annId)}/attachments/${d.r2Key}`,
                      d.name || "attachment",
                    )
                    .catch(() => {})
                }
                className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2.5 py-1 text-[11px] font-semibold text-ink-secondary hover:border-accent/40 hover:text-accent"
              >
                <Download size={12} />
                Download
              </button>
            </div>
          ))}
        </div>
      )}

      {lightboxIdx != null && lightboxItems[lightboxIdx] && (
        <MediaLightbox
          items={lightboxItems}
          index={lightboxIdx}
          onChange={setLightboxIdx}
          onClose={() => setLightboxIdx(null)}
          baseUrl={`/api/announcements/${encodeURIComponent(annId)}/attachments`}
        />
      )}
    </div>
  );
}
