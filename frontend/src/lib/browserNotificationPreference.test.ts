import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { writeAuthToken } from "./authToken";
import { setActiveCompanyId } from "./activeCompany";
import {
  getBrowserNotificationPreference,
  requestBrowserNotificationPermission,
  setBrowserNotificationPreference,
  subscribeBrowserNotificationPreference,
  useBrowserNotificationPreference,
  useBrowserNotificationPermission,
} from "./browserNotificationPreference";
import {
  bindBrowserStorageIdentity,
  clearBrowserStorageIdentity,
  identityStorageKey,
} from "./storageIdentity";

beforeEach(() => {
  clearBrowserStorageIdentity();
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  clearBrowserStorageIdentity();
  localStorage.clear();
  sessionStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("browser notification preference", () => {
  it("does not read or consume any ownerless value before identity is bound", () => {
    localStorage.setItem("notifications:browserPush", "1");

    expect(getBrowserNotificationPreference()).toBe(false);
    expect(localStorage.getItem("notifications:browserPush")).toBe("1");
  });

  it("discards the ownerless desktop key instead of assigning it to the next login", () => {
    localStorage.setItem("notifications:browserPush", "1");
    bindBrowserStorageIdentity(101);

    expect(getBrowserNotificationPreference()).toBe(false);
    expect(localStorage.getItem("notifications:browserPush:u101:c0")).toBeNull();
    expect(localStorage.getItem("notifications:browserPush")).toBeNull();

    clearBrowserStorageIdentity();
    bindBrowserStorageIdentity(102);
    expect(getBrowserNotificationPreference()).toBe(false);
  });

  it("keeps choices separate by user and active company", () => {
    writeAuthToken("notifications-company-session", true);
    setActiveCompanyId(7);
    bindBrowserStorageIdentity(201);
    setBrowserNotificationPreference(true);
    expect(localStorage.getItem("notifications:browserPush:u201:c7")).toBe("1");

    clearBrowserStorageIdentity();
    setActiveCompanyId(8);
    bindBrowserStorageIdentity(201);
    expect(getBrowserNotificationPreference()).toBe(false);
    setBrowserNotificationPreference(false);

    clearBrowserStorageIdentity();
    setActiveCompanyId(7);
    bindBrowserStorageIdentity(201);
    expect(getBrowserNotificationPreference()).toBe(true);
  });

  it("never inherits the ownerless mobile category keys", () => {
    localStorage.setItem("hz_notif_push", "1");
    localStorage.setItem("hz_notif_sla", "1");
    bindBrowserStorageIdentity(301);

    expect(getBrowserNotificationPreference()).toBe(false);
    expect(localStorage.getItem("hz_notif_push")).toBe("1");
    expect(localStorage.getItem("hz_notif_sla")).toBe("1");
  });

  it("notifies same-tab writes and matching cross-tab storage events", () => {
    bindBrowserStorageIdentity(401);
    const listener = vi.fn();
    const unsubscribe = subscribeBrowserNotificationPreference(listener);

    setBrowserNotificationPreference(true);
    expect(listener).toHaveBeenCalledTimes(1);

    const key = identityStorageKey("notifications:browserPush");
    localStorage.setItem(key!, "0");
    window.dispatchEvent(new StorageEvent("storage", {
      key,
      oldValue: "1",
      newValue: "0",
      storageArea: localStorage,
    }));
    expect(listener).toHaveBeenCalledTimes(2);
    expect(getBrowserNotificationPreference()).toBe(false);

    window.dispatchEvent(new StorageEvent("storage", {
      key: "notifications:browserPush:u999:c0",
      oldValue: "0",
      newValue: "1",
      storageArea: localStorage,
    }));
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it("updates React consumers for desktop/mobile in the same tab and other tabs", () => {
    bindBrowserStorageIdentity(501);
    const { result, unmount } = renderHook(() => useBrowserNotificationPreference());
    expect(result.current).toBe(false);

    act(() => setBrowserNotificationPreference(true));
    expect(result.current).toBe(true);

    const key = identityStorageKey("notifications:browserPush");
    act(() => {
      localStorage.setItem(key!, "0");
      window.dispatchEvent(new StorageEvent("storage", {
        key,
        oldValue: "1",
        newValue: "0",
        storageArea: localStorage,
      }));
    });
    expect(result.current).toBe(false);
    unmount();
  });

  it("turns off the current identity after another tab clears storage", () => {
    bindBrowserStorageIdentity(502);
    setBrowserNotificationPreference(true);
    expect(getBrowserNotificationPreference()).toBe(true);

    localStorage.clear();
    window.dispatchEvent(new StorageEvent("storage", {
      key: null,
      oldValue: null,
      newValue: null,
      storageArea: localStorage,
    }));

    expect(getBrowserNotificationPreference()).toBe(false);
  });

  it("refreshes permission consumers when a browser prompt is denied", async () => {
    const notification = {
      permission: "default" as NotificationPermission,
      requestPermission: vi.fn(async () => {
        notification.permission = "denied";
        return "denied" as NotificationPermission;
      }),
    };
    vi.stubGlobal("Notification", notification);

    const { result, unmount } = renderHook(() => useBrowserNotificationPermission());
    expect(result.current).toBe("default");

    await act(async () => {
      expect(await requestBrowserNotificationPermission()).toBe("denied");
    });
    expect(result.current).toBe("denied");
    unmount();
  });
});
