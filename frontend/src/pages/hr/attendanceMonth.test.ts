import { describe, it, expect } from "vitest";
import { cellOf, monthAttendanceStats } from "./attendanceMonth";
import type { WorkDay } from "./hrApi";

const wd = (p: Partial<WorkDay>): WorkDay => ({
  attendanceId: 0,
  employeeId: 1,
  workDate: "2026-11-01",
  status: "PRESENT",
  clockIn: null,
  clockOut: null,
  outSource: null,
  punchHours: null,
  lateMin: 0,
  ...p,
});

describe("cellOf", () => {
  it("future beats everything", () => expect(cellOf(undefined, true)).toBe("future"));
  it("no record is a blank 'not in'", () => expect(cellOf(undefined, false)).toBe("notin"));
  it("rest day", () => expect(cellOf(wd({ status: "REST_DAY" }), false)).toBe("rest"));
  it("approved leave", () => expect(cellOf(wd({ status: "ANNUAL_LEAVE" }), false)).toBe("leave"));
  it("absent", () => expect(cellOf(wd({ status: "ABSENT" }), false)).toBe("absent"));
  it("present on time", () => expect(cellOf(wd({ status: "PRESENT", lateMin: 0 }), false)).toBe("present"));
  it("present but late", () => expect(cellOf(wd({ status: "PRESENT", lateMin: 15 }), false)).toBe("late"));
  it("half day counts its lateness", () => expect(cellOf(wd({ status: "HALF_DAY", lateMin: 5 }), false)).toBe("late"));
});

describe("monthAttendanceStats", () => {
  it("rolls up per day and per employee, ignoring leave and rest", () => {
    const days: WorkDay[] = [
      wd({ employeeId: 1, workDate: "2026-11-03", status: "PRESENT", lateMin: 0 }),
      wd({ employeeId: 2, workDate: "2026-11-03", status: "PRESENT", lateMin: 30 }),
      wd({ employeeId: 3, workDate: "2026-11-03", status: "ABSENT" }),
      wd({ employeeId: 4, workDate: "2026-11-03", status: "REST_DAY" }),
      wd({ employeeId: 2, workDate: "2026-11-04", status: "PRESENT", lateMin: 10 }),
      wd({ employeeId: 1, workDate: "2026-11-04", status: "ANNUAL_LEAVE" }),
    ];
    const { perDay, lateByEmp } = monthAttendanceStats(days);
    expect(perDay.map((d) => d.date)).toEqual(["2026-11-03", "2026-11-04"]);
    expect(perDay[0]).toMatchObject({ onTime: 1, late: 1, absent: 1 });
    expect(perDay[0].rate).toBeCloseTo(1 / 3);
    expect(perDay[1]).toMatchObject({ onTime: 0, late: 1, absent: 0 });
    expect(perDay[1].rate).toBe(0);
    expect(lateByEmp.get(2)).toBe(2);
    expect(lateByEmp.has(1)).toBe(false);
  });

  it("a date with only leave or rest carries no graded record", () => {
    const { perDay } = monthAttendanceStats([
      wd({ workDate: "2026-11-05", status: "REST_DAY" }),
      wd({ workDate: "2026-11-05", status: "MEDICAL_LEAVE" }),
    ]);
    expect(perDay).toEqual([]);
  });

  it("empty input yields empty rollups", () => {
    const { perDay, lateByEmp } = monthAttendanceStats([]);
    expect(perDay).toEqual([]);
    expect(lateByEmp.size).toBe(0);
  });
});
