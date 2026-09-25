import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getMobileLang,
  LANG_LABELS,
  LANG_SUBLABELS,
  MOBILE_LANGS,
  localizeAnnouncement,
  setMobileLang,
  type MobileLang,
  useMobileLang,
} from "./mobileI18n";

afterEach(() => {
  localStorage.clear();
  window.dispatchEvent(new StorageEvent("storage", { key: null, storageArea: localStorage }));
  vi.restoreAllMocks();
});

describe("mobile language preference", () => {
  it("updates live consumers when another tab changes or clears the language", () => {
    const { result, unmount } = renderHook(() => useMobileLang());
    act(() => setMobileLang("bn"));
    expect(result.current).toBe("bn");

    act(() => {
      localStorage.setItem("houzs.mobile.lang", "zh");
      window.dispatchEvent(new StorageEvent("storage", {
        key: "houzs.mobile.lang",
        oldValue: "bn",
        newValue: "zh",
        storageArea: localStorage,
      }));
    });
    expect(result.current).toBe("zh");

    act(() => {
      localStorage.clear();
      window.dispatchEvent(new StorageEvent("storage", { key: null, storageArea: localStorage }));
    });
    expect(result.current).toBe("en");
    unmount();
  });

  it("keeps the live tab language when persistent storage is unavailable", () => {
    localStorage.setItem("houzs.mobile.lang", "zh");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("blocked", "QuotaExceededError");
    });
    setMobileLang("ms");
    expect(getMobileLang()).toBe("ms");
  });

  it("removes unsupported stored values", () => {
    localStorage.setItem("houzs.mobile.lang", "my");
    expect(getMobileLang()).toBe("en");
    expect(localStorage.getItem("houzs.mobile.lang")).toBeNull();
  });
});

describe("MOBILE_LANGS", () => {
  it("is exactly English, Malay, Chinese, Bengali", () => {
    expect([...MOBILE_LANGS]).toEqual(["en", "ms", "zh", "bn"]);
  });

  // Guard the owner's 2026-07-17 ruling: Hookka's 4th language is Burmese,
  // Houzs's is Bengali. A copy-paste from the Hookka portal would reintroduce
  // "my" — fail loudly if it ever does.
  it("has no Burmese anywhere", () => {
    expect(MOBILE_LANGS as readonly string[]).not.toContain("my");
  });

  it("labels every language in its own script, with an English gloss", () => {
    for (const l of MOBILE_LANGS) {
      expect(LANG_LABELS[l]).toBeTruthy();
      expect(LANG_SUBLABELS[l]).toBeTruthy();
    }
    expect(LANG_LABELS.bn).toBe("বাংলা");
    expect(LANG_SUBLABELS.bn).toBe("Bengali (Bangladesh)");
  });
});

describe("localizeAnnouncement", () => {
  const base = { title: "Holiday notice", body: "Office closed 2026/08/05." };
  const bnPair = { title: "ছুটির বিজ্ঞপ্তি", body: "অফিস বন্ধ ২০২৬/০৮/০৫।" };

  it("returns the Bengali translation when one exists", () => {
    const r = localizeAnnouncement({ ...base, translations: { bn: bnPair } }, "bn");
    expect(r.title).toBe(bnPair.title);
    expect(r.body).toBe(bnPair.body);
    expect(r.isTranslated).toBe(true);
  });

  // The core promise: a reader NEVER sees a blank, and never sees a key.
  it("falls back to the original when the chosen language is missing", () => {
    for (const t of [undefined, null, {}, { zh: { title: "x", body: "y" } }]) {
      const r = localizeAnnouncement({ ...base, translations: t as never }, "bn");
      expect(r.title).toBe(base.title);
      expect(r.body).toBe(base.body);
      expect(r.isTranslated).toBe(false);
    }
  });

  // Rows written while the 4th language was still Burmese carry a "my" key and
  // no "bn". They must degrade to the original, not to Burmese and not to "".
  it("ignores a legacy Burmese blob rather than showing it", () => {
    const legacy = { translations: { my: { title: "မြန်မာ", body: "စာ" } } as never };
    const r = localizeAnnouncement({ ...base, ...legacy }, "bn");
    expect(r.title).toBe(base.title);
    expect(r.isTranslated).toBe(false);
  });

  it("never yields an empty string for a non-empty original", () => {
    const blanks = [
      { bn: { title: "", body: "" } },
      { bn: { title: "   ", body: "   " } },
      { bn: { title: bnPair.title, body: "" } }, // half-translated
    ];
    for (const t of blanks) {
      const r = localizeAnnouncement({ ...base, translations: t }, "bn");
      expect(r.title.trim()).not.toBe("");
      expect(r.body.trim()).not.toBe("");
      expect(r.isTranslated).toBe(false);
    }
  });

  // A headline-only notice is legitimate; demanding a translated body would
  // wrongly mark those as untranslated forever.
  it("accepts a translated title when the original body is empty", () => {
    const r = localizeAnnouncement(
      { title: base.title, body: "", translations: { bn: { title: bnPair.title, body: "" } } },
      "bn",
    );
    expect(r.title).toBe(bnPair.title);
    expect(r.isTranslated).toBe(true);
  });

  it("gives English readers the author's original text", () => {
    const r = localizeAnnouncement(
      { ...base, translations: { en: { title: "Round-tripped", body: "Round-tripped" } } },
      "en",
    );
    expect(r.title).toBe(base.title);
    expect(r.isTranslated).toBe(false);
  });

  it("resolves every supported language without throwing", () => {
    for (const l of MOBILE_LANGS as readonly MobileLang[]) {
      expect(() => localizeAnnouncement(base, l)).not.toThrow();
      expect(localizeAnnouncement(base, l).title).toBe(base.title);
    }
  });
});
