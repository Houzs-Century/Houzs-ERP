import { describe, expect, it } from "vitest";

import { dayByEmployee, punchOf } from "./attendanceToday";
import type { AttendanceDay, AttendanceResponse } from "./hrApi";

function day(status: AttendanceDay["status"], lateMin: number, clock: string | null): AttendanceDay {
  return {
    id: 1,
    employeeId: 1,
    workDate: "2026-11-20",
    status,
    in: clock ? ({ clock } as AttendanceDay["in"]) : null,
    out: null,
    open: false,
    lateMin,
    regularMin: 0,
    otMin: 0,
    shortfallMin: 0,
    spanMin: null,
    notes: null,
  };
}

describe("punchOf", () => {
  it("no record reads as not in", () => {
    expect(punchOf(null).state).toBe("out");
  });
  it("present on time is on duty, carrying the clock-in time", () => {
    const r = punchOf(day("PRESENT", 0, "07:58"));
    expect(r.state).toBe("on");
    expect(r.time).toBe("07:58");
  });
  it("present past the shift start is late", () => {
    const r = punchOf(day("PRESENT", 18, "08:18"));
    expect(r.state).toBe("late");
    expect(r.lateMin).toBe(18);
  });
  it("half day counts as present", () => {
    expect(punchOf(day("HALF_DAY", 0, "08:00")).state).toBe("on");
  });
  it("the four approved-leave statuses are leave", () => {
    for (const s of ["ANNUAL_LEAVE", "MEDICAL_LEAVE", "REST_DAY", "UNPAID_LEAVE"] as const) {
      expect(punchOf(day(s, 0, null)).state).toBe("leave");
    }
  });
  it("marked absent reads as not in", () => {
    expect(punchOf(day("ABSENT", 0, null)).state).toBe("out");
  });
});

describe("dayByEmployee", () => {
  it("is empty for no response", () => {
    expect(dayByEmployee(null).size).toBe(0);
  });
  it("maps each row's day by employee id, keeping a null day", () => {
    const res = {
      rows: [
        { employee: { id: 7 }, day: day("PRESENT", 0, "08:00") },
        { employee: { id: 9 }, day: null },
      ],
    } as unknown as AttendanceResponse;
    const m = dayByEmployee(res);
    expect(m.get(7)?.status).toBe("PRESENT");
    expect(m.get(9)).toBeNull();
    expect(m.has(3)).toBe(false);
  });
});
