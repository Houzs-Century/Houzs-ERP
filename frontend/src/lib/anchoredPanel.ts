// ----------------------------------------------------------------------------
// anchoredPanel — the ONE way this app floats a menu under a form control.
//
// `position: absolute` escapes layout FLOW but not an ancestor's OVERFLOW clip.
// A menu rendered as a sibling of its trigger is therefore sliced off by any
// card, drawer or scroll container between the trigger and the viewport — which
// is how the State dropdown on the Sales Order address block ended up showing
// three states out of seventeen (#2110, owner: "我的 state 的那个 UI 也是被直接
// 斩断了"). z-index cannot fix it; only leaving the clipping subtree can.
//
// So the panel goes in a <body> portal with `position: fixed`, and every bit of
// its geometry is measured from the trigger. This module is that measurement,
// extracted from StatePicker so the pickers share ONE implementation instead of
// each carrying a copy that drifts.
// ----------------------------------------------------------------------------

import { useLayoutEffect, useMemo, useState, type RefObject } from 'react';

/* Panel geometry, in px. Fixed house values — a caller choosing its own gap or
   floor is how two menus on one page stop looking like one control. Only the
   CAP is per-caller, because it is the list's own design (a ten-row state list
   and a two-row confirm menu are not the same object). */
const PANEL_GAP = 4;
const PANEL_MIN_H = 120;
const VIEWPORT_MARGIN = 8;

/** Where a portalled panel sits, in viewport coordinates. Anchored by `top`
 *  when it hangs below the trigger, by `bottom` when it is flipped above it. */
export type AnchoredPanelPos = {
  left: number;
  width: number;
  top?: number;
  bottom?: number;
  maxHeight: number;
};

/** The part of the trigger's `getBoundingClientRect()` the geometry needs. */
export type AnchorRect = {
  top: number;
  bottom: number;
  left: number;
  width: number;
};

/**
 * Place a panel against `anchor` inside a `viewportHeight`-tall viewport.
 *
 * `maxHeight` is REQUIRED and not defaulted: it is the list's own design, and a
 * default here would silently give every new caller the state picker's ten-row
 * box (CLAUDE.md — "a default is a decision nobody reviews").
 *
 * Pure, so the flip and the clamp are testable without a DOM.
 */
export function measureAnchoredPanel(
  anchor: AnchorRect,
  viewportHeight: number,
  maxHeight: number,
): AnchoredPanelPos {
  const below = viewportHeight - anchor.bottom - PANEL_GAP - VIEWPORT_MARGIN;
  const above = anchor.top - PANEL_GAP - VIEWPORT_MARGIN;
  // Flip up only when below cannot hold the list AND above holds more of it.
  const flipUp = below < Math.min(maxHeight, above);
  return {
    left: anchor.left,
    width: anchor.width,
    top: flipUp ? undefined : anchor.bottom + PANEL_GAP,
    bottom: flipUp ? viewportHeight - anchor.top + PANEL_GAP : undefined,
    maxHeight: Math.max(PANEL_MIN_H, Math.min(maxHeight, flipUp ? above : below)),
  };
}

/**
 * Place a panel whose WIDTH is its own design rather than the trigger's — a
 * fixed-width menu such as a column funnel popover — and clamp it horizontally
 * as well. `width` is the PANEL's, which is the whole difference from
 * `measureAnchoredPanel`, where it is the trigger's and is inherited.
 *
 * `maxHeight` stays REQUIRED for the same reason it is there; pass
 * `viewportHeight - 2 * VIEWPORT_MARGIN` for a menu that may use the whole
 * window when there is room.
 */
export function measureFixedWidthPanel(
  anchor: { top: number; bottom: number; left: number },
  width: number,
  viewport: { width: number; height: number },
  maxHeight: number,
): AnchoredPanelPos {
  const pos = measureAnchoredPanel({ ...anchor, width }, viewport.height, maxHeight);
  const maxLeft = viewport.width - width - VIEWPORT_MARGIN;
  return { ...pos, left: Math.max(VIEWPORT_MARGIN, Math.min(pos.left, maxLeft)) };
}

/** `measureFixedWidthPanel` against the live window, recomputed when the
 *  anchor changes. For a menu anchored to a rect captured at click time — it
 *  has no live element to re-measure, and this app's point-anchored menus
 *  close on scroll rather than following it. */
export function useFixedWidthPanel(
  anchor: { top: number; bottom: number; left: number } | null,
  width: number,
  maxHeight: number,
): AnchoredPanelPos | null {
  return useMemo(
    () => (anchor
      ? measureFixedWidthPanel(anchor, width, { width: window.innerWidth, height: window.innerHeight }, maxHeight)
      : null),
    [anchor, width, maxHeight],
  );
}

function samePos(a: AnchoredPanelPos | null, b: AnchoredPanelPos): boolean {
  return (
    a !== null &&
    a.left === b.left &&
    a.width === b.width &&
    a.top === b.top &&
    a.bottom === b.bottom &&
    a.maxHeight === b.maxHeight
  );
}

/**
 * Track `anchorRef`'s position while `open`, for a panel portalled to <body>.
 *
 * Re-measures on `scroll` in the CAPTURE phase — the trigger usually sits in a
 * scrolling card or drawer, and those scroll events never reach `window` on the
 * bubble path — and on `resize`. Both listeners come off when the panel closes
 * and on unmount. Returns null while closed, which is also the render guard.
 *
 * An unchanged measurement keeps the PREVIOUS object. A scroll gesture fires
 * dozens of events and each measurement is a fresh object, so returning it
 * would re-render the whole picker per event — and would spin forever for a
 * caller whose ref identity is not stable.
 */
export function useAnchoredPanel(
  anchorRef: RefObject<HTMLElement | null>,
  open: boolean,
  maxHeight: number,
): AnchoredPanelPos | null {
  const [pos, setPos] = useState<AnchoredPanelPos | null>(null);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const update = () => {
      const el = anchorRef.current;
      if (!el) return;
      const next = measureAnchoredPanel(el.getBoundingClientRect(), window.innerHeight, maxHeight);
      setPos((prev) => (samePos(prev, next) ? prev : next));
    };
    update();
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [anchorRef, open, maxHeight]);

  return pos;
}

/** The placement half of a portalled panel's inline style. Scrolling and paint
 *  stay with the caller, because they differ (a bordered card that clips its
 *  own rounded corners and scrolls an inner list is not the same as a list that
 *  scrolls itself). `zIndex` matches every other body-portalled menu here
 *  (SoLineCard, SearchableSelect, StatePicker); it clears the drawer backdrops
 *  these forms sit in (z-index 50). */
export function anchoredPanelStyle(pos: AnchoredPanelPos): React.CSSProperties {
  return {
    position: 'fixed',
    left: pos.left,
    width: pos.width,
    /* BOTH EDGES, ALWAYS — `'auto'` for the one this placement does not use.
     *
     * `pos.top` and `pos.bottom` are exclusive: a panel that flips UP carries
     * only `bottom`. Writing `top: pos.top` then hands React `undefined`, and
     * React OMITS an undefined style property — so the element keeps whatever
     * `top` its own class rule sets, and the two combine into a box that is
     * over-constrained to zero height.
     *
     * That is not hypothetical. Measured on production 2026-08-22, the Sales
     * Order fabric picker:
     *
     *   class      position:absolute; top:100%; left:0; right:0
     *   inline     position:fixed; left:295px; width:286px; bottom:376px
     *   used       top 816px (=100% of the 816px viewport), height 2px
     *
     *   816 - 816 - 376 = -376  ->  clamped to 0; the 2px was its own borders.
     *
     * The panel WAS rendering, with all 18 rows in it, parked on the bottom
     * edge of the window at the height of a hairline. It looked exactly like
     * "the dropdown does not open".
     *
     * The same class also sets `right: 0`, and SoLineCard already passed
     * `right: 'auto'` by hand to neutralise it — half of this bug had been
     * found and patched at ONE call site. Neutralising both edges here fixes
     * it for every consumer at once, and stops the next panel that flips up
     * from inheriting a stray `top`.
     *
     * `'auto'` is the CSS initial value, so this is a no-op for a panel whose
     * class sets neither. */
    top: pos.top ?? 'auto',
    bottom: pos.bottom ?? 'auto',
    maxHeight: pos.maxHeight,
    zIndex: 1000,
  };
}
