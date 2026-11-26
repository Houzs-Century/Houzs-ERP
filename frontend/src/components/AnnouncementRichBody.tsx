import { useEffect, useMemo, useRef, type CSSProperties } from "react";
import { api } from "../api/client";
import { cn } from "../lib/utils";
import { sanitizeAnnouncementHtml } from "../lib/announcementRichText";
import { loadThumbFirst } from "../lib/imagePipeline";

type Props = {
  html?: string | null;
  text: string;
  className?: string;
  style?: CSSProperties;
  id?: string;
  annId?: string | null;
  imageSrc?: (key: string) => string | undefined;
};

export function AnnouncementRichBody({ html, text, className, style, id, annId, imageSrc }: Props) {
  const safe = useMemo(() => (html ? sanitizeAnnouncementHtml(html) : ""), [html]);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = ref.current;
    if (!root || !safe) return;
    const imgs = Array.from(root.querySelectorAll<HTMLImageElement>("img[data-att]"));
    if (imgs.length === 0) return;
    let cancelled = false;
    const made: string[] = [];
    for (const img of imgs) {
      const key = img.getAttribute("data-att") ?? "";
      img.setAttribute("alt", "");
      img.setAttribute("loading", "lazy");
      const local = imageSrc?.(key);
      if (local) {
        img.src = local;
        continue;
      }
      if (!annId) continue;
      const base = `/api/announcements/${encodeURIComponent(annId)}/attachments/${key}`;
      loadThumbFirst((p) => api.fetchBlobUrl(p), base, false)
        .then((url) => {
          if (cancelled) {
            URL.revokeObjectURL(url);
            return;
          }
          made.push(url);
          img.src = url;
        })
        .catch(() => {
          img.setAttribute("data-missing", "true");
        });
    }
    return () => {
      cancelled = true;
      for (const u of made) URL.revokeObjectURL(u);
    };
  }, [safe, annId, imageSrc]);

  if (safe) {
    return (
      <div
        ref={ref}
        id={id}
        className={cn("ann-rich", className)}
        style={style}
        dangerouslySetInnerHTML={{ __html: safe }}
      />
    );
  }
  if (!text) return null;
  return (
    <div id={id} className={cn("whitespace-pre-wrap", className)} style={style}>
      {text}
    </div>
  );
}
