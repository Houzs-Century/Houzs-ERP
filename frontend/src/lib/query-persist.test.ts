import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AUTH_TOKEN_KEY, writeAuthToken } from "./authToken";
import {
  ACTIVE_COMPANY_BY_USER_KEY,
  adoptActiveCompanyForUser,
  getActiveCompanyId,
  releaseActiveCompanyBinding,
  setActiveCompanyId,
} from "./activeCompany";
import { installQueryPersist } from "./query-persist";

const originalRequestIdle = Object.getOwnPropertyDescriptor(window, "requestIdleCallback");
const originalCancelIdle = Object.getOwnPropertyDescriptor(window, "cancelIdleCallback");
const originalVisibilityState = Object.getOwnPropertyDescriptor(document, "visibilityState");
let disposePersist: (() => void) | undefined;

function install(qc: QueryClient): void {
  disposePersist = installQueryPersist(qc);
}

function snapshotKeys(): string[] {
  return Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
    .filter((key): key is string => key?.startsWith("houzs-rq-snapshot:") === true);
}

afterEach(() => {
  disposePersist?.();
  disposePersist = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  releaseActiveCompanyBinding();
  if (originalRequestIdle) Object.defineProperty(window, "requestIdleCallback", originalRequestIdle);
  else delete (window as { requestIdleCallback?: Window["requestIdleCallback"] }).requestIdleCallback;
  if (originalCancelIdle) Object.defineProperty(window, "cancelIdleCallback", originalCancelIdle);
  else delete (window as { cancelIdleCallback?: Window["cancelIdleCallback"] }).cancelIdleCallback;
  if (originalVisibilityState) Object.defineProperty(document, "visibilityState", originalVisibilityState);
});

describe("query snapshot scheduling", () => {
  it("defers the large stringify/write until the browser is idle", () => {
    vi.useFakeTimers();
    localStorage.setItem(AUTH_TOKEN_KEY, "session-token");
    setActiveCompanyId(7);
    const idleCallbacks: IdleRequestCallback[] = [];
    Object.defineProperty(window, "requestIdleCallback", {
      configurable: true,
      value: vi.fn((callback: IdleRequestCallback) => {
        idleCallbacks.push(callback);
        return idleCallbacks.length;
      }),
    });
    Object.defineProperty(window, "cancelIdleCallback", {
      configurable: true,
      value: vi.fn(),
    });
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const qc = new QueryClient();
    install(qc);
    setItem.mockClear();

    qc.setQueryData(["mfg-sales-orders", "all"], [{ id: "SO-1" }]);
    vi.advanceTimersByTime(1_200);

    expect(idleCallbacks).toHaveLength(1);
    expect(setItem.mock.calls.some(([key]) => String(key).startsWith("houzs-rq-snapshot:"))).toBe(false);

    idleCallbacks[0]({ didTimeout: false, timeRemaining: () => 10 });
    expect(setItem.mock.calls.some(([key]) => String(key).startsWith("houzs-rq-snapshot:"))).toBe(true);
  });

  it.each(["pagehide", "visibilitychange"] as const)(
    "does not flush the old company cache into the new company on %s",
    (eventName) => {
      vi.useFakeTimers();
      localStorage.setItem(AUTH_TOKEN_KEY, "company-switch-session");
      setActiveCompanyId(7);
      const qc = new QueryClient();
      install(qc);
      qc.setQueryData(["mfg-sales-orders", "all"], [{ id: "OLD-COMPANY-SO" }]);

      // TopNavbar writes the next company immediately before reload. This old
      // page's flush must not relabel its cache as company 8 data.
      setActiveCompanyId(8);
      if (eventName === "visibilitychange") {
        Object.defineProperty(document, "visibilityState", {
          configurable: true,
          value: "hidden",
        });
      }
      window.dispatchEvent(new Event(eventName));

      expect(snapshotKeys().some((key) => key.endsWith(":8"))).toBe(false);
      expect(
        snapshotKeys().some((key) =>
          localStorage.getItem(key)?.includes("OLD-COMPANY-SO"),
        ),
      ).toBe(false);
    },
  );

  it("binds a QueryClient installed signed out to an explicit SPA login", () => {
    vi.useFakeTimers();
    const idleCallbacks: IdleRequestCallback[] = [];
    Object.defineProperty(window, "requestIdleCallback", {
      configurable: true,
      value: vi.fn((callback: IdleRequestCallback) => {
        idleCallbacks.push(callback);
        return idleCallbacks.length;
      }),
    });
    Object.defineProperty(window, "cancelIdleCallback", {
      configurable: true,
      value: vi.fn(),
    });
    const qc = new QueryClient();
    install(qc);

    writeAuthToken("fresh-spa-session", true);
    qc.setQueryData(["mfg-sales-orders", "all"], [{ id: "NEW-SESSION-SO" }]);
    vi.advanceTimersByTime(1_200);
    expect(idleCallbacks).toHaveLength(1);
    idleCallbacks[0]({ didTimeout: false, timeRemaining: () => 10 });

    const key = snapshotKeys().find((candidate) => candidate.endsWith(":0"));
    expect(key).toBeTruthy();
    expect(localStorage.getItem(key!)).toContain("NEW-SESSION-SO");
  });

  it("reinstalling disposes the old cache and global listener wiring", () => {
    vi.useFakeTimers();
    localStorage.setItem(AUTH_TOKEN_KEY, "session-token");
    setActiveCompanyId(7);
    const removeEventListener = vi.spyOn(window, "removeEventListener");
    const oldClient = new QueryClient();
    const oldDispose = installQueryPersist(oldClient);
    const nextClient = new QueryClient();
    disposePersist = installQueryPersist(nextClient);

    expect(removeEventListener.mock.calls.some(([type]) => type === "pagehide")).toBe(true);
    expect(removeEventListener.mock.calls.some(([type]) => type === "visibilitychange")).toBe(true);

    oldClient.setQueryData(["mfg-sales-orders", "all"], [{ id: "OLD-WIRING-SO" }]);
    nextClient.setQueryData(["mfg-sales-orders", "all"], [{ id: "CURRENT-WIRING-SO" }]);
    window.dispatchEvent(new Event("pagehide"));

    const values = snapshotKeys().map((key) => localStorage.getItem(key) ?? "").join("\n");
    expect(values).toContain("CURRENT-WIRING-SO");
    expect(values).not.toContain("OLD-WIRING-SO");
    expect(() => oldDispose()).not.toThrow();
  });

  it("waits for the tenant instead of hydrating another company's snapshot", () => {
    vi.useFakeTimers();
    localStorage.setItem(AUTH_TOKEN_KEY, "cold-open-session");

    // Step 1: this same session, with NO company selected, writes a snapshot
    // into the hostname-default bucket.
    const seed = new QueryClient();
    const disposeSeed = installQueryPersist(seed);
    seed.setQueryData(["mfg-sales-orders", "all"], [{ id: "DEFAULT-COMPANY-SO" }]);
    window.dispatchEvent(new Event("pagehide"));
    disposeSeed();
    const defaultKey = snapshotKeys().find((key) => key.endsWith(":0"));
    expect(defaultKey).toBeTruthy();

    // Step 2: a cold open in a NEW tab. Somebody on this browser has picked a
    // company, so a null active company means "not resolved yet", not
    // "single-company install" — the default bucket must not be painted in.
    localStorage.setItem(ACTIVE_COMPANY_BY_USER_KEY, JSON.stringify({ u42: 7 }));
    sessionStorage.clear();
    releaseActiveCompanyBinding();

    const qc = new QueryClient();
    install(qc);
    expect(qc.getQueryData(["mfg-sales-orders", "all"])).toBeUndefined();

    // Step 3: /auth/me lands, the tab adopts user 42's company, and everything
    // it now writes belongs to company 7.
    adoptActiveCompanyForUser(42);
    expect(getActiveCompanyId()).toBe(7);
    expect(qc.getQueryData(["mfg-sales-orders", "all"])).toBeUndefined();
    qc.setQueryData(["mfg-sales-orders", "all"], [{ id: "COMPANY-7-SO" }]);
    window.dispatchEvent(new Event("pagehide"));

    const companyKey = snapshotKeys().find((key) => key.endsWith(":7"));
    expect(companyKey).toBeTruthy();
    expect(localStorage.getItem(companyKey!)).toContain("COMPANY-7-SO");
    expect(localStorage.getItem(companyKey!)).not.toContain("DEFAULT-COMPANY-SO");
  });

  it("drops old list rows when another tab replaces the remembered session", () => {
    vi.useFakeTimers();
    localStorage.setItem(AUTH_TOKEN_KEY, "first-session");
    setActiveCompanyId(7);
    const qc = new QueryClient();
    install(qc);
    qc.setQueryData(["mfg-sales-orders", "all"], [{ id: "FIRST-USER-SO" }]);
    expect(qc.getQueryData(["mfg-sales-orders", "all"])).toBeTruthy();

    localStorage.setItem(AUTH_TOKEN_KEY, "second-session");
    window.dispatchEvent(new StorageEvent("storage", {
      key: AUTH_TOKEN_KEY,
      oldValue: "first-session",
      newValue: "second-session",
      storageArea: localStorage,
    }));

    expect(qc.getQueryData(["mfg-sales-orders", "all"])).toBeUndefined();
    qc.setQueryData(["mfg-sales-orders", "all"], [{ id: "SECOND-USER-SO" }]);
    window.dispatchEvent(new Event("pagehide"));
    const values = snapshotKeys().map((key) => localStorage.getItem(key) ?? "").join("\n");
    expect(values).toContain("SECOND-USER-SO");
    expect(values).not.toContain("FIRST-USER-SO");
  });
});

describe("paged list snapshots (HC-0002)", () => {
  function flushNow(qc: QueryClient): Record<string, unknown> {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    window.dispatchEvent(new Event("visibilitychange"));
    const key = snapshotKeys()[0];
    return key ? (JSON.parse(localStorage.getItem(key) ?? "{}") as Record<string, unknown>) : {};
  }

  it("keeps the first page of a V2 list and leaves later pages out", () => {
    localStorage.setItem(AUTH_TOKEN_KEY, "paged-session");
    setActiveCompanyId(7);
    const qc = new QueryClient();
    install(qc);
    qc.setQueryData(["mfg-sales-orders-paged", 0, 50, "", "", ""], { salesOrders: [{ doc_no: "SO-P0" }] });
    qc.setQueryData(["mfg-sales-orders-paged", 1, 50, "", "", ""], { salesOrders: [{ doc_no: "SO-P1" }] });
    qc.setQueryData(["grns-paged", 0, 50, "", "", ""], { grns: [{ id: "GRN-P0" }] });

    const saved = JSON.stringify(flushNow(qc));
    expect(saved).toContain("SO-P0");
    expect(saved).toContain("GRN-P0");
    expect(saved).not.toContain("SO-P1");
  });

  it("paints the saved first page on the next cold open, stamped stale", () => {
    localStorage.setItem(AUTH_TOKEN_KEY, "paged-session");
    setActiveCompanyId(7);
    const first = new QueryClient();
    install(first);
    first.setQueryData(["mfg-delivery-orders-paged", 0, 50, "", "", ""], { deliveryOrders: [{ id: "DO-P0" }] });
    flushNow(first);
    disposePersist?.();

    const next = new QueryClient();
    install(next);
    const key = ["mfg-delivery-orders-paged", 0, 50, "", "", ""];
    expect(next.getQueryData(key)).toEqual({ deliveryOrders: [{ id: "DO-P0" }] });
    expect(next.getQueryState(key)?.dataUpdatedAt).toBe(1);
  });

  it("still never keeps a payments ledger under a paged entity", () => {
    localStorage.setItem(AUTH_TOKEN_KEY, "paged-session");
    setActiveCompanyId(7);
    const qc = new QueryClient();
    install(qc);
    qc.setQueryData(["mfg-sales-orders-paged", 0, "payments"], [{ amount: 1 }]);
    qc.setQueryData(["mfg-sales-orders-paged", 0, 50, "", "", ""], { salesOrders: [] });

    expect(Object.keys(flushNow(qc)).some((k) => k.includes("payments"))).toBe(false);
  });
});
