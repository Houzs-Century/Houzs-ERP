// The punch clock's pure rules: the day view (late / regular / OT from the two
// times), what a punch does given what is stored, the forgotten-punch close,
// and an HR correction's times.
import { describe, expect, test } from "vitest";
import { DEFAULT_PAY_RULES } from "../../scm/shared/hr-pay-rules";
import { toAttendanceRules } from "../../scm/shared/hr-attendance";
import { asDate, attendanceView, autoCloseAt, correctionTimes, isForgottenOpenPunch, planPunch, type AttendanceRow } from "./hr-attendance-view";

const rules = toAttendanceRules(DEFAULT_PAY_RULES);
const at = (myt: string) => new Date(`${myt}+08:00`).toISOString();
const row = (over: Partial<AttendanceRow>): AttendanceRow => ({
  id: 1, employee_id: 7, work_date: "2026-10-22", status: "PRESENT",
  clock_in_at: null, clock_out_at: null, in_source: "PHONE", out_source: "PHONE",
  in_lat: null, in_lng: null, in_accuracy_m: null, in_geo: "IN", in_site_id: 3, in_distance_m: 40, in_photo_key: "k",
  out_lat: null, out_lng: null, out_accuracy_m: null, out_geo: null, out_site_id: null, out_distance_m: null, out_photo_key: null,
  notes: null, ...over,
});
const sites = new Map([[3, "KL WAREHOUSE"]]);

describe("asDate", () => {
  test("reads Postgres text with a bare +08 offset and ISO alike", () => {
    expect(asDate("2026-10-22 08:01:00.12+08").toISOString()).toBe("2026-10-22T00:01:00.120Z");
    expect(asDate("2026-10-22T00:01:00.000Z").toISOString()).toBe("2026-10-22T00:01:00.000Z");
  });
});

describe("attendanceView", () => {
  test("a normal day: 08:05 to 18:00 is on time, 9h regular, no OT", () => {
    const v = attendanceView(row({ clock_in_at: at("2026-10-22T08:05:00"), clock_out_at: at("2026-10-22T18:00:00") }), rules, sites, new Date());
    expect(v.in?.clock).toBe("08:05");
    expect(v.in?.siteName).toBe("KL WAREHOUSE");
    expect(v.out?.clock).toBe("18:00");
    expect(v).toMatchObject({ open: false, lateMin: 0, regularMin: 540, otMin: 0, shortfallMin: 0 });
  });

  test("late past the grace counts from 08:00; OT in whole 15-minute blocks after 18:00", () => {
    const v = attendanceView(row({ clock_in_at: at("2026-10-22T08:20:00"), clock_out_at: at("2026-10-22T19:44:00") }), rules, sites, new Date());
    expect(v.lateMin).toBe(20);
    expect(v.otMin).toBe(90);
  });

  test("a clock-out after midnight belongs to the day it started and reads +1", () => {
    const v = attendanceView(row({ clock_in_at: at("2026-10-22T08:00:00"), clock_out_at: at("2026-10-23T01:10:00") }), rules, sites, new Date());
    expect(v.out?.clock).toBe("01:10 (+1)");
    expect(v.otMin).toBe(7 * 60);
  });

  test("an open day shows hours so far and no OT or shortfall yet", () => {
    const v = attendanceView(row({ clock_in_at: at("2026-10-22T08:00:00") }), rules, sites, new Date(at("2026-10-22T10:30:00")));
    expect(v).toMatchObject({ open: true, otMin: 0, shortfallMin: 0, spanMin: 150, regularMin: 150 });
  });

  test("a leave day with no punch has no times", () => {
    const v = attendanceView(row({ status: "MEDICAL_LEAVE" }), rules, sites, new Date());
    expect(v).toMatchObject({ in: null, out: null, open: false, spanMin: null, lateMin: 0 });
  });
});

describe("planPunch", () => {
  const today = (o: Partial<{ clock_in_at: string | null; clock_out_at: string | null }>) => ({ id: 5, work_date: "2026-10-22", clock_in_at: null, clock_out_at: null, ...o });
  test("clock in: new day inserts, a second tap is a no-op, a closed day is refused", () => {
    expect(planPunch("CLOCK_IN", null, null)).toEqual({ kind: "insert" });
    expect(planPunch("CLOCK_IN", today({}), null)).toEqual({ kind: "stamp-in", rowId: 5 });
    expect(planPunch("CLOCK_IN", today({ clock_in_at: at("2026-10-22T08:00:00") }), { id: 5 })).toEqual({ kind: "already-in", rowId: 5 });
    expect(planPunch("CLOCK_IN", today({ clock_in_at: at("2026-10-22T08:00:00"), clock_out_at: at("2026-10-22T18:02:00") }), null)).toEqual({ kind: "already-out", rowId: 5, clock: "18:02" });
  });
  test("clock out closes the open punch even from yesterday; nothing open is refused", () => {
    expect(planPunch("CLOCK_OUT", null, { id: 4 })).toEqual({ kind: "stamp-out", rowId: 4 });
    expect(planPunch("CLOCK_OUT", null, null)).toEqual({ kind: "no-open-punch" });
    expect(planPunch("CLOCK_OUT", today({ clock_in_at: at("2026-10-22T08:00:00"), clock_out_at: at("2026-10-22T18:00:00") }), null).kind).toBe("already-out");
  });
});

describe("forgotten clock-out", () => {
  test("16 hours open is forgotten; a long outstation day is not", () => {
    const inAt = new Date(at("2026-10-22T08:00:00"));
    expect(isForgottenOpenPunch(inAt, new Date(at("2026-10-23T00:05:00")))).toBe(true);
    expect(isForgottenOpenPunch(inAt, new Date(at("2026-10-22T23:30:00")))).toBe(false);
  });
  test("closed at the shift end; a clock-in after the shift end gets a standard day", () => {
    expect(autoCloseAt("2026-10-22", new Date(at("2026-10-22T08:10:00")), rules).toISOString()).toBe(new Date(at("2026-10-22T18:00:00")).toISOString());
    expect(autoCloseAt("2026-10-22", new Date(at("2026-10-22T19:00:00")), rules).toISOString()).toBe(new Date(at("2026-10-23T05:00:00")).toISOString());
  });
});

describe("correctionTimes", () => {
  test("HH:MM on the work date; an earlier clock-out is the next morning", () => {
    expect(correctionTimes("2026-10-22", "08:00", "17:30")).toEqual({ ok: true, inMin: 480, outMin: 1050 });
    expect(correctionTimes("2026-10-22", "20:00", "02:15")).toEqual({ ok: true, inMin: 1200, outMin: 1575 });
    expect(correctionTimes("2026-10-22", "", "")).toEqual({ ok: true, inMin: null, outMin: null });
  });
  test("bad shapes are refused", () => {
    expect(correctionTimes("2026-10-22", "8.00", "")).toMatchObject({ ok: false });
    expect(correctionTimes("2026-10-22", "", "18:00")).toMatchObject({ ok: false, message: "A clock-out needs a clock-in." });
  });
});
