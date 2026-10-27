// HR attendance day maths (ported from Hookka's attendance-rules) and the
// soft punch-location check.
import { describe, expect, test } from "vitest";
import { DEFAULT_PAY_RULES } from "./hr-pay-rules";
import {
  checkPunchLocation,
  computeAttendanceDay,
  distanceLabel,
  instantOnWorkDate,
  minutesFromWorkDate,
  mytDate,
  toAttendanceRules,
  workClock,
} from "./hr-attendance";

const rules = toAttendanceRules(DEFAULT_PAY_RULES);

describe("computeAttendanceDay", () => {
  test("within the 15-minute grace is not late", () => {
    expect(computeAttendanceDay(495, 1080, rules)).toMatchObject({ lateMin: 0, isLate: false, regularWorkMin: 540, otMin: 0, shortfallMin: 0 });
  });
  test("past the grace counts from 08:00 and the late time is lost from the regular day", () => {
    expect(computeAttendanceDay(496, 1080, rules)).toMatchObject({ lateMin: 16, isLate: true, regularWorkMin: 524, shortfallMin: 16 });
  });
  test("lunch is only the overlap with the worked window", () => {
    expect(computeAttendanceDay(13 * 60 + 30, 1080, rules).regularWorkMin).toBe(270);
  });
  test("OT under one block is none, then whole blocks, and it offsets a shortfall", () => {
    expect(computeAttendanceDay(480, 1094, rules).otMin).toBe(0);
    expect(computeAttendanceDay(480, 1095, rules).otMin).toBe(15);
    expect(computeAttendanceDay(510, 1110, rules)).toMatchObject({ otMin: 30, shortfallMin: 0 });
  });
  test("leaving early is a shortfall", () => {
    expect(computeAttendanceDay(480, 960, rules)).toMatchObject({ regularWorkMin: 420, shortfallMin: 120 });
  });
});

describe("work-date clock", () => {
  test("minutes from Malaysia midnight, across midnight too", () => {
    expect(minutesFromWorkDate("2026-10-22", new Date("2026-10-22T00:05:00Z"))).toBe(8 * 60 + 5);
    expect(minutesFromWorkDate("2026-10-22", new Date("2026-10-22T17:30:00Z"))).toBe(25 * 60 + 30);
    expect(instantOnWorkDate("2026-10-22", 480).toISOString()).toBe("2026-10-22T00:00:00.000Z");
    expect(mytDate(new Date("2026-10-21T16:30:00Z"))).toBe("2026-10-22");
  });
  test("labels", () => {
    expect(workClock(485)).toBe("08:05");
    expect(workClock(1440 + 70)).toBe("01:10 (+1)");
    expect(distanceLabel(350)).toBe("350 m");
    expect(distanceLabel(1234)).toBe("1.2 km");
  });
});

describe("checkPunchLocation", () => {
  const sites = [
    { id: 1, name: "KL WAREHOUSE", lat: 3.0738, lng: 101.5183, radiusM: 200 },
    { id: 2, name: "HQ", lat: 3.1579, lng: 101.7116, radiusM: 150 },
  ];
  test("inside the nearest site's radius is IN", () => {
    expect(checkPunchLocation(3.0745, 101.5185, sites)).toMatchObject({ geo: "IN", siteId: 1, siteName: "KL WAREHOUSE" });
  });
  test("outside every radius is OUT and still names the nearest site and distance", () => {
    const r = checkPunchLocation(3.09, 101.52, sites);
    expect(r).toMatchObject({ geo: "OUT", siteId: 1 });
    expect(r.distanceM).toBeGreaterThan(1500);
  });
  test("no GPS or no site configured is NONE", () => {
    expect(checkPunchLocation(null, null, sites).geo).toBe("NONE");
    expect(checkPunchLocation(3.07, 101.51, []).geo).toBe("NONE");
  });
});
