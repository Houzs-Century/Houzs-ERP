import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, X, FileText, Download } from "lucide-react";
import { api } from "../api/client";

export interface MediaItem {
  r2_key: string;
  content_type?: string | null;
  caption?: string | null;
}

/**
 * Fullscreen previewer for R2-backed assets — images render inline with
 * prev/next nav, anything else (PDF / xlsx / docx) shows a centred
 * filename + Download button so the user can open it in a new tab.
 *
 * Mirrors the StaffLightbox pattern in ServiceCases. Navigation jumps
 * through image items only; non-image items show standalone.
 */
export function MediaLightbox({
  items,
  index,
  onChange,
  onClose,
  baseUrl,
  badge,
}: {
  items: MediaItem[];
  index: number;
  onChange: (i: number) => void;
  onClose: () => void;
  /** API base path that streams an R2 key, e.g. "/api/projects/attachments". */
  baseUrl: string;
  /** Optional small label rendered at top-left (e.g. "Setup"). */
  badge?: string;
}) {
  // Both images and videos participate in prev/next navigation —
  // documents (PDF/xlsx/docx) are dead-ends visually so they stay out.
  const mediaIndices = useMemo(
    () =>
      items
        .map((a, i) => {
          const t = a.content_type || "";
          return t.startsWith("image/") || t.startsWith("video/") ? i : -1;
        })
        .filter((i) => i >= 0),
    [items]
  );
  const currentMediaPos = mediaIndices.indexOf(index);
  const item = items[index];
  const isImage = !!item && (item.content_type || "").startsWith("image/");
  const isVideo = !!item && (item.content_type || "").startsWith("video/");
  const isPdf = !!item && ((item.content_type || "").includes("pdf") || /\.pdf$/i.test(item.r2_key));
  // PDFs render inline via <iframe> — but MOBILE browsers (Android Chrome in
  // particular) have no inline PDF viewer, so the iframe paints an EMPTY box:
  // reported as "sales can't see the file in Unfilled plan" (owner 2026-09-01).
  // On phone-sized screens fall back to the file card (name + Open/Download).
  const pdfInline =
    typeof window !== "undefined" &&
    window.matchMedia("(min-width: 768px)").matches &&
    !/Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
  const [url, setUrl] = useState<string | null>(null);

  const go = useCallback(
    (delta: number) => {
      if (currentMediaPos < 0 || mediaIndices.length === 0) return;
      const nextPos =
        (currentMediaPos + delta + mediaIndices.length) % mediaIndices.length;
      onChange(mediaIndices[nextPos]);
    },
    [currentMediaPos, mediaIndices, onChange]
  );

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft") go(-1);
      else if (e.key === "ArrowRight") go(1);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, onClose]);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  useEffect(() => {
    if (!item) return;
    setUrl(null);
    let revoked = false;
    api
      // Re-type octet-stream blobs from the item's known MIME so a PDF renders
      // inline in the <iframe> below instead of triggering a download.
      .fetchBlobUrl(`${baseUrl}/${item.r2_key}`, item.content_type)
      .then((u) => {
        if (!revoked) setUrl(u);
        else URL.revokeObjectURL(u);
      })
      .catch(() => {});
    return () => {
      revoked = true;
      if (url) URL.revokeObjectURL(url);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item?.r2_key, baseUrl]);

  if (!item || typeof document === "undefined") return null;

  const extLabel = (() => {
    const m = item.r2_key.match(/\.([a-z0-9]+)$/i);
    return m ? m[1].toUpperCase() : "FILE";
  })();

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/85 backdrop-blur-sm animate-fade-in"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div
        className="absolute inset-x-0 top-0 flex items-center justify-between gap-3 px-4 py-3 text-white sm:px-6 sm:py-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 text-[11px] uppercase tracking-[2pt]">
          {badge && (
            <span className="rounded-full border border-white/30 px-2 py-0.5 font-semibold">
              {badge}
            </span>
          )}
          {(isImage || isVideo) && mediaIndices.length > 1 && (
            <span className="font-mono text-[10px] text-white/60">
              {currentMediaPos + 1} / {mediaIndices.length}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => {
              const name = item.caption || item.r2_key.split("/").pop() || "download";
              void api.downloadFile(`${baseUrl}/${item.r2_key}`, name).catch(() => {});
            }}
            aria-label="Download"
            title="Download"
            className="rounded-full bg-white/10 p-2 text-white transition-colors hover:bg-white/20"
          >
            <Download size={18} />
          </button>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded-full bg-white/10 p-2 text-white transition-colors hover:bg-white/20"
          >
            <X size={18} />
          </button>
        </div>
      </div>

      {(isImage || isVideo) && mediaIndices.length > 1 && (
        <>
          <button
            onClick={(e) => {
              e.stopPropagation();
              go(-1);
            }}
            aria-label="Previous"
            className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full bg-white/10 p-2 text-white transition-colors hover:bg-white/20 sm:left-6"
          >
            <ChevronLeft size={22} />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              go(1);
            }}
            aria-label="Next"
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-white/10 p-2 text-white transition-colors hover:bg-white/20 sm:right-6"
          >
            <ChevronRight size={22} />
          </button>
        </>
      )}

      <div
        className="relative flex max-h-[90vh] max-w-[92vw] items-center justify-center"
        onClick={(e) => e.stopPropagation()}
      >
        {isImage ? (
          url ? (
            <img
              src={url}
              alt={item.caption || ""}
              className="max-h-[88vh] max-w-[92vw] select-none object-contain shadow-2xl"
              draggable={false}
            />
          ) : (
            <div className="flex h-64 w-64 items-center justify-center rounded bg-white/5 text-white/60">
              Loading…
            </div>
          )
        ) : isVideo ? (
          url ? (
            <video
              src={url}
              controls
              autoPlay
              playsInline
              className="max-h-[88vh] max-w-[92vw] rounded shadow-2xl"
            />
          ) : (
            <div className="flex h-64 w-64 items-center justify-center rounded bg-white/5 text-white/60">
              Loading…
            </div>
          )
        ) : isPdf && pdfInline ? (
          url ? (
            <iframe
              src={url}
              title={item.caption || "PDF"}
              className="h-[88vh] w-[92vw] max-w-[1000px] rounded bg-white shadow-2xl"
            />
          ) : (
            <div className="flex h-64 w-64 items-center justify-center rounded bg-white/5 text-white/60">
              Loading…
            </div>
          )
        ) : (
          <div className="flex flex-col items-center gap-4 rounded-xl bg-white/5 px-10 py-12 text-white">
            <FileText size={60} className="text-white/70" />
            <div className="text-center">
              <div className="text-[16px] font-bold">{item.caption || extLabel + " file"}</div>
              <div className="mt-1 text-[11px] uppercase tracking-[2pt] text-white/60">
                {extLabel}
              </div>
            </div>
            {url && (
              <a
                href={url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-2 rounded-md bg-white/10 px-4 py-2 text-[13px] font-semibold uppercase tracking-wide text-white transition-colors hover:bg-white/20"
              >
                <FileText size={15} /> Open
              </a>
            )}
          </div>
        )}
      </div>

      {item.caption && (isImage || isVideo) && (
        <div
          className="absolute inset-x-0 bottom-0 px-4 py-3 text-center text-[11px] text-white/70 sm:py-4"
          onClick={(e) => e.stopPropagation()}
        >
          {item.caption}
        </div>
      )}
    </div>,
    document.body
  );
}
