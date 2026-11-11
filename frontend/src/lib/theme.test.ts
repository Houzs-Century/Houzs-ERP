import { describe, it, expect, beforeEach } from "vitest";
import { initTheme, resolveTheme, setThemePreference, getThemePreference, THEME_STORAGE_KEY } from "./theme";

describe("theme", () => {
  beforeEach(() => {
    localStorage.clear();
    delete document.documentElement.dataset.theme;
  });

  it("follows the device only when asked to", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  it("defaults to light when nothing was chosen, so nobody's screen changes unasked", () => {
    initTheme();
    expect(getThemePreference()).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("applies and remembers a choice", () => {
    initTheme();
    setThemePreference("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    initTheme();
    expect(getThemePreference()).toBe("dark");
  });

  it("ignores a junk stored value", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "purple");
    initTheme();
    expect(getThemePreference()).toBe("light");
  });
});
