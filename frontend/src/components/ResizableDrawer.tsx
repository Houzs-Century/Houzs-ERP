// ----------------------------------------------------------------------------
// ResizableDrawer — a right-side slide-over whose width the user can DRAG (a
// left-edge handle), clamped to a min/max and persisted per `storageKey` to
// localStorage. The existing DetailDrawer pattern (fixed right-0 max-w-[520px])
// is a FIXED-width slide-over; this is its resizable sibling.
//
// Generic + reusable on purpose (chrome only — no domain knowledge): a caller
// supplies the title, optional subtitle, header actions, body and footer. First
// consumer is the Delivery Planning scheduling drawer (ScheduleTripDrawer), but
// nothing here is delivery-specific.
//
// Desktop surface. Mounted only while shown (the caller conditionally renders
// it); Escape and a scrim click both close.
// ----------------------------------------------------------------------------

import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { X } from "lucide-react";
import { cn } from "../lib/utils";

/* Clamp a width to [min, max], and never wider than the viewport minus a gutter
   so the close/scrim edge stays reachable. Null-safe for SSR (no window). */
function clampWidth(w: number, min: number, max: number): number {
  const viewportCap = typeof window !== "undefined" ? window.innerWidth - 80 : max;
  return Math.min(Math.max(w, min), Math.min(max, viewportCap));
}

export function ResizableDrawer({
  onClose,
  title,
  subtitle,
  headerActions,
  footer,
  children,
  storageKey,
  defaultWidth = 560,
  minWidth = 420,
  maxWidth = 1040,
  ariaLabel,
}: {
  onClose: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  headerActions?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  /** localStorage key the chosen width persists under (personal pref). */
  storageKey: string;
  defaultWidth?: number;
  minWidth?: number;
  maxWidth?: number;
  ariaLabel?: string;
}) {
  const [width, setWidth] = useState<number>(() => {
    if (typeof window === "undefined") return defaultWidth;
    const saved = Number(window.localStorage.getItem(storageKey));
    return clampWidth(Number.isFinite(saved) && saved > 0 ? saved : defaultWidth, minWidth, maxWidth);
  });
  const dragRef = useRef<{ startX: number; startW: number } | null>(null);

  /* Dragging the LEFT edge: moving the pointer left (smaller clientX) makes the
     drawer WIDER, so width grows by (startX − currentX). */
  const onPointerMove = useCallback(
    (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      setWidth(clampWidth(d.startW + (d.startX - e.clientX), minWidth, maxWidth));
    },
    [minWidth, maxWidth],
  );

  const endDrag = useCallback(() => {
    if (!dragRef.current) return;
    dragRef.current = null;
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", endDrag);
    setWidth((w) => {
      try { window.localStorage.setItem(storageKey, String(Math.round(w))); } catch { /* private mode */ }
      return w;
    });
  }, [onPointerMove, storageKey]);

  const startDrag = (e: ReactPointerEvent) => {
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startW: width };
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", endDrag);
  };

  /* Esc closes. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  /* Belt-and-braces: drop any in-flight drag listeners on unmount. */
  useEffect(
    () => () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", endDrag);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    },
    [onPointerMove, endDrag],
  );

  return (
    <>
      <div
        aria-hidden
        onClick={onClose}
        className="fixed inset-0 z-[90] bg-ink/30 transition-opacity duration-200"
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        style={{ width }}
        className="fixed right-0 top-0 z-[91] flex h-full max-w-full flex-col border-l border-border bg-surface shadow-slab"
      >
        {/* left-edge drag handle */}
        <div
          onPointerDown={startDrag}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize drawer"
          title="Drag to resize"
          className="group absolute left-0 top-0 z-10 flex h-full w-2 cursor-col-resize items-center justify-center hover:bg-primary/15 active:bg-primary/25"
        >
          <div className="h-8 w-[3px] rounded-full bg-border-strong transition-colors group-hover:bg-primary" />
        </div>

        {/* dark header */}
        <div className="flex h-[60px] shrink-0 items-center gap-3 bg-sidebar px-5 text-sidebar-ink">
          <button
            type="button"
            onClick={onClose}
            aria-label="Close drawer"
            className="text-sidebar-ink-muted hover:text-sidebar-ink"
          >
            <X size={18} />
          </button>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[15px] font-bold tracking-wide">{title}</div>
            {subtitle && <div className="mt-0.5 truncate text-[11px] text-sidebar-ink-muted">{subtitle}</div>}
          </div>
          {headerActions}
        </div>

        {/* scroll body */}
        <div className="flex-1 overflow-y-auto">{children}</div>

        {footer && <div className="shrink-0 border-t border-border bg-surface px-5 py-3">{footer}</div>}
      </aside>
    </>
  );
}
