// Where a popover opens so all of it is on screen (owner 2026-11-04: the date
// picker's calendar ran under the sidebar). It opens under its trigger, its left
// edge on the trigger's; when that runs past the right of the window it lines up
// with the trigger's right edge instead; it never leaves an 8px margin of the
// window, and opens above the trigger when there is no room below but room above.

export type Rect = { left: number; right: number; top: number; bottom: number };

export const POPOVER_MARGIN = 8;
const GAP = 6;

export function placePopover(trigger: Rect, width: number, height: number, viewW: number, viewH: number): { left: number; top: number } {
  const maxLeft = Math.max(POPOVER_MARGIN, viewW - width - POPOVER_MARGIN);
  const preferred = trigger.left + width <= viewW - POPOVER_MARGIN ? trigger.left : trigger.right - width;
  const left = Math.min(Math.max(preferred, POPOVER_MARGIN), maxLeft);
  const below = trigger.bottom + GAP;
  const above = trigger.top - GAP - height;
  const top = below + height <= viewH - POPOVER_MARGIN || above < POPOVER_MARGIN ? below : above;
  return { left, top };
}
