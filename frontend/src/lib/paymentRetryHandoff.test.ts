import { afterEach, describe, expect, test, vi } from "vitest";
import { bindBrowserStorageIdentity, clearBrowserStorageIdentity } from "./storageIdentity";
import { adoptActiveCompanyForUser, releaseActiveCompanyBinding, setActiveCompanyId } from "./activeCompany";
import { clearAllScmHandoffs } from "./scmHandoffStorage";
import { newPaymentDraft } from "../vendor/scm/components/PaymentsTable";
import {
  clearPaymentRetryHandoff,
  completePaymentRetryDraft,
  consumePaymentRetryNavigationState,
  readPaymentRetryHandoff,
  paymentRetryNavigationState,
  planPaymentDraftFlush,
  readPaymentRetryNavigationState,
  writePaymentRetryHandoff,
} from "./paymentRetryHandoff";

afterEach(() => {
  vi.useRealTimers();
  clearBrowserStorageIdentity();
  releaseActiveCompanyBinding();
  sessionStorage.clear();
  localStorage.clear();
});

describe("payment retry handoff", () => {
  test("preserves exact failed rows and their original idempotency keys", () => {
    bindBrowserStorageIdentity(7);
    const first = { ...newPaymentDraft(), amountCenti: 1000 };
    const second = { ...newPaymentDraft(), amountCenti: 2000 };
    expect(writePaymentRetryHandoff("so", "SO-1", [first, second])).toBe(true);
    expect(readPaymentRetryHandoff("so", "SO-1")?.drafts).toEqual([first, second]);
  });

  test("removes only a confirmed row and clears the handoff after the last one", () => {
    bindBrowserStorageIdentity(7);
    const first = { ...newPaymentDraft(), amountCenti: 1000 };
    const second = { ...newPaymentDraft(), amountCenti: 2000 };
    writePaymentRetryHandoff("so", "SO-1", [first, second]);
    expect(completePaymentRetryDraft("so", "SO-1", first.idempotencyKey!)).toEqual([second]);
    expect(readPaymentRetryHandoff("so", "SO-1")?.drafts).toEqual([second]);
    expect(completePaymentRetryDraft("so", "SO-1", second.idempotencyKey!)).toEqual([]);
    expect(readPaymentRetryHandoff("so", "SO-1")).toBeNull();
  });

  test("stores each intent independently and never extends another row's retry deadline", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-20T00:00:00Z"));
    bindBrowserStorageIdentity(7);
    const first = { ...newPaymentDraft(), amountCenti: 1000 };
    const second = { ...newPaymentDraft(), amountCenti: 2000 };
    writePaymentRetryHandoff("so", "SO-1", [first, second]);
    expect(Object.keys(localStorage).filter((key) => key.includes("soPaymentRetry"))).toHaveLength(2);

    vi.advanceTimersByTime(22 * 60 * 60 * 1_000);
    completePaymentRetryDraft("so", "SO-1", first.idempotencyKey!);
    expect(readPaymentRetryHandoff("so", "SO-1")?.drafts).toEqual([second]);
    vi.advanceTimersByTime(2 * 60 * 60 * 1_000);
    expect(readPaymentRetryHandoff("so", "SO-1")).toBeNull();
  });

  test("does not expose or clear a handoff for another document", () => {
    bindBrowserStorageIdentity(7);
    const draft = { ...newPaymentDraft(), amountCenti: 1000 };
    writePaymentRetryHandoff("si", "SI-1", [draft]);
    expect(readPaymentRetryHandoff("si", "SI-2")).toBeNull();
    clearPaymentRetryHandoff("si", "SI-2");
    expect(readPaymentRetryHandoff("si", "SI-1")?.drafts).toEqual([draft]);
  });

  test("keeps independent retry rows for multiple documents of one kind", () => {
    bindBrowserStorageIdentity(7);
    const first = { ...newPaymentDraft(), amountCenti: 1000 };
    const second = { ...newPaymentDraft(), amountCenti: 2000 };
    writePaymentRetryHandoff("so", "SO-1", [first]);
    writePaymentRetryHandoff("so", "SO-2", [second]);

    expect(readPaymentRetryHandoff("so", "SO-1")?.drafts).toEqual([first]);
    expect(readPaymentRetryHandoff("so", "SO-2")?.drafts).toEqual([second]);
    clearPaymentRetryHandoff("so", "SO-1");
    expect(readPaymentRetryHandoff("so", "SO-2")?.drafts).toEqual([second]);
  });

  test("provides a validated navigation-state fallback when session storage is unavailable", () => {
    bindBrowserStorageIdentity(7);
    const draft = { ...newPaymentDraft(), amountCenti: 1000 };
    const state = paymentRetryNavigationState("si", "SI-1", [draft]);
    expect(readPaymentRetryNavigationState(state, "si", "SI-1")).toEqual([draft]);
    expect(readPaymentRetryNavigationState(state, "so", "SI-1")).toEqual([]);
    expect(readPaymentRetryNavigationState(state, "si", "SI-2")).toEqual([]);
    bindBrowserStorageIdentity(8);
    expect(readPaymentRetryNavigationState(state, "si", "SI-1")).toEqual([]);
    expect(consumePaymentRetryNavigationState(state)).toBeNull();
  });

  test("fails closed when a retry row lacks an idempotency key", () => {
    bindBrowserStorageIdentity(7);
    const { idempotencyKey: _missing, ...invalid } = { ...newPaymentDraft(), amountCenti: 1000 };
    expect(writePaymentRetryHandoff("so", "SO-1", [invalid as never])).toBe(false);
    expect(readPaymentRetryHandoff("so", "SO-1")).toBeNull();
  });

  test("fails closed when two rows claim the same payment intent", () => {
    bindBrowserStorageIdentity(7);
    const first = { ...newPaymentDraft(), amountCenti: 1000 };
    const duplicate = { ...first, uid: "different-ui-row", amountCenti: 2000 };
    expect(writePaymentRetryHandoff("so", "SO-1", [first, duplicate])).toBe(false);
    expect(readPaymentRetryHandoff("so", "SO-1")).toBeNull();
  });

  test("SURVIVES A 401 — an expired session must not delete collected money", () => {
    // AuthContext's 401 path runs exactly this sequence (resetSessionCaches).
    // These drafts are payments the operator has already taken at the counter
    // and the server has not accepted yet; a routine session expiry is not
    // permission to destroy the only record of them.
    bindBrowserStorageIdentity(7);
    const draft = { ...newPaymentDraft(), amountCenti: 45_000 };
    writePaymentRetryHandoff("so", "SO-1", [draft]);

    clearAllScmHandoffs();
    clearBrowserStorageIdentity();

    // Signing back in restores the same user + company scope, so the intents
    // are readable again — nothing was thrown away in between.
    bindBrowserStorageIdentity(7);
    expect(readPaymentRetryHandoff("so", "SO-1")?.drafts).toEqual([draft]);
  });

  test("SURVIVES A COMPANY SWITCH back to the company it was staged in", () => {
    adoptActiveCompanyForUser(7);
    setActiveCompanyId(3);
    bindBrowserStorageIdentity(7);
    const draft = { ...newPaymentDraft(), amountCenti: 12_500 };
    writePaymentRetryHandoff("si", "SI-9", [draft]);

    // The switcher's sequence: drop the transient handoffs, then change tenant.
    clearAllScmHandoffs();
    setActiveCompanyId(4);
    bindBrowserStorageIdentity(7);
    expect(readPaymentRetryHandoff("si", "SI-9")).toBeNull(); // scoped out, not deleted

    setActiveCompanyId(3);
    bindBrowserStorageIdentity(7);
    expect(readPaymentRetryHandoff("si", "SI-9")?.drafts).toEqual([draft]);
  });

  test("plans edits from the frozen baseline without deleting or reviving concurrent rows", () => {
    const original = { ...newPaymentDraft(), uid: "persisted-1", amountCenti: 1000, idempotencyKey: undefined };
    const addedHere = { ...newPaymentDraft(), uid: "new-here", amountCenti: 2000 };
    const plan = planPaymentDraftFlush(
      ["persisted-1", "deleted-elsewhere"],
      ["persisted-1", "added-elsewhere"],
      [original, addedHere],
    );
    expect(plan.deleteIds).toEqual([]);
    expect(plan.draftsToPost).toEqual([addedHere]);

    const deletePlan = planPaymentDraftFlush(
      ["persisted-1"],
      ["persisted-1", "added-elsewhere"],
      [],
    );
    expect(deletePlan.deleteIds).toEqual(["persisted-1"]);
  });
});
