import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { cn } from "../lib/utils";

interface Props {
  /** Raw text to render. */
  text: string | null | undefined;
  /** Line count to clamp at when collapsed. Defaults to 2. */
  lines?: number;
  /** Wrap classes for the outer block. */
  className?: string;
  /** Optional placeholder when text is empty. Defaults to "—". */
  emptyLabel?: string;
}

const CLAMP_CLASS: Record<number, string> = {
  1: "line-clamp-1",
  2: "line-clamp-2",
  3: "line-clamp-3",
  4: "line-clamp-4",
  5: "line-clamp-5",
  6: "line-clamp-6",
};

/**
 * Multi-line text block that line-clamps to N lines and reveals a
 * "Show more" toggle when the actual content overflows. Detection is
 * via a ResizeObserver on the rendered element so it stays correct
 * across container resizes (sidebar collapse, viewport rotation).
 *
 * For pure single-line identifier truncation (project codes, customer
 * names in tables) prefer a plain `truncate` + `title=` — the cost of
 * a stateful component per cell isn't worth it there.
 */
export function ExpandableText({
  text,
  lines = 2,
  className,
  emptyLabel = "—",
}: Props) {
  const value = (text ?? "").toString();
  const ref = useRef<HTMLDivElement | null>(null);
  const [overflow, setOverflow] = useState(false);
  const [expanded, setExpanded] = useState(false);

  // Re-measure on mount, on text change, and whenever the box resizes.
  // scrollHeight > clientHeight + 1 px is the canonical "is it
  // clipped?" test; the +1 forgives sub-pixel rounding in some
  // browsers.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || expanded) return;
    setOverflow(el.scrollHeight > el.clientHeight + 1);
  }, [value, lines, expanded]);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (expanded) return;
      setOverflow(el.scrollHeight > el.clientHeight + 1);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [expanded]);

  if (!value) {
    return <span className={cn("text-ink-muted", className)}>{emptyLabel}</span>;
  }

  const clampClass = expanded ? "" : CLAMP_CLASS[lines] ?? "line-clamp-2";

  return (
    <div className={cn("min-w-0", className)}>
      <div
        ref={ref}
        title={!expanded && overflow ? value : undefined}
        className={cn("whitespace-pre-wrap break-words", clampClass)}
      >
        {value}
      </div>
      {(overflow || expanded) && (
        <button
          type="button"
          onClick={(e) => {
            // Don't bubble — most call sites wrap this in a clickable
            // row / link, and the user almost always means the toggle.
            e.preventDefault();
            e.stopPropagation();
            setExpanded((x) => !x);
          }}
          className="mt-0.5 text-[10.5px] font-semibold uppercase tracking-wider text-accent transition-colors hover:text-accent-hover"
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}
