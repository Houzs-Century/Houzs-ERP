// BackToTopFAB — floating "scroll to top" button, mounted alongside
// QuickActionsFAB. Nick 2026-07-09: "可以在每个页面都添加回去顶部的
// 在右下角 + 的左边" — a jump-to-top affordance sits to the LEFT of the
// existing "+" (New SO) FAB on every page.
//
// Only shows once the user has scrolled past ~400 px so it doesn't
// clutter the corner on short pages. Scrolls the same <main> element
// that QuickActionsFAB shares as a peer (Layout.tsx mounts the <main
// class="overflow-y-auto">; that's the app's real scroll container,
// window/document scrolling is disabled by `overflow: hidden` on the
// html/body).

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLocation } from "react-router-dom";
import { ArrowUp } from "lucide-react";
import { cn } from "../lib/utils";

const SCROLL_THRESHOLD = 80;

export function BackToTopFAB() {
  const [visible, setVisible] = useState(false);
  const scrollElRef = useRef<HTMLElement | null>(null);
  const location = useLocation();

  useEffect(() => {
    // The Houzs layout wraps content in a single <main class="… overflow-y-auto …">
    // and disables document-level scrolling. That element IS the scroll container
    // — window.scrollTo would no-op.
    const main = document.querySelector("main");
    scrollElRef.current = main;
    if (!main) return;
    const onScroll = () => setVisible(main.scrollTop > SCROLL_THRESHOLD);
    onScroll();
    main.addEventListener("scroll", onScroll, { passive: true });
    return () => main.removeEventListener("scroll", onScroll);
  }, []);

  // Reset visibility on route change — a fresh page starts scrolled to top.
  useEffect(() => {
    setVisible(false);
  }, [location.pathname]);

  // Hide on the driver shell (separate layout, no <main> scroll container).
  if (location.pathname.startsWith("/driver")) return null;
  if (!visible) return null;

  const scrollToTop = () => {
    scrollElRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  };

  const node = (
    <button
      onClick={scrollToTop}
      aria-label="Back to top"
      title="Back to top"
      className={cn(
        // Owner 2026-07-23 "回到顶部轻量化": an unobtrusive 36px translucent
        // square floating ABOVE the corner cluster — utility chrome, not a
        // peer of the primary pill, so it whispers until hovered.
        "fixed z-40 inline-flex h-9 w-9 items-center justify-center rounded-lg",
        "border border-border/70 bg-surface/70 text-ink-muted backdrop-blur-sm",
        "transition-all duration-200 hover:bg-surface hover:text-primary hover:border-primary/40 active:scale-95",
        // Parks directly ABOVE the "New Case" pill, sharing its right offset.
        // Above-offsets = pill bottom + pill height (48) + 8 px gap:
        //   Mobile:  96 + 48 + 8 = 152 px  (+ safe-area-inset)
        //   Desktop: 20 + 48 + 8 = 76 px
        "right-4 bottom-[calc(9.5rem+env(safe-area-inset-bottom))]",
        "lg:right-5 lg:bottom-[76px]",
      )}
    >
      <ArrowUp size={16} strokeWidth={2.4} />
    </button>
  );

  if (typeof document === "undefined") return null;
  return createPortal(node, document.body);
}
