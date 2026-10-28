import { Fragment, type ReactNode } from "react";
import { splitHighlight } from "./utils";

/**
 * Renders `text` with every case-insensitive occurrence of `query` wrapped in a
 * bold <mark>. Shared by BOTH the desktop Cmd+K palette (GlobalSearch) and the
 * mobile search palette (MobileSearch) so the "bold the matched keyword"
 * behaviour is identical everywhere.
 *
 * Default (no className) — reads as an emphasised run of the SAME text:
 * transparent background, inherited colour, weight 700. This is what
 * MobileSearch relies on so the highlight matches the surrounding label.
 *
 * With a className — the caller owns the visual entirely (bg / colour /
 * weight / radius). Inline overrides are dropped so Tailwind classes like
 * `bg-primary/[.12] text-primary-ink font-semibold` actually paint. Used by
 * the desktop GlobalSearch palette for the Theme C petrol pill.
 */
export function HighlightedText({
  text,
  query,
  className,
}: {
  text: string | null | undefined;
  query: string | null | undefined;
  className?: string;
}): ReactNode {
  const segments = splitHighlight(text, query);
  const defaultStyle = className
    ? undefined
    : { background: "transparent", color: "inherit", fontWeight: 700 };
  return (
    <>
      {segments.map((seg, i) =>
        seg.match ? (
          <mark key={i} className={className} style={defaultStyle}>
            {seg.text}
          </mark>
        ) : (
          <Fragment key={i}>{seg.text}</Fragment>
        ),
      )}
    </>
  );
}
