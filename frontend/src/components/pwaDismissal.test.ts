import { beforeEach, describe, expect, test, vi } from "vitest";
import { shouldShowPwaPrompt } from "./pwaDismissal";

describe("PWA dismissal cooldown", () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });
  });

  test("shows without a dismissal and hides during a valid cooldown", () => {
    const now = 10 * 86_400_000;
    expect(shouldShowPwaPrompt("pwa", 7, now)).toBe(true);
    localStorage.setItem("pwa", String(now - 2 * 86_400_000));
    expect(shouldShowPwaPrompt("pwa", 7, now)).toBe(false);
  });

  test("shows again after the cooldown", () => {
    const now = 10 * 86_400_000;
    localStorage.setItem("pwa", String(now - 8 * 86_400_000));
    expect(shouldShowPwaPrompt("pwa", 7, now)).toBe(true);
  });

  test.each(["NaN", "Infinity", "-1", "999999999999999"])(
    "fails open and removes invalid timestamp %s",
    (value) => {
      localStorage.setItem("pwa", value);
      expect(shouldShowPwaPrompt("pwa", 7, 1_000_000)).toBe(true);
      expect(localStorage.getItem("pwa")).toBeNull();
    },
  );
});
