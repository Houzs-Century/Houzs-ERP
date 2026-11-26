import { describe, expect, test } from "vitest";
import { buildUpcoming, permitAlert, probationAlert } from "./overviewReminders";

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
        emp({ workPermitExpiry: "2026-11-01" }),
        emp({ workPermitExpiry: "2026-12-20" }),
        emp({ workPermitExpiry: "2027-06-01" }),
        emp({ workPermitExpiry: "" }),
        emp({ status: "RESIGNED", workPermitExpiry: "2026-11-25" }),
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

describe("probationAlert", () => {
  test("counts active staff with a future confirmation date and days to the nearest; skips past, blank and non-active", () => {
    const r = probationAlert(
      [
        emp({ confirmDueOn: "2026-12-08" }),
        emp({ confirmDueOn: "2027-02-01" }),
        emp({ confirmDueOn: "2026-10-01" }),
        emp({ confirmDueOn: "" }),
        emp({ status: "RESIGNED", confirmDueOn: "2026-12-01" }),
      ],
      TODAY,
    );
    expect(r).toEqual({ count: 2, nearestDays: 15 });
  });

  test("nobody awaiting confirmation yields zero and null", () => {
    expect(probationAlert([emp({ confirmDueOn: "" })], TODAY)).toEqual({ count: 0, nearestDays: null });
  });
});
