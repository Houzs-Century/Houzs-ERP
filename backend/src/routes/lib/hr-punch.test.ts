import { describe, expect, test } from "vitest";
import { parsePunchFix } from "./hr-punch";

const TODAY = "2026-11-23";

describe("parsePunchFix", () => {
  test("a past day with both times parses to minutes from midnight", () => {
    expect(parsePunchFix("2026-11-20", "08:05", "18:10", TODAY)).toEqual({ ok: true, inMin: 485, outMin: 1090 });
  });

  test("an overnight out is carried to the next day (+1440), like the HR correction", () => {
    const r = parsePunchFix("2026-11-20", "22:00", "01:00", TODAY);
    expect(r).toEqual({ ok: true, inMin: 1320, outMin: 1500 });
  });

  test("a future day is refused", () => {
    expect(parsePunchFix("2026-11-30", "08:00", "18:00", TODAY).ok).toBe(false);
  });

  test("both the in and the out time are required", () => {
    expect(parsePunchFix("2026-11-20", "08:00", "", TODAY).ok).toBe(false);
    expect(parsePunchFix("2026-11-20", "", "18:00", TODAY).ok).toBe(false);
  });

  test("a malformed time is refused", () => {
    expect(parsePunchFix("2026-11-20", "ab:cd", "18:00", TODAY).ok).toBe(false);
  });
});
