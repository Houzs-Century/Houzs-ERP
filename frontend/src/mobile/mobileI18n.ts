// ============================================================
// Mobile i18n — worker/staff-facing translation layer.
//
// Four supported languages:
//   en — English
//   ms — Bahasa Malaysia
//   zh — 简体中文
//   bn — বাংলা (Bengali, Bangladesh)
//
// PORTED from Hookka's src/lib/worker-i18n.ts. The mechanism is kept
// deliberately identical (hand-rolled flat dictionary + useSyncExternalStore
// over localStorage, no i18next, no ICU) so the two systems stay legible to
// the same reader. The one substantive divergence: Hookka's 4th language is
// Burmese ("my"); Houzs's is Bengali ("bn") per the owner's 2026-07-17 ruling.
// There is no Burmese anywhere in Houzs.
//
// ------------------------------------------------------------
// SCOPE — READ THIS BEFORE ADDING A STRING
// ------------------------------------------------------------
// This project has a standing rule: NO non-English strings in the ADMIN UI.
// Worker/mobile-facing i18n is the documented EXCEPTION, and this file is the
// fence around that exception. Everything translated lives HERE, in the
// resource layer, and is consumed ONLY by mobile (`src/mobile/**`) surfaces.
//
// Do NOT import this module from desktop/admin screens, and do NOT paste
// translated literals into components. Admin UI copy stays English literals in
// the component, exactly as it is today. If that boundary ever needs to move
// it should be an explicit owner decision, not a drive-by import.
//
// There is intentionally NO desktop language switcher: the owner asked for one
// and corrected himself in the same breath ("不对，电脑端不需要，手机端有就行了").
//
// To add a string: pick an id in dot.case, add ONE line with all four
// languages, then call t("my.new.string"). Never add a key with only some
// languages filled in — an English value in every slot is better than a hole.
// ============================================================
import { useCallback, useEffect, useSyncExternalStore } from "react";

export const MOBILE_LANGS = ["en", "ms", "zh", "bn"] as const;
export type MobileLang = (typeof MOBILE_LANGS)[number];

/**
 * WHERE THE PREFERENCE LIVES — localStorage, per DEVICE, not per user row.
 *
 * Chosen over a server-side `users.preferred_lang` column because:
 *  - it must work on the LOGIN screen, before any user identity exists;
 *  - a phone is a personal device here, so per-device == per-user in practice;
 *  - it needs zero network round-trip, so language never flickers on cold load
 *    and never depends on an API that can 500;
 *  - it costs no migration, and migration numbers are contended right now.
 *
 * Consequences, stated honestly: the choice SURVIVES logout/login (it is not
 * cleared with the auth token — a Bengali reader who logs out must not get an
 * English login screen back), and it does NOT follow the user to a second
 * device or a desktop browser. If "follows the user everywhere" is ever
 * wanted, add the column and seed it FROM this value on first login.
 */
const STORAGE_KEY = "houzs.mobile.lang";

const listeners = new Set<() => void>();
let volatileLang: MobileLang | null = null;
function emit() {
  for (const fn of listeners) fn();
}

function isMobileLang(v: unknown): v is MobileLang {
  return (MOBILE_LANGS as readonly unknown[]).includes(v);
}

function readStoredLang(): MobileLang {
  if (volatileLang !== null) return volatileLang;
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (isMobileLang(v)) return v;
    if (v !== null) localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* private mode / storage disabled — fall through to English */
  }
  return volatileLang ?? "en";
}

export function setMobileLang(lang: MobileLang) {
  volatileLang = lang;
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    /* ignore — the in-memory emit below still switches the live session */
  }
  emit();
}

export function useMobileLang(): MobileLang {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    readStoredLang,
    () => "en", // server snapshot
  );
}

/** One-shot read for non-React callers. */
export function getMobileLang(): MobileLang {
  return readStoredLang();
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== null && event.key !== STORAGE_KEY) return;
    volatileLang = null;
    emit();
  });
}

// Display labels for the switcher itself — ALWAYS in each language's own
// native script, so someone who reads only Bengali can find their own row.
export const LANG_LABELS: Record<MobileLang, string> = {
  en: "English",
  ms: "Bahasa Malaysia",
  zh: "中文",
  bn: "বাংলা",
};

// English gloss under each native label, so an English-reading admin helping a
// worker set their phone up can tell the rows apart.
export const LANG_SUBLABELS: Record<MobileLang, string> = {
  en: "English",
  ms: "Malay",
  zh: "Chinese (Simplified)",
  bn: "Bengali (Bangladesh)",
};

type Dict = Record<string, Record<MobileLang, string>>;

// Flat, grep-able dictionary. Kept small on purpose: this PR wires the
// LANGUAGE + ANNOUNCEMENTS surface the owner asked for. Broader mobile
// coverage is a follow-up, and a half-translated screen is worse than an
// honestly English one — so strings land here only when all four are real.
const dict: Dict = {
  // ---- Language screen ----
  "lang.title": {
    en: "Language",
    ms: "Bahasa",
    zh: "语言",
    bn: "ভাষা",
  },
  "lang.hint": {
    en: "Saved on this device. Announcements show in this language when a translation is available.",
    ms: "Disimpan pada peranti ini. Pengumuman dipaparkan dalam bahasa ini apabila terjemahan tersedia.",
    zh: "保存在本设备。有译文时，公告将以此语言显示。",
    bn: "এই ডিভাইসে সংরক্ষিত। অনুবাদ থাকলে ঘোষণা এই ভাষায় দেখানো হবে।",
  },
  "lang.dateNote": {
    en: "Dates and amounts stay in the Malaysia format.",
    ms: "Tarikh dan jumlah kekal dalam format Malaysia.",
    zh: "日期与金额仍使用马来西亚格式。",
    bn: "তারিখ ও পরিমাণ মালয়েশিয়ার বিন্যাসেই থাকবে।",
  },

  // ---- Announcements ----
  "ann.title": {
    en: "Announcements",
    ms: "Pengumuman",
    zh: "公告",
    bn: "ঘোষণা",
  },
  // Shown when the reader is seeing a MACHINE translation rather than what the
  // author actually typed. Non-negotiable: an auto-translated workplace notice
  // must say so.
  "ann.autoTranslated": {
    en: "Auto-translated",
    ms: "Diterjemah automatik",
    zh: "自动翻译",
    bn: "স্বয়ংক্রিয়ভাবে অনূদিত",
  },
  "ann.showOriginal": {
    en: "Show original",
    ms: "Tunjuk asal",
    zh: "查看原文",
    bn: "মূল লেখা দেখুন",
  },
  "ann.showTranslated": {
    en: "Show translation",
    ms: "Tunjuk terjemahan",
    zh: "查看译文",
    bn: "অনুবাদ দেখুন",
  },
  // Shown when the reader picked a language this notice has no translation for
  // and is therefore reading the original as posted.
  "ann.noTranslation": {
    en: "No translation available — showing the original.",
    ms: "Tiada terjemahan — memaparkan teks asal.",
    zh: "暂无译文 —— 显示原文。",
    bn: "কোনো অনুবাদ নেই — মূল লেখা দেখানো হচ্ছে।",
  },
};

/**
 * t("lang.title") → the string in the chosen language.
 *
 * Fallback chain: chosen language → English → the key itself.
 *
 * The key is the LAST resort and only reachable for an id that is not in the
 * dictionary at all, which is a developer bug that should be loud in dev. It
 * is deliberately NOT `?? ""`: this codebase has a documented history of
 * nullish defaults turning "I don't know" into a confident wrong answer, and a
 * blank space where a message belongs is strictly worse than visible English —
 * or, failing that, a visibly wrong-looking key that gets reported.
 */
export function useT() {
  const lang = useMobileLang();
  return useCallback(
    (id: string): string => {
      const row = dict[id];
      if (!row) return id;
      // Note `||` not `??` — an empty-string translation is a HOLE, not a
      // value, and must fall through to English.
      return row[lang] || row.en || id;
    },
    [lang],
  );
}

/**
 * Stamp <html lang> so the browser picks correct font fallbacks, hyphenation
 * and screen-reader voice. This is what makes the `:lang(bn)` rules in
 * mobile.css (Bengali font stack + roomier line-height) apply.
 *
 * All four languages are LTR — Bengali included — so `dir` never changes.
 */
export function useApplyHtmlLang() {
  const lang = useMobileLang();
  useEffect(() => {
    try {
      document.documentElement.setAttribute("lang", lang);
    } catch {
      /* ignore */
    }
  }, [lang]);
}

// ------------------------------------------------------------
// Announcement localisation
// ------------------------------------------------------------

/** One translated pair as stored in `announcements.translations`. `bodyHtml`
 *  exists only for a notice composed with formatting — the translated body
 *  as a canonical rich fragment (lib/announcementRichText.ts). */
export type TranslationPair = { title: string; body: string; bodyHtml?: string };
export type AnnouncementTranslations = Partial<
  Record<MobileLang, TranslationPair | null | undefined>
> | null;

export type LocalizedAnnouncement = {
  title: string;
  body: string;
  /** Rich fragment to render instead of `body`, when the shown version has
   *  one. NEVER the original's html paired with a translated body — a
   *  translation that came back without its tags shows as plain text. */
  bodyHtml: string | null;
  /** True when title/body above came from the stored MACHINE translation. */
  isTranslated: boolean;
  /** True when a translation for the chosen language exists at all. */
  hasTranslation: boolean;
};

/**
 * Resolve an announcement's title/body for the reader's chosen language.
 *
 * Model (see the PR notes): the author writes the notice ONCE in whatever
 * language they type, and the backend machine-translates it into all four on
 * POST, storing them as a JSON blob. There is no four-box compose form.
 *
 * MISSING TRANSLATION → fall back to the ORIGINAL posted text, and report
 * `isTranslated: false` so the caller can label it. It never renders a key and
 * never renders "". A partially-translated row (title translated, body not) is
 * treated as untranslated rather than served half-and-half, because a Bengali
 * headline over an English body reads as a rendering bug.
 *
 * English readers are given the original too, not the `en` slot: when a notice
 * was typed in English the `en` slot is a round-trip of it at best, and when it
 * was typed in another language the author's own words are still the most
 * authoritative thing we have to show.
 */
export function localizeAnnouncement(
  a: {
    title: string;
    body: string;
    bodyHtml?: string | null;
    translations?: AnnouncementTranslations;
  },
  lang: MobileLang,
): LocalizedAnnouncement {
  const original = { title: a.title, body: a.body, bodyHtml: a.bodyHtml ?? null };
  if (lang === "en") {
    return { ...original, isTranslated: false, hasTranslation: false };
  }

  const pair = a.translations?.[lang];
  const title = typeof pair?.title === "string" ? pair.title.trim() : "";
  const body = typeof pair?.body === "string" ? pair.body.trim() : "";

  // A title is required for the row to be usable. An empty BODY is legitimate
  // (plenty of notices are a headline only) — so only demand a translated body
  // when the ORIGINAL had one.
  const bodyOk = a.body.trim() ? Boolean(body) : true;
  if (!title || !bodyOk) {
    return { ...original, isTranslated: false, hasTranslation: false };
  }

  const bodyHtml =
    typeof pair?.bodyHtml === "string" && pair.bodyHtml.trim() ? pair.bodyHtml : null;
  return {
    title,
    body: a.body.trim() ? body : a.body,
    bodyHtml: a.body.trim() ? bodyHtml : null,
    isTranslated: true,
    hasTranslation: true,
  };
}
