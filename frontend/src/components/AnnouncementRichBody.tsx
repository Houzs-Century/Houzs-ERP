import { useMemo, type CSSProperties } from "react";
import { cn } from "../lib/utils";
import { sanitizeAnnouncementHtml } from "../lib/announcementRichText";

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
// alphabet is a fixed set of tags with one enumerated attribute — no URLs, no
// handlers, no style. The backend canonicalised on write too; this second
// pass is the belt to that brace, and it is idempotent so nothing drifts.
// ---------------------------------------------------------------------------
type Props = {
  /** Canonical rich fragment (announcements.body_html). Null/empty = plain. */
  html?: string | null;
  /** The plain-text body — always present, always the fallback. */
  text: string;
  className?: string;
  style?: CSSProperties;
  id?: string;
};

export function AnnouncementRichBody({ html, text, className, style, id }: Props) {
  const safe = useMemo(() => (html ? sanitizeAnnouncementHtml(html) : ""), [html]);
  if (safe) {
    return (
      <div
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
