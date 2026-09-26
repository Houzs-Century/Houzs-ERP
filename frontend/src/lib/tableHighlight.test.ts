import { describe, expect, it } from "vitest";
import { isDeliveredOwing, isPastDue, todayIso } from "./tableHighlight";

describe("table highlight rules", () => {
  it("today is the local calendar date", () => {
    expect(todayIso(new Date(2026, 8, 5, 23, 59))).toBe("2026-09-05");
  });

  it("a date is past due only before today and only while the document is open", () => {
    expect(isPastDue("2026-09-24", true, "2026-09-25")).toBe(true);
    expect(isPastDue("2026-09-25", true, "2026-09-25")).toBe(false);
    expect(isPastDue("2026-09-24T10:00:00Z", true, "2026-09-25")).toBe(true);
    expect(isPastDue("2026-09-24", false, "2026-09-25")).toBe(false);
    expect(isPastDue(null, true, "2026-09-25")).toBe(false);
  });

  it("owing means delivered in full with a balance left", () => {
    expect(isDeliveredOwing(100, "full")).toBe(true);
    expect(isDeliveredOwing(0, "full")).toBe(false);
    expect(isDeliveredOwing(-50, "full")).toBe(false);
    expect(isDeliveredOwing(100, "partial")).toBe(false);
    expect(isDeliveredOwing(100, null)).toBe(false);
  });
});
