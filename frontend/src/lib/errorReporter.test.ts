import { describe, expect, test } from "vitest";
import { formatReportedStack, normalizeApiPath } from "./errorReporter";

/* enqueue() rate-limits on `message|route`, so request telemetry is only safe
   to add if its messages COLLAPSE. A message carrying a raw id is unique every
   time, PER_SIGNATURE_CAP never bites, and a bad afternoon turns the reporter
   into the flood. These pin the collapsing. */
describe("request telemetry signature stability", () => {
  test("collapses numeric ids so one endpoint is one signature", () => {
    expect(normalizeApiPath("/api/assr/1435")).toBe("/api/assr/:id");
    expect(normalizeApiPath("/api/assr/1435")).toBe(normalizeApiPath("/api/assr/9999"));
  });

  test("collapses uuid segments", () => {
    const a = normalizeApiPath("/api/scm/grns/01a88527-47b3-468c-95d0-c291d895340b");
    const b = normalizeApiPath("/api/scm/grns/cef691dd-1111-2222-3333-444455556666");
    expect(a).toBe("/api/scm/grns/:id");
    expect(a).toBe(b);
  });

  test("drops the query string — filters must not multiply signatures", () => {
    expect(normalizeApiPath("/api/assr?page=1&per_page=50&stage=review")).toBe("/api/assr");
    expect(normalizeApiPath("/api/assr?page=2")).toBe(normalizeApiPath("/api/assr?page=7"));
  });

  test("keeps genuinely different endpoints apart", () => {
    expect(normalizeApiPath("/api/assr/1435")).not.toBe(normalizeApiPath("/api/users/1435"));
    expect(normalizeApiPath("/api/scm/grns")).not.toBe(normalizeApiPath("/api/scm/purchase-invoices"));
  });

  test("leaves a non-id path segment alone", () => {
    expect(normalizeApiPath("/api/assr/lookups/issue-categories")).toBe(
      "/api/assr/lookups/issue-categories",
    );
    expect(normalizeApiPath("/api/assr/summary")).toBe("/api/assr/summary");
  });
});

describe("error reporter request correlation", () => {
  test("keeps a valid request id suffix while strictly capping the stack", () => {
    const requestId = "a".repeat(64);
    const error = Object.assign(new Error("boom"), {
      requestId,
      stack: "s".repeat(5_000),
    });

    const reported = formatReportedStack(error);

    expect(reported).toHaveLength(4_000);
    expect(reported).toMatch(new RegExp(`\\nRequest-Id: ${requestId}$`));
  });

  test("ignores an oversized request id and still strictly caps the stack", () => {
    const error = Object.assign(new Error("boom"), {
      requestId: "x".repeat(10_000),
      stack: "s".repeat(5_000),
    });

    const reported = formatReportedStack(error);

    expect(reported).toHaveLength(4_000);
    expect(reported).not.toContain("Request-Id:");
  });
});
