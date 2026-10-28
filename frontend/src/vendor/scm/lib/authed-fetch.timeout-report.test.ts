// ----------------------------------------------------------------------------
// HC-0167: Sim's approve-so hit the 30-second deadline at the evening peak and
// System Health had no trace of it — reportSlowRequest only runs on a response,
// and a timed-out request never gets one. The timeout is now reported too.
// ----------------------------------------------------------------------------
import { beforeEach, describe, expect, test, vi } from "vitest";

const reporter = vi.hoisted(() => ({
  reportTimedOutRequest: vi.fn(),
  reportSlowRequest: vi.fn(),
  reportServerFailure: vi.fn(),
  reportAccessDenied: vi.fn(),
}));
vi.mock("../../../lib/errorReporter", () => reporter);

import { AUTH_TOKEN_KEY } from "../../../lib/authToken";
import { authedFetch } from "./authed-fetch";

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(AUTH_TOKEN_KEY, "test-token");
  vi.restoreAllMocks();
  reporter.reportTimedOutRequest.mockClear();
});

describe("a timed-out SCM request reaches System Health", () => {
  /* The uuid is collapsed later, inside the reporter (normalizeApiPath). */
  test("approve-so past the deadline is reported once", async () => {
    const original = Object.getOwnPropertyDescriptor(AbortSignal, "timeout");
    const deadline = new AbortController();
    Object.defineProperty(AbortSignal, "timeout", { configurable: true, value: () => deadline.signal });
    vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      }));
    try {
      const pending = authedFetch("/so-amendments/a868b6f9-b47d-4469-8bb7-d2088d2bf0e7/approve-so", { method: "PATCH" });
      deadline.abort(new DOMException("Timed out", "TimeoutError"));
      await expect(pending).rejects.toThrow(/couldn't confirm whether it saved/);
      expect(reporter.reportTimedOutRequest).toHaveBeenCalledTimes(1);
      expect(reporter.reportTimedOutRequest).toHaveBeenCalledWith(
        "PATCH", "/so-amendments/a868b6f9-b47d-4469-8bb7-d2088d2bf0e7/approve-so",
      );
    } finally {
      if (original) Object.defineProperty(AbortSignal, "timeout", original);
      else delete (AbortSignal as { timeout?: typeof AbortSignal.timeout }).timeout;
    }
  });

  test("a request that answers is not reported as a timeout", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } }),
    );
    await authedFetch("/so-amendments/a1/approve-so", { method: "PATCH" });
    expect(reporter.reportTimedOutRequest).not.toHaveBeenCalled();
  });
});
