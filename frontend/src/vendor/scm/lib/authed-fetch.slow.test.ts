import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const reportSlowRequest = vi.fn();
vi.mock("../../../lib/errorReporter", () => ({
  reportSlowRequest: (...args: unknown[]) => reportSlowRequest(...args),
  reportServerFailure: vi.fn(),
  reportAccessDenied: vi.fn(),
}));

import { AUTH_TOKEN_KEY } from "../../../lib/authToken";
import { authedFetch, scmTelemetryPath } from "./authed-fetch";

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
    expect(reportSlowRequest).toHaveBeenCalledWith("GET", "/mfg-sales-orders/:id/coverage", 1200);
  });

  test("a fast read is not reported", async () => {
    okAfter(300);
    await authedFetch("/mfg-sales-orders");
    expect(reportSlowRequest).not.toHaveBeenCalled();
  });
});

describe("scmTelemetryPath", () => {
  test("collapses doc numbers so one endpoint is one signature", () => {
    expect(scmTelemetryPath("/mfg-sales-orders/HC-SO-2609-004/coverage")).toBe("/mfg-sales-orders/:id/coverage");
    expect(scmTelemetryPath("/purchase-orders/PO-2607-001")).toBe("/purchase-orders/:id");
    expect(scmTelemetryPath("/grns/GRN-2609-001?x=1")).toBe("/grns/:id?x=1");
  });

  test("leaves named segments alone", () => {
    expect(scmTelemetryPath("/mfg-sales-orders/list-mrp-enrichment")).toBe("/mfg-sales-orders/list-mrp-enrichment");
    expect(scmTelemetryPath("/document-flow/candidate-pos/x")).toBe("/document-flow/candidate-pos/x");
  });
});
