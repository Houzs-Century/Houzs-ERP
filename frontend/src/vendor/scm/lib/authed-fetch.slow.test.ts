import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const reportSlowRequest = vi.fn();
vi.mock("../../../lib/errorReporter", () => ({
  reportSlowRequest: (...args: unknown[]) => reportSlowRequest(...args),
  reportServerFailure: vi.fn(),
  reportAccessDenied: vi.fn(),
}));

import { AUTH_TOKEN_KEY } from "../../../lib/authToken";
import { authedFetch } from "./authed-fetch";

beforeEach(() => {
  localStorage.setItem(AUTH_TOKEN_KEY, "test-token");
  reportSlowRequest.mockClear();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function okAfter(ms: number) {
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.stubGlobal("fetch", vi.fn(async () => {
    now += ms;
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }));
}

describe("SCM slow-request telemetry (HC-0002)", () => {
  test("a read at or over 800ms is reported with its method and path", async () => {
    okAfter(1200);
    await authedFetch("/mfg-sales-orders/HC-SO-2609-004/coverage");
    expect(reportSlowRequest).toHaveBeenCalledWith("GET", "/mfg-sales-orders/HC-SO-2609-004/coverage", 1200);
  });

  test("a fast read is not reported", async () => {
    okAfter(300);
    await authedFetch("/mfg-sales-orders");
    expect(reportSlowRequest).not.toHaveBeenCalled();
  });
});
