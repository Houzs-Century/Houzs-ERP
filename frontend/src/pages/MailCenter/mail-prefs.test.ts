import { afterEach, describe, expect, test } from "vitest";
import {
  bindBrowserStorageIdentity,
  clearBrowserStorageIdentity,
} from "../../lib/storageIdentity";
import {
  getPrefsSnapshot,
  setDensity,
  setReadingPane,
} from "./mail-prefs";

afterEach(() => {
  clearBrowserStorageIdentity();
  localStorage.clear();
});

describe("mail view preference identity scope", () => {
  test("does not carry preferences between users", () => {
    bindBrowserStorageIdentity(10);
    setDensity("comfortable");
    setReadingPane("split");
    expect(getPrefsSnapshot()).toMatchObject({ density: "comfortable", readingPane: "split" });

    clearBrowserStorageIdentity();
    bindBrowserStorageIdentity(20);
    expect(getPrefsSnapshot()).toMatchObject({ density: "compact", readingPane: "full" });

    clearBrowserStorageIdentity();
    bindBrowserStorageIdentity(10);
    expect(getPrefsSnapshot()).toMatchObject({ density: "comfortable", readingPane: "split" });
  });

  test("ignores the old ownerless preference key", () => {
    localStorage.setItem("houzs-mail-prefs:v1", JSON.stringify({ density: "comfortable" }));
    bindBrowserStorageIdentity(30);
    expect(getPrefsSnapshot().density).toBe("compact");
  });

  test("resets after another tab clears localStorage", () => {
    bindBrowserStorageIdentity(40);
    setDensity("comfortable");
    localStorage.clear();
    window.dispatchEvent(new StorageEvent("storage", { key: null, storageArea: localStorage }));
    expect(getPrefsSnapshot().density).toBe("compact");
  });
});
