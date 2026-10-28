import { useEffect, useMemo, useRef, type CSSProperties } from "react";
import { api } from "../api/client";
import { cn } from "../lib/utils";
import { sanitizeAnnouncementHtml } from "../lib/announcementRichText";
import { loadThumbFirst } from "../lib/imagePipeline";

// ---------------------------------------------------------------------------
// AnnouncementRichBody — the ONE way an announcement body reaches the screen.
//
// Five surfaces show a notice body (desktop list row, desktop pop-up banner,
// phone detail, phone pop-up, and — plain-text only — the bell excerpt). They
// all used to print `body` inside a whitespace-pre-wrap block. This component
// keeps that exact plain path for every notice without formatting (`html`
// absent → legacy rows, system notices, phone-composed plain notices) and
// adds the rich path: the stored `bodyHtml` fragment, re-run through the
// allow-list canonicaliser and rendered inside `.ann-rich` (index.css).
//
// dangerouslySetInnerHTML is safe HERE and only here because the string it
// receives has just come out of sanitizeAnnouncementHtml(), whose output
// alphabet is a fixed set of tags with three enumerated / validated
// attributes — no handlers, no style, an href only on the http(s)/mailto
// allow-list, and an image that names an attachment KEY, never a URL. The
// backend canonicalised on write too; this second pass is the belt to that
// brace, and it is idempotent so nothing drifts.
//
// Inline images (2026-09-05): the fragment carries `<img data-att="<key>">`.
// After the fragment is in the DOM this component resolves each key through
// the SAME authenticated attachment endpoint the media grid uses
// (`/api/announcements/:id/attachments/:key`, which refuses any key outside
// the notice's manifest), so an image can only ever show the notice's own
// attachment. The composer's preview passes `imageSrc` instead, because a
// notice that is still being written has no id to stream from.
// ---------------------------------------------------------------------------
type Props = {
  /** Canonical rich fragment (announcements.body_html). Null/empty = plain. */
  html?: string | null;
  /** The plain-text body — always present, always the fallback. */
  text: string;
  className?: string;
  style?: CSSProperties;
  id?: string;
  /** The notice's id, so inline images can be streamed from its attachments. */
  annId?: string | null;
  /** Local override for inline images (composer preview). Wins over `annId`. */
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
      // Full-size, not the thumb: an inline image is read, not browsed.
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
          // A key outside the manifest (or a deleted object) simply shows no
          // image; the text around it is untouched.
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
