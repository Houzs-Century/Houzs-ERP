import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeAuthToken } from "./authToken";
import {
  ACTIVE_COMPANY_BY_USER_KEY,
  ACTIVE_COMPANY_KEY,
  ACTIVE_COMPANY_TAB_KEY,
  adoptActiveCompanyForUser,
  companyHeader,
  consumeCompanyUrlSeed,
  getActiveCompanyId,
  releaseActiveCompanyBinding,
  setActiveCompanyId,
  subscribeActiveCompany,
} from "./activeCompany";

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  releaseActiveCompanyBinding();
});

afterEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  releaseActiveCompanyBinding();
  vi.restoreAllMocks();
});

describe("active company persistence", () => {
  it("SURVIVES A RE-LOGIN — a new token must not silently move the user", () => {
    // The regression this test exists for: the stored key was derived from a
    // hash of the bearer token, so every login minted a new key and the user's
    // company selection vanished while the switcher kept showing a name.
    writeAuthToken("first-session-token", true);
    adoptActiveCompanyForUser(42);
    setActiveCompanyId(7);
    expect(companyHeader()).toEqual({ "X-Company-Id": "7" });

    // Session ends and a brand-new token is issued for the SAME person.
    sessionStorage.clear(); // a new tab: no tab pick to inherit
    releaseActiveCompanyBinding();
    writeAuthToken("second-session-token", true);

    expect(adoptActiveCompanyForUser(42)).toBe(7);
    expect(getActiveCompanyId()).toBe(7);
    expect(companyHeader()).toEqual({ "X-Company-Id": "7" });
  });

  it("keeps the pick across a reload of the same tab", () => {
    adoptActiveCompanyForUser(42);
    setActiveCompanyId(3);
    // A reload keeps sessionStorage but resets module state, so the header is
    // correct on the very first request, before /auth/me resolves.
    releaseActiveCompanyBinding();
    expect(getActiveCompanyId()).toBe(3);
  });

  it("never inherits another user's company", () => {
    adoptActiveCompanyForUser(1);
    setActiveCompanyId(7);

    sessionStorage.clear();
    releaseActiveCompanyBinding();
    expect(adoptActiveCompanyForUser(2)).toBeNull();
    expect(companyHeader()).toEqual({});

    setActiveCompanyId(9);
    expect(getActiveCompanyId()).toBe(9);

    // …and user 1's own record is untouched by user 2's pick.
    sessionStorage.clear();
    releaseActiveCompanyBinding();
    expect(adoptActiveCompanyForUser(1)).toBe(7);
  });

  it("discards a tab pick left behind by a different account", () => {
    sessionStorage.setItem(
      ACTIVE_COMPANY_TAB_KEY,
      JSON.stringify({ user: 1, company: 7 }),
    );
    expect(adoptActiveCompanyForUser(2)).toBeNull();
    expect(sessionStorage.getItem(ACTIVE_COMPANY_TAB_KEY)).toBeNull();
  });

  it("sends no header before /auth/me has said who this tab is", () => {
    localStorage.setItem(
      ACTIVE_COMPANY_BY_USER_KEY,
      JSON.stringify({ u42: 7 }),
    );
    expect(getActiveCompanyId()).toBeNull();
    expect(companyHeader()).toEqual({});
  });

  it("purges the ownerless pre-v2 keys rather than adopting them", () => {
    localStorage.setItem(ACTIVE_COMPANY_KEY, "99");
    localStorage.setItem(`${ACTIVE_COMPANY_KEY}:sometokenhash`, "98");

    expect(adoptActiveCompanyForUser(42)).toBeNull();
    expect(localStorage.getItem(ACTIVE_COMPANY_KEY)).toBeNull();
    expect(localStorage.getItem(`${ACTIVE_COMPANY_KEY}:sometokenhash`)).toBeNull();
    expect(companyHeader()).toEqual({});
  });

  it("claims a pick this tab made before it knew the user id — without moving the durable default", () => {
    setActiveCompanyId(5);
    expect(adoptActiveCompanyForUser(42)).toBe(5);
    // The ?company= window seed lands here as an ownerless pick: claiming it
    // must not rewrite the default every future window boots into.
    expect(localStorage.getItem(ACTIVE_COMPANY_BY_USER_KEY)).toBeNull();
  });

  it("ignores a durable change made by a DIFFERENT user in another tab", () => {
    adoptActiveCompanyForUser(1);
    setActiveCompanyId(7);
    const listener = vi.fn();
    const unsubscribe = subscribeActiveCompany(listener);

    localStorage.setItem(
      ACTIVE_COMPANY_BY_USER_KEY,
      JSON.stringify({ u1: 7, u2: 4 }),
    );
    window.dispatchEvent(new StorageEvent("storage", {
      key: ACTIVE_COMPANY_BY_USER_KEY,
      storageArea: localStorage,
    }));

    expect(listener).not.toHaveBeenCalled();
    expect(getActiveCompanyId()).toBe(7);
    unsubscribe();
  });

  it("KEEPS this window's company when the same user switches in another window", () => {
    // Multi-window (owner ask 2026-07-23): Houzs stays open in this window
    // while another window switches itself to 2990. The durable default moves;
    // this window must not follow it — and must not reload.
    adoptActiveCompanyForUser(1);
    setActiveCompanyId(7);
    const listener = vi.fn();
    const unsubscribe = subscribeActiveCompany(listener);

    localStorage.setItem(ACTIVE_COMPANY_BY_USER_KEY, JSON.stringify({ u1: 4 }));
    window.dispatchEvent(new StorageEvent("storage", {
      key: ACTIVE_COMPANY_BY_USER_KEY,
      storageArea: localStorage,
    }));

    expect(listener).not.toHaveBeenCalled();
    expect(getActiveCompanyId()).toBe(7);
    unsubscribe();
  });

  it("a reload keeps this window's pick without stealing the durable default back", () => {
    // Window A picked Houzs (7), window B later switched the durable default
    // to 2990 (4). Window A reloading must stay on 7 AND leave the default 4 —
    // otherwise every reload of an open window would re-point what a NEW
    // window boots into.
    sessionStorage.setItem(ACTIVE_COMPANY_TAB_KEY, JSON.stringify({ user: 1, company: 7 }));
    localStorage.setItem(ACTIVE_COMPANY_BY_USER_KEY, JSON.stringify({ u1: 4 }));

    expect(adoptActiveCompanyForUser(1)).toBe(7);
    expect(getActiveCompanyId()).toBe(7);
    expect(JSON.parse(localStorage.getItem(ACTIVE_COMPANY_BY_USER_KEY)!)).toEqual({ u1: 4 });
  });

  it("clearing the selection removes the durable record too", () => {
    adoptActiveCompanyForUser(42);
    setActiveCompanyId(7);
    setActiveCompanyId(null);

    expect(companyHeader()).toEqual({});
    expect(JSON.parse(localStorage.getItem(ACTIVE_COMPANY_BY_USER_KEY)!)).toEqual({});
    releaseActiveCompanyBinding();
    sessionStorage.clear();
    expect(adoptActiveCompanyForUser(42)).toBeNull();
  });

  it("rejects a corrupt durable record instead of sending a junk tenant header", () => {
    localStorage.setItem(ACTIVE_COMPANY_BY_USER_KEY, '{"u42":"seven","u1":-3,"nope":9}');
    expect(adoptActiveCompanyForUser(42)).toBeNull();
    expect(companyHeader()).toEqual({});
  });
});

describe("?company= window seed", () => {
  afterEach(() => {
    window.history.replaceState(null, "", "/");
  });

  it("seeds this tab's pick, scrubs the URL, and is claimable on adopt", () => {
    window.history.replaceState(null, "", "/?company=4");
    consumeCompanyUrlSeed();

    // The header is right BEFORE /auth/me resolves — the seed exists so the
    // very first authed request of the new window is already scoped.
    expect(getActiveCompanyId()).toBe(4);
    expect(companyHeader()).toEqual({ "X-Company-Id": "4" });
    expect(window.location.search).toBe("");

    // …and claiming it must not move the durable default for new windows.
    expect(adoptActiveCompanyForUser(42)).toBe(4);
    expect(localStorage.getItem(ACTIVE_COMPANY_BY_USER_KEY)).toBeNull();
  });

  it("preserves the rest of the URL while scrubbing only the seed", () => {
    window.history.replaceState(null, "", "/orders?company=2&q=sofa#row-9");
    consumeCompanyUrlSeed();

    expect(getActiveCompanyId()).toBe(2);
    expect(window.location.pathname).toBe("/orders");
    expect(window.location.search).toBe("?q=sofa");
    expect(window.location.hash).toBe("#row-9");
  });

  it("scrubs but ignores a junk id rather than sending a junk tenant header", () => {
    for (const junk of ["abc", "-3", "0", "1e3", "2.5", ""]) {
      sessionStorage.clear();
      window.history.replaceState(null, "", `/?company=${junk}`);
      consumeCompanyUrlSeed();
      expect(getActiveCompanyId()).toBeNull();
      expect(window.location.search).toBe("");
    }
  });

  it("is a no-op without the parameter", () => {
    window.history.replaceState(null, "", "/orders?q=sofa");
    consumeCompanyUrlSeed();
    expect(getActiveCompanyId()).toBeNull();
    expect(window.location.search).toBe("?q=sofa");
  });
});
