import { describe, expect, test } from "vitest";
import { APPLICABLE_LEAVE_TYPES, eachDate, parseLeaveRequest } from "./hr-leave";

describe("parseLeaveRequest", () => {
  test("a valid range expands to the inclusive list of days", () => {
    expect(parseLeaveRequest("ANNUAL_LEAVE", "2026-11-23", "2026-11-25")).toEqual({
      ok: true,
      leaveStatus: "ANNUAL_LEAVE",
      days: ["2026-11-23", "2026-11-24", "2026-11-25"],
    });
  });

  test("a single day", () => {
    const r = parseLeaveRequest("MEDICAL_LEAVE", "2026-11-23", "2026-11-23");
    expect(r.ok && r.days).toEqual(["2026-11-23"]);
  });

  test("a month boundary is crossed correctly", () => {
    const r = parseLeaveRequest("ANNUAL_LEAVE", "2026-11-29", "2026-12-02");
    expect(r.ok && r.days).toEqual(["2026-11-29", "2026-11-30", "2026-12-01", "2026-12-02"]);
  });

  test("an unknown leave type, an inverted range and an over-cap range are refused", () => {
    expect(parseLeaveRequest("HOLIDAY", "2026-11-23", "2026-11-23").ok).toBe(false);
    expect(parseLeaveRequest("ANNUAL_LEAVE", "2026-11-25", "2026-11-23").ok).toBe(false);
    expect(parseLeaveRequest("UNPAID_LEAVE", "2026-01-01", "2026-12-31").ok).toBe(false);
  });
});

describe("APPLICABLE_LEAVE_TYPES", () => {
  test("annual / medical / unpaid, with the unpaid one marked unpaid", () => {
    expect(APPLICABLE_LEAVE_TYPES.map((t) => t.value)).toEqual(["ANNUAL_LEAVE", "MEDICAL_LEAVE", "UNPAID_LEAVE"]);
    expect(APPLICABLE_LEAVE_TYPES.find((t) => t.value === "UNPAID_LEAVE")?.paid).toBe(false);
  });
});

describe("eachDate", () => {
  test("inclusive and ordered", () => {
    expect(eachDate("2026-02-27", "2026-03-01")).toEqual(["2026-02-27", "2026-02-28", "2026-03-01"]);
  });
});
