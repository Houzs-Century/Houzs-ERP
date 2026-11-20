import { describe, expect, test } from "vitest";
import { confirmedOtMinutes, parseOtSegment, segmentMinutes } from "./hr-ot";

describe("parseOtSegment", () => {
  test("a normal after-shift window: 20:30-21:30 is one hour", () => {
    expect(parseOtSegment("20:30", "21:30")).toEqual({ ok: true, startMin: 1230, endMin: 1290 });
  });
  test("before the shift: 08:00-09:00", () => {
    expect(parseOtSegment("08:00", "09:00")).toEqual({ ok: true, startMin: 480, endMin: 540 });
  });
  test("a window crossing midnight rolls the end past 1440", () => {
    const r = parseOtSegment("23:30", "00:30");
    expect(r).toEqual({ ok: true, startMin: 1410, endMin: 1470 });
    if (r.ok) expect(segmentMinutes({ start_min: r.startMin, end_min: r.endMin })).toBe(60);
  });
  test("bad shapes and a zero-length window are refused", () => {
    expect(parseOtSegment("8am", "9").ok).toBe(false);
    expect(parseOtSegment("20:00", "20:00").ok).toBe(false);
  });
  test("a block over 16 hours is refused", () => {
    expect(parseOtSegment("06:00", "23:00").ok).toBe(false);
  });
});

describe("confirmedOtMinutes", () => {
  test("sums only CONFIRMED rows", () => {
    const rows = [
      { status: "CONFIRMED", start_min: 480, end_min: 540 }, // 60
      { status: "PENDING", start_min: 1230, end_min: 1290 }, // ignored
      { status: "CONFIRMED", start_min: 1410, end_min: 1470 }, // 60
      { status: "REJECTED", start_min: 0, end_min: 600 }, // ignored
    ];
    expect(confirmedOtMinutes(rows)).toBe(120);
  });
});
