import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { DEFAULT_OFFSET, clampOffset, readStoredOffset } from "./assistantLauncherPosition";
import { bindBrowserStorageIdentity, clearBrowserStorageIdentity } from "../lib/storageIdentity";


const DISC = 56;
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
    expect(DEFAULT_OFFSET.right).toBeGreaterThan(0);
    expect(DEFAULT_OFFSET.bottom).toBeGreaterThan(0);
    expect(clampOffset(DEFAULT_OFFSET, DISC, DISC, VW, VH)).toEqual(DEFAULT_OFFSET);
  });

  test("a drag toward the far top-left is clamped so the disc stays fully on-screen", () => {
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
    const wide = clampOffset({ right: 700, bottom: 400 }, DISC, DISC, 1280, 800);
    expect(wide.right).toBe(700);
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
