import { describe, expect, it } from "vitest";
import { canSeePendingReminder } from "./pendingReminderAccess";

// The owner's 2026-10-21 pick, pinned exactly: these ten positions get the
// daily pending-work popup, and nothing else does.
const ALLOWED = [
  "Owner",
  "Managing Director",
  "Super Admin",
  "IT Developer Executive",
  "Sales Director",
  "Sales Manager",
  "Sales Executive",
  "Operation Manager",
  "Operation Executive",
  "Logistic Admin",
];

// Everyone else on the live positions table — notably Driver (the owner's
// example) and Finance / HR (his explicit "no").
const DENIED = [
  "Driver",
  "Outsource Transporter",
  "Warehouse Crew KL",
  "PG WH Assistant",
  "Storekeeper",
  "Storekeeper Supervisor",
  "Procurement/Purchasing",
  "Calendar Viewer",
  "Finance Executive",
  "Finance Manager",
  "HR Manager",
];

describe("canSeePendingReminder", () => {
  it.each(ALLOWED)("shows the reminder to %s", (position_name) => {
    expect(canSeePendingReminder({ position_name, permissions: [] })).toBe(true);
  });

  it.each(DENIED)("hides the reminder from %s", (position_name) => {
    expect(canSeePendingReminder({ position_name, permissions: [] })).toBe(false);
  });

  it("matches the position name regardless of case and padding", () => {
    expect(canSeePendingReminder({ position_name: "  sales   EXECUTIVE ", permissions: [] })).toBe(true);
  });

  it("fails closed on an unknown or missing position (a new role is not auto-opted-in)", () => {
    expect(canSeePendingReminder({ position_name: "Brand New Role", permissions: [] })).toBe(false);
    expect(canSeePendingReminder({ position_name: null, permissions: [] })).toBe(false);
    expect(canSeePendingReminder({ position_name: "", permissions: [] })).toBe(false);
    expect(canSeePendingReminder(null)).toBe(false);
    expect(canSeePendingReminder(undefined)).toBe(false);
  });

  it("the `*` wildcard (owner / super admin) always sees it, even with no position", () => {
    expect(canSeePendingReminder({ position_name: null, permissions: ["*"] })).toBe(true);
    expect(canSeePendingReminder({ position_name: "Driver", permissions: ["*"] })).toBe(true);
    expect(canSeePendingReminder({ permissions: "*" })).toBe(true);
  });
});
