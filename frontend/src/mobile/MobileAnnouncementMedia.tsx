import { useEffect, useState } from "react";
import { api } from "../api/client";
import { loadThumbFirst } from "../lib/imagePipeline";
import type {
  AnnAttachment,
  AnnMediaLayout,
  PhotoLayout,
  VideoLayout,
} from "../components/AnnouncementMedia";

// ---------------------------------------------------------------------------
// MobileAnnouncementMedia — the ONE phone renderer for an announcement's
// attachments (annAttBig() from the owner's mobile design): a photo grid, then
// video blocks, then PDF / file rows with a Download action.
//
// Lifted out of MobileAnnouncements.tsx unchanged so the new pop-up
// (MobileAnnouncementPopup) shows the SAME attachments with the SAME download
// affordance as the Announcements detail screen, instead of a second copy that
// could drift. The desktop equivalent is components/AnnouncementMedia; the two
// read the same layout hint (mig 0140) so a notice lays out the same on both.
// Types come from the desktop module so there is one definition of an
// attachment / a layout hint in the app.
// ---------------------------------------------------------------------------

export type { AnnAttachment, AnnMediaLayout, PhotoLayout, VideoLayout };

// The minimum an announcement must carry to render its media — the mobile list
// row type and the shared banner type both satisfy it.
export type MediaBearingAnnouncement = {
  id: string;
  attachments?: AnnAttachment[] | null;
  mediaLayout?: AnnMediaLayout;
};

export const isImage = (att: AnnAttachment) => (att.mime || "").startsWith("image/");
export const isVideo = (att: AnnAttachment) => (att.mime || "").startsWith("video/");

// Layout-hint helpers (mig 0140). Mirror the desktop AnnouncementMedia mapping
// so a notice lays out identically on both platforms.
function photoCols(layout: PhotoLayout): number {
  return layout === "4" ? 2 : Number(layout);
}
function defaultPhotoLayout(n: number): PhotoLayout {
  if (n <= 1) return "1";
  if (n === 2) return "2";
  if (n === 3) return "3";
  return "4";
}
function videoAspect(layout: VideoLayout): string {
  return layout === "1x2" ? "1 / 2" : "1 / 1";
}

export const fmtSize = (n?: number) => {
  if (!n || n <= 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
};

// A photo/video thumb streamed from R2. <img src> can't carry the bearer, so we
// fetch it as a blob URL (api.fetchBlobUrl) and revoke on unmount. Falls back to
// the design's .ph placeholder if there's no image / the fetch fails.
export function MediaThumb({ ann, att, style, preferThumb = false }: { ann: MediaBearingAnnouncement; att: AnnAttachment; style: React.CSSProperties; preferThumb?: boolean }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    let made: string | null = null;
    const path = `/api/announcements/${encodeURIComponent(ann.id)}/attachments/${att.r2Key}`;
    // WO-7 — multi-photo grid tiles load the light `.thumb` sibling first
    // (fallback: the original, which is all pre-thumb notices have). Single
    // full-width photos and video posters keep the original for sharpness.
    loadThumbFirst((p) => api.fetchBlobUrl(p), path, preferThumb)
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
  }, [ann.id, att.r2Key, preferThumb]);

  if (url && !failed) {
    return <img src={url} alt="" style={{ ...style, objectFit: "cover", display: "block" }} />;
  }
  return <div className="ph" style={style} />;
}

// annDl() — stream the attachment as a blob and trigger a browser download.
export async function download(ann: MediaBearingAnnouncement, att: AnnAttachment) {
  try {
    const u = await api.fetchBlobUrl(
      `/api/announcements/${encodeURIComponent(ann.id)}/attachments/${att.r2Key}`,
    );
    const link = document.createElement("a");
    link.href = u;
    link.download = att.name || "attachment";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(u), 4000);
  } catch {
    /* silent — the row stays visible, tap to retry. */
  }
}

// annAttBig() — inline attachments: a photo grid, then video blocks, then PDF /
// file rows. Nothing renders if there are no attachments.
export function Attachments({ ann }: { ann: MediaBearingAnnouncement }) {
  const atts = ann.attachments ?? [];
  if (!atts.length) return null;
  const photos = atts.filter(isImage);
  const rest = atts.filter((a) => !isImage(a));

  // Honour the author's layout hint; fall back to a count-derived default so
  // legacy (NULL media_layout) notices render as before.
  const photoLayout = ann.mediaLayout?.photo ?? defaultPhotoLayout(photos.length);
  const cols = photoCols(photoLayout);
  const videoLayout = ann.mediaLayout?.video ?? "1x1";
  const photoAspect = cols === 1 ? "16 / 9" : "1 / 1";

  return (
    <div>
      <div className="ey" style={{ color: "#767b6e", margin: "0 2px 8px" }}>Attachments</div>
      {photos.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: `repeat(${cols},1fr)`, gap: 7, marginBottom: 8 }}>
          {photos.map((p) => (
            <MediaThumb key={p.r2Key} ann={ann} att={p} preferThumb={cols > 1} style={{ width: "100%", aspectRatio: photoAspect, borderRadius: 9 }} />
          ))}
        </div>
      )}
      {rest.map((a) =>
        isVideo(a) ? (
          <div key={a.r2Key} style={{ position: "relative", borderRadius: 11, overflow: "hidden", marginBottom: 8 }}>
            <MediaThumb ann={ann} att={a} style={{ width: "100%", aspectRatio: videoAspect(videoLayout), maxHeight: 380, borderRadius: 11 }} />
            <span style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
              <span style={{ width: 44, height: 44, borderRadius: "50%", background: "rgba(0,0,0,.45)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="#fff"><path d="M8 5v14l11-7Z" /></svg>
              </span>
            </span>
            <span style={{ position: "absolute", bottom: 8, left: 10, fontSize: 10.5, fontWeight: 600, color: "#fff" }}>
              {a.name}{fmtSize(a.size) ? ` · ${fmtSize(a.size)}` : ""}
            </span>
          </div>
        ) : (
          <div key={a.r2Key} style={{ display: "flex", alignItems: "center", gap: 10, border: "1px solid #e3e6e0", borderRadius: 11, padding: "10px 12px", marginBottom: 8 }}>
            <span style={{ width: 34, height: 34, flex: "none", borderRadius: 8, background: "#f8eaea", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#b23a3a" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 3v4a1 1 0 0 0 1 1h4" /><path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2Z" /></svg>
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12.5, fontWeight: 700, color: "#11140f", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.name}</div>
              <div style={{ fontSize: 10.5, color: "#9aa093" }}>
                {(a.mime || "").includes("pdf") ? "PDF" : "File"}{fmtSize(a.size) ? ` · ${fmtSize(a.size)}` : ""}
              </div>
            </div>
            <span onClick={() => download(ann, a)} style={{ fontSize: 11, fontWeight: 700, color: "#a16a2e", cursor: "pointer" }}>Download</span>
          </div>
        ),
      )}
    </div>
  );
}
