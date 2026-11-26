import { describe, it, expect } from "vitest";
import { computeAttendanceDay, toAttendanceRules } from "../../scm/shared/hr-attendance";
import { DEFAULT_PAY_RULES } from "../../scm/shared/hr-pay-rules";
import { shiftRulesFor, shiftWindowProblem, type ShiftGroupShift } from "./hr-shift";

const base = toAttendanceRules({ ...DEFAULT_PAY_RULES, shiftStartMin: 9 * 60, shiftEndMin: 19 * 60, lateGraceMin: 10 });

const local: ShiftGroupShift = { startMin: 9 * 60, endMin: 17 * 60 + 30, deliveryStartMin: 8 * 60 + 30, deliveryEndMin: 17 * 60 };
const driver: ShiftGroupShift = { startMin: 8 * 60 + 30, endMin: 17 * 60, deliveryStartMin: null, deliveryEndMin: null };

describe("shiftRulesFor", () => {
  it("keeps the global shift when there is no group", () => {
    expect(shiftRulesFor(base, null, false)).toEqual(base);
  });

  it("puts the group's base shift in place and recomputes the standard day", () => {
    const r = shiftRulesFor(base, local, false);
    expect(r.startMin).toBe(9 * 60);
    expect(r.endMin).toBe(17 * 60 + 30);
    expect(r.standardWorkMin).toBe(17 * 60 + 30 - 9 * 60 - base.lunchMin);
    expect(r.lateGraceMin).toBe(base.lateGraceMin);
  });

  it("uses the delivery-day shift on a delivery day", () => {
    const r = shiftRulesFor(base, local, true);
    expect(r.startMin).toBe(8 * 60 + 30);
    expect(r.endMin).toBe(17 * 60);
  });

  it("keeps the base shift on a delivery day when the group has no delivery variation", () => {
    const r = shiftRulesFor(base, driver, true);
    expect(r.startMin).toBe(8 * 60 + 30);
    expect(r.endMin).toBe(17 * 60);
  });

  it("judges lateness from the group's start, not the global start", () => {
    const clockIn = 9 * 60 + 20;
    const g = shiftRulesFor(base, driver, false);
    const day = computeAttendanceDay(clockIn, 17 * 60, g);
    expect(day.isLate).toBe(true);
    expect(day.lateMin).toBe(50);

    const dl = shiftRulesFor(base, local, true);
    expect(computeAttendanceDay(8 * 60 + 35, 17 * 60, dl).isLate).toBe(false);
    expect(computeAttendanceDay(9 * 60, 17 * 60, dl).isLate).toBe(true);
  });
});

describe("shiftWindowProblem", () => {
  it("accepts a sane window", () => {
    expect(shiftWindowProblem(9 * 60, 19 * 60)).toBeNull();
  });
  it("rejects end before start and out-of-day times", () => {
    expect(shiftWindowProblem(19 * 60, 9 * 60)).not.toBeNull();
    expect(shiftWindowProblem(-1, 19 * 60)).not.toBeNull();
    expect(shiftWindowProblem(9 * 60, 25 * 60)).not.toBeNull();
  });
});
