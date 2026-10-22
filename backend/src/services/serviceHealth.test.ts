import { describe, expect, it } from "vitest";
import { scrubError, serviceVerdict } from "./serviceHealth";

const NOW = Date.parse("2026-10-05T12:00:00Z");
const HOUR_AGO = "2026-10-05T11:00:00Z";
const TWO_HOURS_AGO = "2026-10-05T10:00:00Z";
const TWO_DAYS_AGO = "2026-10-03T12:00:00Z";

describe("serviceVerdict (DEV-35 outside services)", () => {
  it("is critical when the last attempt failed", () => {
    expect(serviceVerdict({ lastSuccessAt: TWO_HOURS_AGO, lastFailureAt: HOUR_AGO, attempts24h: 50, failures24h: 1 }, NOW))
      .toEqual({ verdict: "critical", note: "last attempt failed" });
    // Failed with no success ever, even when idle since.
    expect(serviceVerdict({ lastSuccessAt: null, lastFailureAt: TWO_DAYS_AGO, attempts24h: 0, failures24h: 0 }, NOW).verdict)
      .toBe("critical");
  });

  it("is critical when there were attempts but no success in 24 h", () => {
    expect(serviceVerdict({ lastSuccessAt: TWO_DAYS_AGO, lastFailureAt: null, attempts24h: 3, failures24h: 0 }, NOW))
      .toEqual({ verdict: "critical", note: "no success in 24 h" });
  });

  it("is ok and idle with no attempts in 24 h", () => {
    expect(serviceVerdict({ lastSuccessAt: TWO_DAYS_AGO, lastFailureAt: null, attempts24h: 0, failures24h: 0 }, NOW))
      .toEqual({ verdict: "ok", note: "idle" });
    expect(serviceVerdict({ lastSuccessAt: null, lastFailureAt: null, attempts24h: 0, failures24h: 0 }, NOW).note).toBe("idle");
  });

  it("warns above 20% failures and stays ok at exactly 20%", () => {
    const base = { lastSuccessAt: HOUR_AGO, lastFailureAt: TWO_HOURS_AGO };
    expect(serviceVerdict({ ...base, attempts24h: 10, failures24h: 3 }, NOW).verdict).toBe("warning");
    expect(serviceVerdict({ ...base, attempts24h: 10, failures24h: 2 }, NOW)).toEqual({ verdict: "ok", note: null });
  });
});

describe("scrubError", () => {
  it("drops query strings, credential values and key shapes, and trims to 200", () => {
    expect(scrubError("GET https://ac.example.com/sync?key=abc123secret failed")).toBe(
      "GET https://ac.example.com/sync?[redacted] failed",
    );
    expect(scrubError("Authorization: Bearer abc.def.ghi")).not.toContain("abc.def");
    expect(scrubError("token=zzz999 rejected")).toBe("token=[redacted] rejected");
    expect(scrubError("bad key sk-ant-api03-AAAAAAAAAAAA")).toBe("bad key [redacted]");
    expect(scrubError("x".repeat(500))!.length).toBe(200);
    expect(scrubError(null)).toBeNull();
    expect(scrubError("")).toBeNull();
  });
});
