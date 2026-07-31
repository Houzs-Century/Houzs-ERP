import { describe, it, expect } from "vitest";
import {
  avatarCacheControl,
  AVATAR_CACHE_VERSIONED,
  AVATAR_CACHE_UNVERSIONED,
} from "../src/lib/avatar-cache";

/* The year-long TTL on GET /api/users/:id/profile-pic is only sound because the
   request URL names exactly one object. These pin the cases where it does NOT,
   because that is the direction that would serve a staff member the wrong face
   for a year. */

const KEY = "user/7/1754006400000-me.png";
const NEWER = "user/7/1754092800000-me.png";

describe("avatarCacheControl", () => {
  it("pins the response only when ?k matches the CURRENT key", () => {
    expect(avatarCacheControl(KEY, KEY)).toBe(AVATAR_CACHE_VERSIONED);
  });

  it("does NOT pin a stale ?k — that url does not name the bytes being returned", () => {
    // A client holding a user list from before an upload asks for the old key
    // while the row already points at the new one. Pinning here would freeze
    // the NEW image under the OLD url for a year.
    expect(avatarCacheControl(KEY, NEWER)).toBe(AVATAR_CACHE_UNVERSIONED);
  });

  it("does NOT pin when ?k is absent", () => {
    // Avatar.tsx omits ?k when handed a boolean marker instead of the key.
    expect(avatarCacheControl(undefined, KEY)).toBe(AVATAR_CACHE_UNVERSIONED);
    expect(avatarCacheControl(null, KEY)).toBe(AVATAR_CACHE_UNVERSIONED);
    expect(avatarCacheControl("", KEY)).toBe(AVATAR_CACHE_UNVERSIONED);
  });

  it("never pins when the row carries no key, even against an empty query", () => {
    // Two absent values must not compare equal into the immutable branch.
    expect(avatarCacheControl(undefined, undefined)).toBe(AVATAR_CACHE_UNVERSIONED);
    expect(avatarCacheControl("", "")).toBe(AVATAR_CACHE_UNVERSIONED);
    expect(avatarCacheControl(null, null)).toBe(AVATAR_CACHE_UNVERSIONED);
  });

  it("a replaced avatar changes the url, which is what makes pinning safe", () => {
    // Same user, new upload: the component now requests NEWER, which is a
    // different url and therefore a cache miss. The pinned KEY entry is never
    // asked for again.
    expect(avatarCacheControl(NEWER, NEWER)).toBe(AVATAR_CACHE_VERSIONED);
    expect(KEY).not.toBe(NEWER);
  });
});
