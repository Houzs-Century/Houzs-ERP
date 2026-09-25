import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { SortState } from "./dataTableTypes";

// Resize / pin tuning. MIN_COL_WIDTH is the floor a drag can shrink a
// column to. DEFAULT_COL_WIDTH is the assumed width when computing a
// pinned column's sticky-left offset and the column has no user width and
// no px-parseable `width` default (e.g. a "%" width or none at all).
export const MIN_COL_WIDTH = 64;
export const DEFAULT_COL_WIDTH = 160;

// Row windowing: past this many FLAT rows, render only the slice scrolled into
// view (see the effect in the component). Kept a no-op for grouped/expandable
// tables and short lists, so existing pages render byte-identically. Threshold
// mirrors the SCM DataGrid's (25) with a little headroom.
export const VIRTUAL_ROW_THRESHOLD = 30;
export const VIRTUAL_OVERSCAN = 12;
export const ROW_HEIGHT_ESTIMATE = 33; // px; corrected at runtime by measuring a real row
export function sanitizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string" && item.length > 0))]
    .slice(0, 500);
}

export function sanitizeSortState(value: unknown): SortState | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.key !== "string" || !record.key) return null;
  if (record.dir !== "asc" && record.dir !== "desc") return null;
  return { key: record.key, dir: record.dir };
}

export function sanitizeMobileView(value: unknown): "cards" | "table" {
  return value === "table" ? "table" : "cards";
}

export function sanitizeColumnWidths(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const widths: Record<string, number> = {};
  for (const [key, width] of Object.entries(value as Record<string, unknown>)) {
    if (!key || typeof width !== "number" || !Number.isFinite(width)) continue;
    widths[key] = Math.min(10_000, Math.max(40, width));
    if (Object.keys(widths).length >= 500) break;
  }
  return widths;
}

// Keep a pointer-anchored context menu inside the viewport: one opened near the
// bottom or right edge hung off-screen, and any page scroll dismisses these
// menus, so the clipped tail was unreachable. Measured after render, re-clamped
// on resize; the raw anchor shows for the frame before that, so nothing jumps.
// NOT the funnel popover — that goes through lib/anchoredPanel, which also
// decides which SIDE to open on.
export function useViewportClampedPos(
  anchor: { x: number; y: number } | null,
  ref: React.RefObject<HTMLDivElement | null>,
): { top: number; left: number } | null {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    if (!anchor) {
      setPos(null);
      return;
    }
    const el = ref.current;
    if (!el) return;
    const clamp = () => {
      setPos({
        top: Math.max(8, Math.min(anchor.y, window.innerHeight - el.offsetHeight - 8)),
        left: Math.max(8, Math.min(anchor.x, window.innerWidth - el.offsetWidth - 8)),
      });
    };
    clamp();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(clamp) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [anchor, ref]);
  if (!anchor) return null;
  return pos ?? { top: anchor.y, left: anchor.x };
}

/**
 * The toolbar search box. Types instantly, tells the page 250ms later.
 *
 * The keystroke has to stay local or the caret stutters and a fast typist loses
 * characters — so the field is driven by `draft`, and `onChange` is what gets
 * debounced. The two-way sync is the fiddly half:
 *
 *  - DOWN: the page can change the value itself (a Reset Filters click, a URL
 *    with `?search=`, a restored sticky filter). We must accept that and
 *    overwrite the draft. But we must NOT overwrite it with the page's echo of
 *    what we just sent up, or a slow re-render would snap the caret back to a
 *    stale value mid-word. `lastSentRef` distinguishes the two: a `value` equal
 *    to what we last propagated is our own echo and is ignored.
 *  - UP: debounced, and skipped entirely when the draft already equals `value`,
 *    so mounting or an echo never fires a redundant onChange.
 *
 * Flushed on Enter and on blur, because a user who types and immediately hits
 * Enter or clicks away expects to have searched, not to wait out a timer.
 */
export function DebouncedSearchInput({
  value,
  onChange,
  placeholder,
  delayMs,
  className,
  onPendingChange,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder: string;
  delayMs: number;
  className: string;
  onPendingChange?: (pending: boolean) => void;
}) {
  const [draft, setDraft] = useState(value);
  const lastSentRef = useRef(value);
  const timerRef = useRef<number | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    onPendingChange?.(draft !== value);
  }, [draft, value, onPendingChange]);

  // DOWN-sync: adopt an externally-driven change, ignore our own echo.
  useEffect(() => {
    if (value !== lastSentRef.current) {
      lastSentRef.current = value;
      setDraft(value);
    }
  }, [value]);

  // UP-sync: debounced.
  useEffect(() => {
    if (draft === lastSentRef.current) return;
    if (delayMs <= 0) {
      lastSentRef.current = draft;
      onChangeRef.current(draft);
      return;
    }
    const t = window.setTimeout(() => {
      timerRef.current = null;
      lastSentRef.current = draft;
      onChangeRef.current(draft);
    }, delayMs);
    timerRef.current = t;
    return () => {
      window.clearTimeout(t);
      if (timerRef.current === t) timerRef.current = null;
    };
  }, [draft, delayMs]);

  /* Cancels the pending timer as well as sending. Without the cancel, blurring
     100ms into a 250ms window fired onChange twice with the same value — the
     flush, then the timer that was still armed. Harmless for a search box, but
     it is a duplicate request per blur, which is the exact thing this component
     exists to stop. */
  const flush = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (draft === lastSentRef.current) return;
    lastSentRef.current = draft;
    onChangeRef.current(draft);
  };

  return (
    <input
      value={draft}
      onChange={(e) => {
        const next = e.target.value;
        setDraft(next);
        onPendingChange?.(next !== value);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") flush();
      }}
      onBlur={flush}
      placeholder={placeholder}
      className={className}
    />
  );
}

// Parse a column's `width` CSS string into a pixel number when possible.
// "120px" → 120, "120" → 120. Non-px units ("20%", "8rem") and undefined
// return null so the caller falls back to DEFAULT_COL_WIDTH for offset math
// (the inline width style still passes the original string through for those).
export function parsePxWidth(width: string | undefined): number | null {
  if (!width) return null;
  const m = /^(\d+(?:\.\d+)?)(px)?$/.exec(width.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}
