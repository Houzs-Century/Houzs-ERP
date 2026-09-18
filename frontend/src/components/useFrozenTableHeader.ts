// useFrozenTableHeader — the shared geometry behind the owner's 2026-07-24 rule
// "每个table的header都要freeze".
//
// Lifted out of DataTable.tsx UNCHANGED on 2026-09-09 so the MRP page — which
// keeps its own hand-built Model -> Variant -> SO tree table and therefore never
// went through DataTable — freezes its header by the SAME mechanism instead of a
// second, divergent one. The comments below record the iterations this geometry
// already survived (owner: "看的list就很少了", "5177 sales order看不到",
// "偶尔会freeze偶尔不行"); a re-implementation would repeat every one of them.
//
// The caller wires four elements and gets the measurements back:
//
//   <div ref={rootRef}>                          the frozen composition's root
//     ...toolbar / tabs / filters...
//     <div style={boxStyle}>                     bordered table box, sticky
//       <div ref={scrollWrapRef} style={scrollStyle}       the vertical scroller
//            className="overflow-x-auto overflow-y-auto">
//         <table>  <thead position:sticky; top:0>  ...
//       </div>
//     </div>
//     {freezeBox && freezeBox.runway > 0 && (
//       <div ref={spacerRef} aria-hidden style={{ height: freezeBox.runway }} />
//     )}
//   </div>
//
// A page may extend the composition UPWARDS by marking the first strip that must
// stay on screen with `data-freeze-anchor`.
import { useLayoutEffect, useRef, useState } from "react";

export type FreezeBox = { top: number; maxH: number; runway: number };

/** @param enabled false while the table is not rendered (mobile card view, an
 *  empty state) — the freeze disarms and the page returns to plain flow. */
export function useFrozenTableHeader(enabled: boolean) {
  // ── Frozen table header (owner 2026-07-24: "每个table的header都要freeze") ──
  // The <thead> is position:sticky, but in the app's page-scroll layout the
  // horizontal-scroll wrapper captures the vertical sticky context yet never
  // scrolls vertically, so the header just scrolls away. The fix: the wrapper
  // becomes the vertical scroll container (body rows scroll INSIDE it, the
  // sticky header freezes against its top) and the table box itself is sticky
  // under the pinned page header.
  //
  // v1 capped the wrapper between its RESTING top and the viewport bottom,
  // which left the page nothing to scroll — everything above the table (KPI
  // cards, the Service-Cases stage funnel) was permanently pinned and the
  // visible list shrank to a few rows (owner: "看的list就很少了"); and on pages
  // whose pre-table content pushed the table below the minimum the freeze
  // silently disabled itself (owner: "5177 sales order看不到"). So instead:
  // the page keeps scrolling normally — pre-table content scrolls away first —
  // and the table box rides up until it STICKS just under the pinned page
  // header (`--page-header-offset`, measured and published by Layout.tsx).
  // The cap is viewport-bottom minus that offset, so once stuck the table
  // fills the rest of the screen. Short tables never grow an inner scrollbar.
  // No `overscroll-contain`: at the inner top the wheel must chain to the page
  // so scrolling up brings the KPI/funnel strip back. Desktop only: the mobile
  // card/list view has its own layout and isn't a wide scrolling table.
  const scrollWrapRef = useRef<HTMLDivElement>(null);
  const freezeRootRef = useRef<HTMLDivElement>(null);
  const runwaySpacerRef = useRef<HTMLDivElement>(null);
  const [freezeBox, setFreezeBox] = useState<{ top: number; maxH: number; runway: number } | null>(null);
  useLayoutEffect(() => {
    if (!enabled) {
      setFreezeBox(null);
      return;
    }
    const BOTTOM_GAP = 12;
    const MIN_FREEZE_H = 240;
    const recompute = () => {
      const el = scrollWrapRef.current;
      const rootEl = freezeRootRef.current;
      if (!el || !rootEl || window.innerWidth < 640) {
        setFreezeBox(null); // mobile card view — leave the flow alone
        return;
      }
      const raw = getComputedStyle(document.documentElement).getPropertyValue("--page-header-offset");
      const parsed = parseFloat(raw);
      /* A page without a pinned PageHeader publishes no var — fall back to
         clearing the app chrome bar alone. */
      const pageTop = Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : 64;
      /* The frozen composition is the WHOLE component (owner pointed at the
         scrolled state he wants kept: "我要滑动到这里freeze着"): the toolbar
         (search / Export / Columns) above the table and the pager below it
         stay on screen, the rows fill whatever is left. So the geometry is
         anchored on the component root, and the toolbar/pager heights are
         MEASURED and reserved out of the row cap. Both deltas are differences
         between same-frame rects, so they are scroll- and cap-independent. */
      /* A page may extend the frozen composition above the component: mark
         the FIRST strip that must stay on screen (KPI card grid, status-tab
         row, view toggles) with `data-freeze-anchor` and its TOP becomes the
         composition's top edge — everything from there down to the pager
         freezes under the page header, while content above/outside it (stage
         funnels etc.) scrolls away. (Owner on SO: "我要这样freeze" pointing
         at cards+tabs+toolbar+header; on Service Cases the funnel must go.)
         The marker is a boundary, not a wrapper, so no page restructuring.
         Default boundary: the component root. The pager reserve is always
         the component's own trailing chrome, measured off the root. */
      const main = el.closest("main");
      const cand = (main ?? document).querySelector("[data-freeze-anchor]") as HTMLElement | null;
      const anchorEl =
        cand && (cand.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
          ? cand
          : rootEl;
      const rootRect = rootEl.getBoundingClientRect();
      const anchorRect = anchorEl.getBoundingClientRect();
      const boxRect = el.getBoundingClientRect();
      const aboveBox = Math.max(0, Math.round(boxRect.top - anchorRect.top));
      const spacerH = runwaySpacerRef.current?.offsetHeight ?? 0;
      const belowBox = Math.max(0, Math.round(rootRect.bottom - spacerH - boxRect.bottom));
      const stickTop = pageTop + aboveBox;
      const maxH = Math.floor(window.innerHeight - stickTop - belowBox - BOTTOM_GAP);
      /* Only freeze when the rows genuinely overflow the cap — compare CONTENT
         height against the prospective cap (scrollHeight is cap-independent),
         so a short table keeps its plain flow and never grows a scrollbar. */
      if (maxH < MIN_FREEZE_H || el.scrollHeight <= maxH) {
        setFreezeBox((prev) => (prev === null ? prev : null));
        return;
      }
      /* The runway spacer is the load-bearing half of the design. Page scroll
         must be able to carry the component root up to the pinned page
         header's bottom edge — but capping the row area shrinks the page so
         its scroll range ends just SHORT of that, and whether the header
         looked frozen depended on which scroller the wheel happened to drive
         (owner: "偶尔会freeze偶尔不行"). The spacer at the very bottom of the
         component restores exactly that missing runway, so page-scroll always
         lands on the frozen composition; `position: sticky` on the table box
         is then just the safety net for measurement drift. */
      const anchorRestingTop = anchorRect.top + (main?.scrollTop ?? 0);
      const target = Math.max(0, Math.ceil(anchorRestingTop - pageTop));
      /* The spacer supplies only the MISSING scroll — the page already scrolls
         by whatever sits below the capped table (pager, margins, page footer),
         and adding the full target ON TOP of that let the page overshoot the
         composition by exactly that surplus, shoving the toolbar and header
         out under the page header (owner's "??" screenshot). Sizing the spacer
         as target − existing makes the page's scroll LIMIT land precisely on
         the frozen composition, so the geometry holds even where an animated/
         transformed ancestor silently disables the box's position:sticky (a
         transform makes it the containing block); the in-box thead sticky
         scrolls against the wrapper and is immune to all of that. */
      let runway = target;
      let cappedMaxH = maxH;
      if (main) {
        const spacerNow = runwaySpacerRef.current?.offsetHeight ?? 0;
        const wrapNow = el.clientHeight;
        /* Solve for the scroll range the page WOULD have with no spacer and
           the box at the full viewport-fit cap, then split the difference:
           too little range -> the spacer supplies the deficit; too much ->
           the box gives the surplus back (shrinking it shortens the page by
           the same amount), so scroll-max lands the anchor EXACTLY on the
           page header's bottom edge either way. Both terms are derived from
           the live measurement, so one RO tick after any layout change this
           re-converges; the same-value guard stops the feedback there. */
        const baseScrollable = Math.max(
          0,
          main.scrollHeight - spacerNow - main.clientHeight + (maxH - wrapNow)
        );
        runway = Math.max(0, target - baseScrollable);
        const surplus = Math.max(0, baseScrollable - target);
        cappedMaxH = Math.max(MIN_FREEZE_H, maxH - surplus);
      }
      setFreezeBox((prev) =>
        prev && prev.top === stickTop && prev.maxH === cappedMaxH && prev.runway === runway
          ? prev
          : { top: stickTop, maxH: cappedMaxH, runway }
      );
    };
    recompute();
    // Watch the element whose size actually tracks the page's content: the
    // route container INSIDE <main>. The app shell is a fixed-viewport flex
    // (`h-dvh overflow-hidden`), so document.body NEVER resizes — observing
    // it meant recompute ran exactly once, at mount, while the list was
    // still empty, judged "nothing overflows", and never armed the freeze
    // (owner: "偶尔会freeze偶尔不行" — the freeze only survived when cached
    // rows were already present at mount). Rows arriving, the stage funnel
    // loading, filters expanding — they all resize main's first child.
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(recompute) : null;
    try {
      /* Climb from the table to <main>'s DIRECT child that contains it — the
         page-content flow whose height tracks rows, funnel, filters, all of
         it. NOT main.firstElementChild: main's first children are the sticky
         app bars (h-14 / h-[52px], display-fixed — the desktop one is even
         0px tall), which never resize, and observing one of those meant the
         one recompute that ran during a loading transient (rows unmounted →
         "nothing overflows" → disarm) was also the LAST recompute ever. */
      let contentEl: Element | null = scrollWrapRef.current;
      const mainEl = scrollWrapRef.current?.closest("main") ?? null;
      while (contentEl && contentEl.parentElement && contentEl.parentElement !== mainEl) {
        contentEl = contentEl.parentElement;
      }
      ro?.observe(contentEl ?? document.body);
    } catch {
      /* no-op */
    }
    window.addEventListener("resize", recompute);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", recompute);
    };
  }, [enabled]);

  return {
    /** Root of the frozen composition — everything that must stay on screen. */
    rootRef: freezeRootRef,
    /** The element that scrolls vertically; the sticky thead freezes to its top. */
    scrollWrapRef,
    /** Bottom spacer that gives back the page scroll the height cap took away. */
    spacerRef: runwaySpacerRef,
    freezeBox,
    /** Sticky style for the bordered table box; undefined = not frozen. */
    boxStyle: freezeBox
      ? ({ position: "sticky", top: freezeBox.top, zIndex: 10 } as const)
      : undefined,
    /** Height cap for the scroller; undefined = not frozen, plain flow. */
    scrollStyle: freezeBox ? { maxHeight: freezeBox.maxH } : undefined,
  };
}
