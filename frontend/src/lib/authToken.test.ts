import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AUTH_TOKEN_KEY,
  authSessionFingerprint,
  clearAuthToken,
  readAuthToken,
  subscribeAuthTokenChange,
  writeAuthToken,
} from "./authToken";

afterEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.restoreAllMocks();
});

describe("auth token tab isolation", () => {
  it("keeps a tab-only session ahead of another tab's remembered token", () => {
    localStorage.setItem(AUTH_TOKEN_KEY, "remembered-user");
    writeAuthToken("tab-user", false);

    expect(readAuthToken()).toBe("tab-user");
    expect(localStorage.getItem(AUTH_TOKEN_KEY)).toBe("remembered-user");

    localStorage.setItem(AUTH_TOKEN_KEY, "other-tab-user");
    window.dispatchEvent(new StorageEvent("storage", {
      key: AUTH_TOKEN_KEY,
      oldValue: "remembered-user",
      newValue: "other-tab-user",
      storageArea: localStorage,
    }));

    expect(readAuthToken()).toBe("tab-user");
  });

  it("does not fall through to a different remembered user after tab logout", () => {
    localStorage.setItem(AUTH_TOKEN_KEY, "remembered-user");
    writeAuthToken("tab-user", false);

    clearAuthToken();

    expect(readAuthToken()).toBe("");
    expect(localStorage.getItem(AUTH_TOKEN_KEY)).toBe("remembered-user");
  });

  it("clears the tab suppression marker on the next remembered login", () => {
    localStorage.setItem(AUTH_TOKEN_KEY, "remembered-user");
    writeAuthToken("tab-user", false);
    clearAuthToken();

    writeAuthToken("next-remembered-user", true);

    expect(readAuthToken()).toBe("next-remembered-user");
    expect(sessionStorage.getItem(AUTH_TOKEN_KEY)).toBeNull();
  });

  it("notifies only when a storage event changes this tab's effective identity", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeAuthTokenChange(listener);
    writeAuthToken("tab-user", false);
    listener.mockClear();

    localStorage.setItem(AUTH_TOKEN_KEY, "other-tab-user");
    window.dispatchEvent(new StorageEvent("storage", {
      key: AUTH_TOKEN_KEY,
      oldValue: null,
      newValue: "other-tab-user",
      storageArea: localStorage,
    }));
    expect(listener).not.toHaveBeenCalled();

    sessionStorage.clear();
    window.dispatchEvent(new StorageEvent("storage", {
      key: AUTH_TOKEN_KEY,
      oldValue: "other-tab-user",
      newValue: "remembered-third-user",
      storageArea: localStorage,
    }));
    expect(listener).toHaveBeenCalledWith("other-tab-user", "storage");
    unsubscribe();
  });

  it("uses a stable non-secret storage bucket and none while signed out", () => {
    expect(authSessionFingerprint()).toBe("");
    writeAuthToken("same-session", true);
    const first = authSessionFingerprint();
    expect(first).not.toBe("");
    expect(first).not.toContain("same-session");
    expect(authSessionFingerprint()).toBe(first);
  });
});
