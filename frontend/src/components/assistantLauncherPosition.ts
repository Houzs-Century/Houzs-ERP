// ---------------------------------------------------------------------------

import { identityStorageKey } from "../lib/storageIdentity";
// Pure geometry + persistence for the draggable AssistantLauncher disc.
//
// Split out of the component so the drag maths is unit-testable WITHOUT pulling
// React / react-router / AuthContext into the test graph — the disc's one
// user-visible guarantee (it can never be dragged or resized off-screen) lives
// here as a pure function.
// ---------------------------------------------------------------------------

export const STORAGE_KEY = "houzs:assistant-launcher-pos";
export const assistantLauncherStorageKey = () => identityStorageKey(STORAGE_KEY);

// Distance the pointer must travel before a grab counts as a DRAG rather than a
// click. Small enough that a deliberate drag registers instantly, large enough
// that the finger jitter of a tap never trips it.
export const DRAG_THRESHOLD_PX = 6;

// Keep at least this much of a gap between the disc and the viewport edge when
// clamping, so it never hugs the very edge (or hides under rounded corners).
export const EDGE_MARGIN_PX = 8;

// Fallback disc size used before the button has measured itself. Matches the
// rendered 56px (h-14 w-14) disc.
export const DISC_SIZE_PX = 56;

export interface Offset {
  /** px from the right viewport edge to the disc's right edge. */
  right: number;
  /** px from the bottom viewport edge to the disc's bottom edge. */
  bottom: number;
}

// First-run anchor: bottom-right, one disc-width to the LEFT of the round
// green "+" (right-5 = 20px, 48 wide → occupies out to 68px). 80px clears it
// with a small gap; bottom 20 lines up with the "+"'s baseline.
export const DEFAULT_OFFSET: Offset = { right: 80, bottom: 20 };

// Pure so it's unit-testable without a DOM: the caller supplies the viewport
// (window.innerWidth/Height at call time). Keeps the disc's right/bottom offsets
// inside [EDGE_MARGIN, viewport - discSize - EDGE_MARGIN], so a fling can never
// push it off-screen and a shrunk viewport can never strand it in dead space.
export function clampOffset(
  off: Offset,
  discW: number,
  discH: number,
  vw: number,
  vh: number,
): Offset {
  const maxRight = Math.max(EDGE_MARGIN_PX, vw - discW - EDGE_MARGIN_PX);
  const maxBottom = Math.max(EDGE_MARGIN_PX, vh - discH - EDGE_MARGIN_PX);
  return {
    right: Math.min(Math.max(off.right, EDGE_MARGIN_PX), maxRight),
    bottom: Math.min(Math.max(off.bottom, EDGE_MARGIN_PX), maxBottom),
  };
}

// Read the persisted position, tolerating a missing/corrupt value (privacy mode,
// hand-edited storage) by falling back to the bottom-right default.
export function readStoredOffset(): Offset {
  try {
    const key = assistantLauncherStorageKey();
    if (!key) return DEFAULT_OFFSET;
    const raw = localStorage.getItem(key);
    if (!raw) return DEFAULT_OFFSET;
    const parsed = JSON.parse(raw) as Partial<Offset>;
    if (
      typeof parsed?.right === "number" &&
      Number.isFinite(parsed.right) &&
      typeof parsed?.bottom === "number" &&
      Number.isFinite(parsed.bottom)
    ) {
      return { right: parsed.right, bottom: parsed.bottom };
    }
  } catch {
    // corrupt / privacy mode — fall through to the default
  }
  return DEFAULT_OFFSET;
}
