// HR Overview reminders built from the employee master's compliance dates.
import { describe, expect, test } from "vitest";
import { buildUpcoming, permitAlert } from "./overviewReminders";

const TODAY = "2026-11-23";
const emp = (over: Partial<{ name: string; status: string; workPermitExpiry: string; confirmDueOn: string }>) => ({
  name: "X",
  status: "ACTIVE",
  workPermitExpiry: "",
  confirmDueOn: "",
  ...over,
});

describe("permitAlert", () => {
  test("counts active permits within the window and already lapsed; skips blanks, far-off and non-active", () => {
    const r = permitAlert(
      [
        emp({ workPermitExpiry: "2026-11-01" }), // already lapsed
        emp({ workPermitExpiry: "2026-12-20" }), // within 90 days
        emp({ workPermitExpiry: "2027-06-01" }), // beyond 90 days
        emp({ workPermitExpiry: "" }), // no permit
        emp({ status: "RESIGNED", workPermitExpiry: "2026-11-25" }), // not active
      ],
      TODAY,
      90,
    );
    expect(r).toEqual({ count: 2, anyExpired: true });
  });

  test("a permit expiring soon but not yet lapsed sets anyExpired false", () => {
    expect(permitAlert([emp({ workPermitExpiry: "2026-12-20" })], TODAY, 90)).toEqual({ count: 1, anyExpired: false });
  });
});

describe("buildUpcoming", () => {
  test("merges holidays, permit and confirmation dates for active staff, future only, oldest first", () => {
    const holidays = [
      { date: "2026-12-25", name: "Christmas" },
      { date: "2026-10-01", name: "Past holiday" },
    ];
    const emps = [
      emp({ name: "Ali", workPermitExpiry: "2026-12-10", confirmDueOn: "2027-01-15" }),
      emp({ name: "Gone", status: "RESIGNED", workPermitExpiry: "2026-12-05" }),
      emp({ name: "Old", confirmDueOn: "2026-01-01" }),
    ];
    expect(buildUpcoming(holidays, emps, TODAY)).toEqual([
      { date: "2026-12-10", label: "Ali · work permit", kind: "Permit" },
      { date: "2026-12-25", label: "Christmas", kind: "Holiday" },
      { date: "2027-01-15", label: "Ali · confirmation", kind: "Confirm" },
    ]);
  });

  test("a holiday with no name falls back to a label", () => {
    expect(buildUpcoming([{ date: "2026-12-25", name: null }], [], TODAY)).toEqual([{ date: "2026-12-25", label: "Public holiday", kind: "Holiday" }]);
  });
});
