import { afterEach, describe, expect, test, vi } from "vitest";
import { writeAuthToken } from "../../lib/authToken";
import { setActiveCompanyId } from "../../lib/activeCompany";
import {
  bindBrowserStorageIdentity,
  clearBrowserStorageIdentity,
} from "../../lib/storageIdentity";
import {
  getSnapshot,
  hasQuarantinedLegacyDrafts,
  deleteDraft,
  deleteDraftBestEffort,
  MAIL_DRAFT_MAX_BYTES,
  MAIL_DRAFT_MAX_COUNT,
  sanitizeDrafts,
  saveDraft,
} from "./mail-local";

/* WHY THIS TEST EXISTS.
   Compose drafts live in localStorage, which means the app reads back JSON that
   an older build wrote, that a user may have hand-edited, and that no server
   ever validated. `load()` used to check only that `drafts` was an array and
   then trust every element. One element missing `updatedAt` crashed the entire
   Mail Center: the Drafts list rendered it through
   `new Date(d.updatedAt).toISOString()`, and `toISOString()` on an invalid date
   THROWS rather than returning something falsy, so React unmounted the tree.

   HOOKKA hit both halves of this separately — a shared localStorage key written
   in two incompatible shapes (BUG-2026-04-22-001) and toISOString on an
   undefined field (BUG-2026-05-12-008). The lesson worth keeping is that the
   container check and the element check are different checks. */

const VALID = {
  id: "d1",
  to: "a@b.com",
  subject: "Quote",
  body: "text",
  fromAddress: "me@houzs.com",
  updatedAt: 1_700_000_000_000,
};

afterEach(() => {
  clearBrowserStorageIdentity();
  localStorage.clear();
  sessionStorage.clear();
  vi.restoreAllMocks();
});

describe("sanitizeDrafts", () => {
  test("a well-formed draft survives untouched", () => {
    expect(sanitizeDrafts([VALID])).toEqual([VALID]);
  });

  test("a non-array (null, object, string, absent) yields no drafts, never throws", () => {
    for (const bad of [null, undefined, {}, "", "[]", 7]) {
      expect(sanitizeDrafts(bad)).toEqual([]);
    }
  });

  test("a draft missing updatedAt is kept but its timestamp is neutralised", () => {
    // THE CRASH CASE. Pre-fix this element reached the renderer verbatim and
    // `new Date(undefined).toISOString()` threw RangeError. 0 is falsy, so the
    // formatter's own `if (!iso) return ""` short-circuits and renders blank.
    const { updatedAt: _omitted, ...noStamp } = VALID;
    const out = sanitizeDrafts([noStamp]);
    expect(out).toHaveLength(1);
    expect(out[0].updatedAt).toBe(0);
    // The guarantee that matters: whatever comes out is safe to date-format.
    expect(() => new Date(out[0].updatedAt).toISOString()).not.toThrow();
  });

  test("a non-numeric or non-finite updatedAt is neutralised the same way", () => {
    for (const bad of ["2026-07-19", NaN, Infinity, null, {}]) {
      const out = sanitizeDrafts([{ ...VALID, updatedAt: bad }]);
      expect(out[0].updatedAt).toBe(0);
      expect(() => new Date(out[0].updatedAt).toISOString()).not.toThrow();
    }
  });

  test("missing text fields degrade to empty strings rather than dropping the draft", () => {
    // A draft written by an older build that lacked a field is still resumable;
    // losing the user's body text would be a worse outcome than a blank subject.
    const out = sanitizeDrafts([{ id: "d1", updatedAt: 1 }]);
    expect(out).toEqual([{ id: "d1", to: "", subject: "", body: "", fromAddress: "", updatedAt: 1 }]);
  });

  test("an entry with no usable id IS dropped — it could never be resumed or deleted", () => {
    // id keys saveDraft/deleteDraft. Keeping an id-less row would render a
    // draft whose Discard button silently does nothing.
    expect(sanitizeDrafts([{ ...VALID, id: undefined }])).toEqual([]);
    expect(sanitizeDrafts([{ ...VALID, id: "" }])).toEqual([]);
    expect(sanitizeDrafts([{ ...VALID, id: 42 }])).toEqual([]);
  });

  test("one malformed element does not take the readable ones down with it", () => {
    // The whole point: partial recovery beats an all-or-nothing crash.
    const out = sanitizeDrafts([VALID, null, "junk", { ...VALID, id: "d2" }]);
    expect(out.map((d) => d.id)).toEqual(["d1", "d2"]);
  });
});

describe("mail draft browser scope", () => {
  test("does not hydrate an ownerless v1 draft into the next login", () => {
    localStorage.setItem("houzs-mail-local:v1", JSON.stringify({ drafts: [VALID] }));
    writeAuthToken("user-one", true);
    bindBrowserStorageIdentity(1);

    expect(hasQuarantinedLegacyDrafts()).toBe(true);
    expect(getSnapshot().drafts).toEqual([]);
    expect(localStorage.getItem("houzs-mail-local:v1")).not.toBeNull();
  });

  test("separates drafts by stable user and active company", () => {
    writeAuthToken("user-one", true);
    // Explicit switcher picks happen SIGNED IN (and reload → re-bind). Only an
    // explicit pick updates the durable per-user default — an ownerless
    // pre-bind pick (the ?company= window seed) deliberately does not, so it
    // could not power the user-1 restore this test asserts below.
    bindBrowserStorageIdentity(1);
    setActiveCompanyId(7);
    bindBrowserStorageIdentity(1);
    saveDraft(VALID);
    expect(getSnapshot().drafts.map((draft) => draft.id)).toEqual(["d1"]);

    bindBrowserStorageIdentity(2);
    expect(getSnapshot().drafts).toEqual([]);
    saveDraft({ ...VALID, id: "d2" });

    bindBrowserStorageIdentity(1);
    expect(getSnapshot().drafts.map((draft) => draft.id)).toEqual(["d1"]);

    setActiveCompanyId(8);
    bindBrowserStorageIdentity(1);
    expect(getSnapshot().drafts).toEqual([]);
  });

  test("does not claim a persistent save while identity is unresolved", () => {
    expect(() => saveDraft(VALID)).toThrow(/not ready/i);
    expect(getSnapshot().drafts).toEqual([]);
    expect(Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)))
      .not.toContain(expect.stringContaining("houzs-mail-local:v2"));
  });

  test("merges a newer cross-tab draft before save or delete", () => {
    writeAuthToken("user-one", true);
    bindBrowserStorageIdentity(1);
    saveDraft(VALID);
    const key = "houzs-mail-local:v2:u1:c0";
    const otherTab = { ...VALID, id: "d2", subject: "Saved elsewhere" };
    localStorage.setItem(key, JSON.stringify({ drafts: [otherTab, VALID] }));

    saveDraft({ ...VALID, id: "d3", subject: "This tab" });
    expect(getSnapshot().drafts.map((draft) => draft.id)).toEqual(["d3", "d2", "d1"]);

    localStorage.setItem(key, JSON.stringify({ drafts: [
      { ...VALID, id: "d4", subject: "Another new tab draft" },
      ...getSnapshot().drafts,
    ] }));
    deleteDraft("d1");
    expect(getSnapshot().drafts.map((draft) => draft.id)).toEqual(["d4", "d3", "d2"]);
  });

  test("does not claim a draft was saved when localStorage rejects the write", () => {
    writeAuthToken("user-one", true);
    bindBrowserStorageIdentity(1);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });

    expect(() => saveDraft(VALID)).toThrow(/could not be saved/i);
    expect(getSnapshot().drafts).toEqual([]);
  });

  test("does not claim an explicit discard succeeded when persistence fails", () => {
    writeAuthToken("user-one", true);
    bindBrowserStorageIdentity(1);
    saveDraft(VALID);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });

    expect(() => deleteDraft(VALID.id)).toThrow(/could not be saved/i);
    expect(getSnapshot().drafts).toEqual([VALID]);
  });

  test("post-send cleanup is best effort and keeps an undeleted draft visible", () => {
    writeAuthToken("user-one", true);
    bindBrowserStorageIdentity(1);
    saveDraft(VALID);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });

    expect(() => deleteDraftBestEffort(VALID.id)).not.toThrow();
    expect(getSnapshot().drafts).toEqual([VALID]);
  });

  test("bounds draft count without deleting an older draft silently", () => {
    writeAuthToken("user-one", true);
    bindBrowserStorageIdentity(1);
    for (let index = 0; index < MAIL_DRAFT_MAX_COUNT; index += 1) {
      saveDraft({ ...VALID, id: `d${index}` });
    }

    expect(() => saveDraft({ ...VALID, id: "overflow" })).toThrow(/100 drafts/i);
    expect(getSnapshot().drafts).toHaveLength(MAIL_DRAFT_MAX_COUNT);
    expect(getSnapshot().drafts.some((draft) => draft.id === "overflow")).toBe(false);
  });

  test("rejects an oversized draft and preserves the prior saved state", () => {
    writeAuthToken("user-one", true);
    bindBrowserStorageIdentity(1);
    saveDraft(VALID);

    expect(() => saveDraft({
      ...VALID,
      id: "huge",
      body: "x".repeat(MAIL_DRAFT_MAX_BYTES),
    })).toThrow(/too large/i);
    expect(getSnapshot().drafts).toEqual([VALID]);
  });

  test("clears the live snapshot after another tab clears storage", () => {
    writeAuthToken("user-one", true);
    bindBrowserStorageIdentity(1);
    saveDraft(VALID);
    localStorage.clear();
    window.dispatchEvent(new StorageEvent("storage", { key: null, storageArea: localStorage }));
    expect(getSnapshot().drafts).toEqual([]);
  });
});
