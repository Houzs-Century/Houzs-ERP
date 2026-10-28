import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { DEFAULT_OFFSET, clampOffset, readStoredOffset } from "./assistantLauncherPosition";
import { bindBrowserStorageIdentity, clearBrowserStorageIdentity } from "../lib/storageIdentity";

// The disc's drag maths is pure (clampOffset) — the DOM gesture just feeds it
// pointer deltas. Locking the clamp here is what guarantees the disc can never
// be dragged (or resized) off-screen, which is the one behaviour a user would
// notice breaking.

const DISC = 56; // rendered disc size (h-14 w-14)
const VW = 1280;
const VH = 800;
let storedValue: string | null = null;

describe("AssistantLauncher clampOffset", () => {
  beforeEach(() => {
    bindBrowserStorageIdentity(1);
    storedValue = null;
    vi.stubGlobal("localStorage", {
      getItem: () => storedValue,
    });
  });

  afterEach(() => clearBrowserStorageIdentity());

  test("default anchor is the bottom-right area (small positive offsets)", () => {
    // Bottom-right means SMALL right/bottom offsets from those edges.
    expect(DEFAULT_OFFSET.right).toBeGreaterThan(0);
    expect(DEFAULT_OFFSET.bottom).toBeGreaterThan(0);
    // And it must survive its own clamp unchanged on a normal viewport.
    expect(clampOffset(DEFAULT_OFFSET, DISC, DISC, VW, VH)).toEqual(DEFAULT_OFFSET);
  });

  test("a drag toward the far top-left is clamped so the disc stays fully on-screen", () => {
    // Huge offsets would push the disc off the top-left; clamp pins it so its
    // far edge never crosses the opposite viewport edge (minus the 8px margin).
    const clamped = clampOffset({ right: 99999, bottom: 99999 }, DISC, DISC, VW, VH);
    expect(clamped.right).toBe(VW - DISC - 8);
    expect(clamped.bottom).toBe(VH - DISC - 8);
  });

  test("negative offsets (dragged past the bottom-right corner) snap to the edge margin", () => {
    const clamped = clampOffset({ right: -50, bottom: -50 }, DISC, DISC, VW, VH);
    expect(clamped.right).toBe(8);
    expect(clamped.bottom).toBe(8);
  });

  test("shrinking the viewport re-clamps a previously valid spot back into view", () => {
    // Disc parked 700px from the right edge on a wide screen…
    const wide = clampOffset({ right: 700, bottom: 400 }, DISC, DISC, 1280, 800);
    expect(wide.right).toBe(700);
    // …then the window shrinks to 400px wide: the disc must be pulled back so it
    // is still fully visible (max right offset = 400 - 56 - 8 = 336).
    const narrow = clampOffset(wide, DISC, DISC, 400, 400);
    expect(narrow.right).toBe(400 - DISC - 8);
    expect(narrow.right).toBeLessThan(wide.right);
  });

  test.each([
    JSON.stringify({ right: null, bottom: 24 }),
    JSON.stringify({ right: "88", bottom: 24 }),
    '{"right":1e999,"bottom":24}',
    "not-json",
  ])("rejects a corrupt or non-finite stored offset: %s", (raw) => {
    storedValue = raw;
    expect(readStoredOffset()).toEqual(DEFAULT_OFFSET);
  });
});
