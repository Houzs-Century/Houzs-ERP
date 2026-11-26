
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

export const DETAIL_DRAWER_WIDTH_KEY = "panel-scm-detail-drawer.v1";

export const DETAIL_DRAWER_MIN_WIDTH = 420;
export const DETAIL_DRAWER_MAX_WIDTH = 1100;
export const DETAIL_DRAWER_DEFAULT_WIDTH = 520;

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
        onClick={onClose}
        aria-hidden
        className={cn(
          "fixed inset-0 z-[90] bg-ink/40 backdrop-blur-[1px] transition-opacity duration-200 md:hidden",
          open ? "opacity-100" : "pointer-events-none opacity-0",
        )}
      />
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
