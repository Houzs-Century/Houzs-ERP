import { describe, expect, test } from "vitest";
import { canCompileReminders, canCreateEvent } from "../src/routes/lib/named-tier";

/* Owner 2026-10-07: "full access for this only ummu, owner, weisiang". These are
   the three live accounts that pass, and the cohorts named as NOT passing —
   in particular the other Super Admins, whose role wildcard is not the tier. */
describe("canCompileReminders", () => {
  test("passes the BD role (Ummu), the Owner position and weisiang", () => {
    expect(canCompileReminders({ role_name: "BD Exec", position_name: "Operation Executive", email: "x@y" })).toBe(true);
    expect(canCompileReminders({ role_name: "Owner", position_name: "Owner", email: "hello@houzscentury.com" })).toBe(true);
    expect(canCompileReminders({ role_name: "Super Admin", position_name: "Managing Director", email: "WeiSiang329@gmail.com" })).toBe(true);
  });

  test("refuses the other Super Admins, sales staff and no user", () => {
    expect(canCompileReminders({ role_name: "Super Admin", position_name: "Managing Director", email: "someone@gmail.com" })).toBe(false);
    expect(canCompileReminders({ role_name: "Super Admin", position_name: "Super Admin", email: null })).toBe(false);
    expect(canCompileReminders({ role_name: "Sales Person", position_name: "Sales Executive", email: "rep@gmail.com" })).toBe(false);
    expect(canCompileReminders(null)).toBe(false);
    expect(canCompileReminders(undefined)).toBe(false);
  });

  test("is the same tier as event creation", () => {
    for (const u of [
      { role_name: "BD Exec", position_name: null, email: null },
      { role_name: "Super Admin", position_name: "Super Admin", email: null },
      { role_name: "Logistic", position_name: "Driver", email: "d@x" },
    ]) {
      expect(canCompileReminders(u)).toBe(canCreateEvent(u));
    }
  });
});
