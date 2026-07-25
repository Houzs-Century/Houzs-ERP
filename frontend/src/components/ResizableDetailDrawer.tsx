// ----------------------------------------------------------------------------
// ResizableDetailDrawer — the shared CHROME for the SCM record detail drawers
// (the right slide-over with "Open full page" that opens from a row on the SO /
// PO / GRN / PI / DO / DR / PR / SI ListV2 pages). It used to be a FIXED
// 520px slide-over DUPLICATED inside every ListV2 page; this shell owns the
// scrim + the fixed panel + a left-edge drag handle so the width is RESIZABLE
// on desktop and PERSISTED (one shared localStorage key, so the width the user
// picks on any one detail drawer carries across all of them).
//
// Chrome only — no domain knowledge. Each page renders its EXISTING drawer
// content (the dark header, meta grid, body, footer) as `children`; nothing
// about the data or the look changes, only the width + the drag behaviour.
//
// Desktop surface. ALWAYS mounted (the caller keeps it mounted and toggles
// `open`); `open` drives the translate-x slide, exactly as the old per-page
// drawers did. Mobile is untouched: the panel stays `w-full max-w-[520px]` and
// the resize handle is hidden — the phone experience is the full-screen detail,
// not this slide-over.
// ----------------------------------------------------------------------------

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { cn } from "../lib/utils";

/* One shared width for every SCM detail drawer. `panel-` prefix keeps it in the
   already-approved grid-and-panel layout family (a DEVICE_PREF — a layout
   preference, no identity/company data). */
export const DETAIL_DRAWER_WIDTH_KEY = "panel-scm-detail-drawer.v1";

export const DETAIL_DRAWER_MIN_WIDTH = 420;
export const DETAIL_DRAWER_MAX_WIDTH = 1100;
export const DETAIL_DRAWER_DEFAULT_WIDTH = 520;

/* Clamp to [min, max], and never wider than the viewport minus a gutter so the
   scrim/close edge stays reachable. Null-safe for SSR (no window). */
function clampWidth(w: number, min: number, max: number): number {
  const viewportCap = typeof window !== "undefined" ? window.innerWidth - 80 : max;
  return Math.min(Math.max(w, min), Math.min(max, viewportCap));
}

export function ResizableDetailDrawer({
  open,
  onClose,
  ariaLabel,
  children,
}: {
  open: boolean;
  onClose: () => void;
  ariaLabel?: string;
  children: ReactNode;
}) {
  const [width, setWidth] = useState<number>(() => {
    if (typeof window === "undefined") return DETAIL_DRAWER_DEFAULT_WIDTH;
    const saved = Number(window.localStorage.getItem(DETAIL_DRAWER_WIDTH_KEY));
    return clampWidth(
      Number.isFinite(saved) && saved > 0 ? saved : DETAIL_DRAWER_DEFAULT_WIDTH,
      DETAIL_DRAWER_MIN_WIDTH,
      DETAIL_DRAWER_MAX_WIDTH,
    );
  });
  const dragRef = useRef<{ startX: number; startW: number } | null>(null);

  /* Dragging the LEFT edge: moving the pointer left (smaller clientX) makes the
     drawer WIDER, so width grows by (startX − currentX). */
  const onPointerMove = useCallback((e: PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    setWidth(
      clampWidth(
        d.startW + (d.startX - e.clientX),
        DETAIL_DRAWER_MIN_WIDTH,
        DETAIL_DRAWER_MAX_WIDTH,
      ),
    );
  }, []);

  const endDrag = useCallback(() => {
    if (!dragRef.current) return;
    dragRef.current = null;
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", endDrag);
    setWidth((w) => {
      try {
        window.localStorage.setItem(DETAIL_DRAWER_WIDTH_KEY, String(Math.round(w)));
      } catch {
        /* private mode — width simply won't persist */
      }
      return w;
    });
  }, [onPointerMove]);

  const startDrag = (e: ReactPointerEvent) => {
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startW: width };
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", endDrag);
  };

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
      {/* scrim — mobile only. On desktop the underlying list reflows via
          md:pr-[540px] so it stays visible next to the drawer; no need to dim. */}
      <div
        onClick={onClose}
        aria-hidden
        className={cn(
          "fixed inset-0 z-[90] bg-ink/40 backdrop-blur-[1px] transition-opacity duration-200 md:hidden",
          open ? "opacity-100" : "pointer-events-none opacity-0",
        )}
      />
      {/* slide-over. Mobile keeps the original w-full max-w-[520px]; desktop
          drops the cap and takes the dragged width from the CSS var. Only the
          transform animates, so the drag stays instant. */}
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        style={{ "--hz-detail-drawer-w": `${width}px` } as CSSProperties}
        className={cn(
          "fixed right-0 top-0 z-[91] flex h-full w-full max-w-[520px] flex-col border-l border-border bg-surface shadow-slab transition-transform duration-200",
          "md:max-w-none md:w-[var(--hz-detail-drawer-w)]",
          open ? "translate-x-0" : "translate-x-full",
        )}
      >
        {/* left-edge drag handle — desktop only (mobile is full-screen) */}
        <div
          onPointerDown={startDrag}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize drawer"
          title="Drag to resize"
          className="group absolute left-0 top-0 z-10 hidden h-full w-2 cursor-col-resize items-center justify-center hover:bg-primary/15 active:bg-primary/25 md:flex"
        >
          <div className="h-8 w-[3px] rounded-full bg-border-strong transition-colors group-hover:bg-primary" />
        </div>

        {children}
      </aside>
    </>
  );
}
