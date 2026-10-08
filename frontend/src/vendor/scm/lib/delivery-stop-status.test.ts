import { describe, expect, test } from "vitest";
import { stopStatusOf, windowEndMinutes } from "./delivery-stop-status";

const today = "2026-10-08";
const at = (day: string, nowMinutes: number) => ({ day, today, nowMinutes });

describe("windowEndMinutes", () => {
  test("reads the end of the common slot spellings", () => {
    expect(windowEndMinutes("9-12")).toBe(12 * 60);
    expect(windowEndMinutes("09:40–10:25")).toBe(10 * 60 + 25);
    expect(windowEndMinutes("2pm-5pm")).toBe(17 * 60);
    expect(windowEndMinutes("2-4pm")).toBe(16 * 60);
    expect(windowEndMinutes("after 3pm")).toBeNull();
    expect(windowEndMinutes(null)).toBeNull();
  });
});

describe("stopStatusOf", () => {
  test("a delivered DO or a completed POD is done", () => {
    expect(stopStatusOf({ delivery_orders: [{ status: "DELIVERED" }] }, null, at(today, 600))).toBe("done");
    expect(stopStatusOf({}, { completed_at: "2026-10-08T03:00:00Z" }, at("2026-10-01", 600))).toBe("done");
  });

  test("On the way or Arrived is active", () => {
    expect(stopStatusOf({}, { departed_at: "x" }, at(today, 600))).toBe("active");
    expect(stopStatusOf({ arrival_at: "x" }, null, at(today, 600))).toBe("active");
  });

  test("past its day, or past the promised window today, is overdue", () => {
    expect(stopStatusOf({}, null, at("2026-10-07", 0))).toBe("overdue");
    expect(stopStatusOf({ time_range: "9-12" }, null, at(today, 13 * 60))).toBe("overdue");
    expect(stopStatusOf({ time_range: "9-12" }, null, at(today, 11 * 60))).toBe("scheduled");
    expect(stopStatusOf({}, null, at("2026-10-09", 0))).toBe("scheduled");
  });
});
