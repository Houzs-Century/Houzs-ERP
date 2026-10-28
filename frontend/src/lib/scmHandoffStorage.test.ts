import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setActiveCompanyId } from "./activeCompany";
import { AUTH_TOKEN_KEY } from "./authToken";
import { bindBrowserStorageIdentity, clearBrowserStorageIdentity } from "./storageIdentity";
import {
  clearAllScmHandoffs,
  discardDurableScmHandoffs,
  readScmHandoff,
  removeScmHandoff,
  SCM_HANDOFF_KEYS,
  SCM_HANDOFF_TTL_MS,
  SCM_PAYMENT_RETRY_TTL_MS,
  writeScmHandoff,
} from "./scmHandoffStorage";

const physicalKey = (key: string): string => `houzs:scm-handoff:v1:${key}`;
const durablePhysicalKey = (key: string, user: number, company: number, documentId: string): string =>
  `${physicalKey(key)}:u${user}:c${company}:${encodeURIComponent(documentId)}`;

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  clearBrowserStorageIdentity();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-20T08:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  clearBrowserStorageIdentity();
});

describe("SCM handoff storage", () => {
  it("writes a versioned envelope and returns its payload in the same scope", () => {
    localStorage.setItem(AUTH_TOKEN_KEY, "session-for-company-7");
    setActiveCompanyId(7);
    bindBrowserStorageIdentity(42);
    const payload = [{ id: "SO-1", qty: 3 }];

    expect(writeScmHandoff("doFromSoPicks", payload)).toBe(true);
    expect(JSON.parse(sessionStorage.getItem(physicalKey("doFromSoPicks"))!)).toEqual({
      v: 1,
      user: 42,
      company: 7,
      createdAt: Date.now(),
      payload,
    });
    expect(readScmHandoff("doFromSoPicks")).toEqual(payload);
  });

  it("keeps payment retry intents in durable, physically scoped storage within idempotency retention", () => {
    bindBrowserStorageIdentity(42);
    const payload = { "SO-1": [{ idempotencyKey: "pay-1" }] };
    expect(writeScmHandoff("soPaymentRetry", payload, "SO-1")).toBe(true);
    expect(sessionStorage.getItem(physicalKey("soPaymentRetry"))).toBeNull();
    expect(localStorage.getItem(durablePhysicalKey("soPaymentRetry", 42, 0, "SO-1"))).not.toBeNull();

    vi.advanceTimersByTime(SCM_HANDOFF_TTL_MS + 1);
    expect(readScmHandoff("soPaymentRetry", "SO-1")).toEqual(payload);
    vi.advanceTimersByTime(SCM_PAYMENT_RETRY_TTL_MS - SCM_HANDOFF_TTL_MS);
    expect(readScmHandoff("soPaymentRetry", "SO-1")).toBeNull();
  });

  it("does not let another identity read or delete a durable payment intent", () => {
    bindBrowserStorageIdentity(1);
    writeScmHandoff("soPaymentRetry", { payment: "owner-1" }, "SO-1");
    bindBrowserStorageIdentity(2);
    expect(readScmHandoff("soPaymentRetry", "SO-1")).toBeNull();
    bindBrowserStorageIdentity(1);
    expect(readScmHandoff("soPaymentRetry", "SO-1")).toEqual({ payment: "owner-1" });
  });

  it("keeps durable payment intents when a session ends", () => {
    // clearAllScmHandoffs is what a 401 / logout / company switch runs. Those
    // intents are money already collected, so ending a session must not be able
    // to delete them.
    bindBrowserStorageIdentity(1);
    writeScmHandoff("soPaymentRetry", { payment: "owner-1" }, "SO-1");

    clearAllScmHandoffs();
    clearBrowserStorageIdentity();
    bindBrowserStorageIdentity(1);

    expect(readScmHandoff("soPaymentRetry", "SO-1")).toEqual({ payment: "owner-1" });
  });

  it("discards only the current identity's durable payment intents", () => {
    bindBrowserStorageIdentity(1);
    writeScmHandoff("soPaymentRetry", { payment: "owner-1" }, "SO-1");
    bindBrowserStorageIdentity(2);
    writeScmHandoff("soPaymentRetry", { payment: "owner-2" }, "SO-2");
    discardDurableScmHandoffs();
    bindBrowserStorageIdentity(1);
    expect(readScmHandoff("soPaymentRetry", "SO-1")).toEqual({ payment: "owner-1" });
    bindBrowserStorageIdentity(2);
    expect(readScmHandoff("soPaymentRetry", "SO-2")).toBeNull();
  });

  it("fails closed while no browser storage identity is bound", () => {
    expect(writeScmHandoff("poNewDraft", { supplier: "A" })).toBe(false);
    sessionStorage.setItem(physicalKey("poNewDraft"), JSON.stringify({
      v: 1,
      user: 1,
      company: 0,
      createdAt: Date.now(),
      payload: { supplier: "A" },
    }));

    expect(readScmHandoff("poNewDraft")).toBeNull();
  });

  it("rejects and removes a handoff from another user", () => {
    bindBrowserStorageIdentity(1);
    writeScmHandoff("siFromDoPicks", ["private-row"]);
    bindBrowserStorageIdentity(2);

    expect(readScmHandoff("siFromDoPicks")).toBeNull();
    expect(sessionStorage.getItem(physicalKey("siFromDoPicks"))).toBeNull();
  });

  it("rejects and removes a handoff from another company", () => {
    localStorage.setItem(AUTH_TOKEN_KEY, "company-switch-session");
    setActiveCompanyId(7);
    bindBrowserStorageIdentity(1);
    writeScmHandoff("grnFromPoPicks", ["company-7-row"]);
    setActiveCompanyId(8);
    bindBrowserStorageIdentity(1);

    expect(readScmHandoff("grnFromPoPicks")).toBeNull();
    expect(sessionStorage.getItem(physicalKey("grnFromPoPicks"))).toBeNull();
  });

  it.each([
    ["malformed JSON", "{"],
    ["unknown version", JSON.stringify({ v: 2, user: 1, company: 0, createdAt: 0, payload: [] })],
    ["missing payload", JSON.stringify({ v: 1, user: 1, company: 0, createdAt: 0 })],
  ])("rejects and removes %s", (_label, raw) => {
    bindBrowserStorageIdentity(1);
    sessionStorage.setItem(physicalKey("crFromNotePicks"), raw);

    expect(readScmHandoff("crFromNotePicks")).toBeNull();
    expect(sessionStorage.getItem(physicalKey("crFromNotePicks"))).toBeNull();
  });

  it("rejects and removes a future-dated envelope", () => {
    bindBrowserStorageIdentity(1);
    sessionStorage.setItem(physicalKey("crFromNotePicks"), JSON.stringify({
      v: 1,
      user: 1,
      company: 0,
      createdAt: Date.now() + 1,
      payload: [],
    }));

    expect(readScmHandoff("crFromNotePicks")).toBeNull();
    expect(sessionStorage.getItem(physicalKey("crFromNotePicks"))).toBeNull();
  });

  it("expires and removes a handoff after the TTL", () => {
    bindBrowserStorageIdentity(1);
    writeScmHandoff("pcrFromOrderPicks", { id: "PCR-1" });
    vi.advanceTimersByTime(SCM_HANDOFF_TTL_MS + 1);

    expect(readScmHandoff("pcrFromOrderPicks")).toBeNull();
    expect(sessionStorage.getItem(physicalKey("pcrFromOrderPicks"))).toBeNull();
  });

  it("removes a single handoff", () => {
    bindBrowserStorageIdentity(1);
    writeScmHandoff("piFromGrnPicks", [1]);
    writeScmHandoff("poFromSoPicks", [2]);

    removeScmHandoff("piFromGrnPicks");

    expect(readScmHandoff("piFromGrnPicks")).toBeNull();
    expect(readScmHandoff("poFromSoPicks")).toEqual([2]);
  });

  it("clears transient and legacy handoffs, keeps durable ones, preserves unrelated session state", () => {
    bindBrowserStorageIdentity(1);
    for (const key of SCM_HANDOFF_KEYS) {
      writeScmHandoff(key, { key }, key.endsWith("PaymentRetry") ? "DOC-1" : undefined);
    }
    sessionStorage.setItem("cnFromOrderPicks", JSON.stringify(["legacy-private-row"]));
    sessionStorage.setItem("unrelated", "keep");

    clearAllScmHandoffs();

    for (const key of SCM_HANDOFF_KEYS) {
      expect(sessionStorage.getItem(physicalKey(key))).toBeNull();
    }
    expect(localStorage.getItem(durablePhysicalKey("soPaymentRetry", 1, 0, "DOC-1"))).not.toBeNull();
    expect(localStorage.getItem(durablePhysicalKey("siPaymentRetry", 1, 0, "DOC-1"))).not.toBeNull();
    expect(sessionStorage.getItem("cnFromOrderPicks")).toBeNull();
    expect(sessionStorage.getItem("unrelated")).toBe("keep");

    discardDurableScmHandoffs();
    expect(localStorage.getItem(durablePhysicalKey("soPaymentRetry", 1, 0, "DOC-1"))).toBeNull();
    expect(localStorage.getItem(durablePhysicalKey("siPaymentRetry", 1, 0, "DOC-1"))).toBeNull();
  });

  it("never reads, migrates, or deletes a historical bare-key payload", () => {
    bindBrowserStorageIdentity(1);
    sessionStorage.setItem("doFromSoPicks", JSON.stringify([{ id: "OLD-USER-SO" }]));

    expect(readScmHandoff("doFromSoPicks")).toBeNull();
    expect(sessionStorage.getItem("doFromSoPicks")).toContain("OLD-USER-SO");
    expect(sessionStorage.getItem(physicalKey("doFromSoPicks"))).toBeNull();
  });

  it("fails closed when browser storage throws", () => {
    bindBrowserStorageIdentity(1);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });
    expect(writeScmHandoff("grnNewDraft", { id: "draft" })).toBe(false);

    vi.restoreAllMocks();
    sessionStorage.setItem(physicalKey("grnNewDraft"), "{");
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    expect(readScmHandoff("grnNewDraft")).toBeNull();
  });
});
