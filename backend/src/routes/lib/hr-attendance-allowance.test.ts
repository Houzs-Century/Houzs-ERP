import { describe, expect, test } from "vitest";
import { attendanceAllowance, attendanceDayFraction, type AttendanceAllowanceDay } from "./hr-attendance-allowance";

const day = (over: Partial<AttendanceAllowanceDay> = {}): AttendanceAllowanceDay => ({ status: "PRESENT", isLate: false, fraction: 1, ...over });

describe("attendanceDayFraction", () => {
  test("present a full day, half day a half, everything else nothing", () => {
    expect(attendanceDayFraction("PRESENT")).toBe(1);
    expect(attendanceDayFraction("HALF_DAY")).toBe(0.5);
    for (const s of ["ABSENT", "ANNUAL_LEAVE", "MEDICAL_LEAVE", "REST_DAY", "UNPAID_LEAVE"] as const) expect(attendanceDayFraction(s)).toBe(0);
  });
});

describe("attendanceAllowance", () => {
  test("rate x attended days, with a half day", () => {
    const days = [...Array(23)].map(() => day()).concat([day({ status: "HALF_DAY", fraction: 0.5 })]);
    const r = attendanceAllowance(1000, days);
    expect(r.presentDays).toBe(23.5);
    expect(r.amountSen).toBe(23500);
    expect(r.forfeited).toBe(false);
    expect(r.lateDays).toBe(0);
    expect(r.note).toBe("RM10.00/day x 23.5 days");
  });

  test("3 late days is still paid; 4 forfeits the whole month", () => {
    const three = [day({ isLate: true }), day({ isLate: true }), day({ isLate: true }), ...[...Array(20)].map(() => day())];
    expect(attendanceAllowance(1000, three).forfeited).toBe(false);
    expect(attendanceAllowance(1000, three).amountSen).toBe(23000);

    const four = [...three, day({ isLate: true })];
    const r = attendanceAllowance(1000, four);
    expect(r.forfeited).toBe(true);
    expect(r.amountSen).toBe(0);
    expect(r.lateDays).toBe(4);
    expect(r.note).toBe("Forfeited: late on 4 days");
  });

  test("any unpaid-leave day forfeits the month, even with days present", () => {
    const days = [...[...Array(20)].map(() => day()), day({ status: "UNPAID_LEAVE", fraction: 0 })];
    const r = attendanceAllowance(1000, days);
    expect(r.forfeited).toBe(true);
    expect(r.amountSen).toBe(0);
    expect(r.note).toBe("Forfeited: unpaid leave this month");
  });

  test("unpaid leave forfeits even when late days are within the limit", () => {
    const days = [day({ isLate: true }), day({ status: "UNPAID_LEAVE", fraction: 0 }), ...[...Array(10)].map(() => day())];
    expect(attendanceAllowance(1000, days).amountSen).toBe(0);
  });

  test("no attendance recorded yet = nothing (dormant until data flows)", () => {
    const r = attendanceAllowance(1000, []);
    expect(r.amountSen).toBe(0);
    expect(r.presentDays).toBe(0);
    expect(r.forfeited).toBe(false);
    expect(r.note).toBe("RM10.00/day x 0 days");
  });

  test("one present day reads singular", () => {
    expect(attendanceAllowance(1000, [day()]).note).toBe("RM10.00/day x 1 day");
  });
});
