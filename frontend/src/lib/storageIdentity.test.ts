import { afterEach, describe, expect, it, vi } from "vitest";
import { writeAuthToken } from "./authToken";
import { setActiveCompanyId } from "./activeCompany";
import {
  bindBrowserStorageIdentity,
  clearBrowserStorageIdentity,
  getBrowserStorageIdentity,
  identityStorageKey,
  subscribeBrowserStorageIdentity,
} from "./storageIdentity";

afterEach(() => {
  clearBrowserStorageIdentity();
  localStorage.clear();
  sessionStorage.clear();
  vi.restoreAllMocks();
});

describe("browser storage identity", () => {
  it("binds the authenticated user to the current scoped company", () => {
    writeAuthToken("session-one", true);
    setActiveCompanyId(7);
    bindBrowserStorageIdentity(42);

    expect(getBrowserStorageIdentity()).toEqual({ userId: 42, companyId: 7 });
    expect(identityStorageKey("announcements:localAcks"))
      .toBe("announcements:localAcks:u42:c7");
  });

  it("uses the backend-default bucket when no explicit company is selected", () => {
    writeAuthToken("session-one", true);
    bindBrowserStorageIdentity(42);

    expect(getBrowserStorageIdentity()).toEqual({ userId: 42, companyId: 0 });
  });

  it("notifies scoped stores only when the identity actually changes", () => {
    writeAuthToken("session-one", true);
    const listener = vi.fn();
    const unsubscribe = subscribeBrowserStorageIdentity(listener);

    bindBrowserStorageIdentity(42);
    bindBrowserStorageIdentity(42);
    clearBrowserStorageIdentity();

    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });
});
