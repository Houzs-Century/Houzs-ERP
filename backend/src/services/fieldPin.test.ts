import { describe, expect, it } from "vitest";
import {
  FIELD_API_PREFIXES,
  fieldPinProblem,
  fieldSessionAllowsPath,
  isFieldPinEligible,
  isLocked,
  normaliseFieldLogin,
  staffCodeFitsFieldLogin,
} from "./fieldPin";
import { fieldSessionRefusal } from "../middleware/auth";
import type { PositionPolicyRow } from "./positionPolicyRows";

const policy = (cohort: PositionPolicyRow["cohort"], profile: PositionPolicyRow["profile"]): PositionPolicyRow => ({
  position_id: 1,
  cohort,
  profile,
  can_move_money: false,
  can_write_config: false,
  is_fleet: false,
  duty: "other",
});

describe("normaliseFieldLogin", () => {
  it.each([
    ["42", "EMP-0042"],
    ["0042", "EMP-0042"],
    ["emp-0042", "EMP-0042"],
    [" EMP 0042 ", "EMP-0042"],
    ["emp42", "EMP-0042"],
    ["0042-1", "EMP-0042-1"],
    ["12345", "EMP-12345"],
  ])("%s -> %s", (raw, code) => expect(normaliseFieldLogin(raw)).toBe(code));

  it.each(["", "abc", "EMP-", "1234567", "42-123", "SP-0042", null, 42])("refuses %s", (raw) =>
    expect(normaliseFieldLogin(raw)).toBeNull(),
  );

  it("a staff code fits the form only when it is already in EMP- shape", () => {
    expect(staffCodeFitsFieldLogin("EMP-0042")).toBe(true);
    expect(staffCodeFitsFieldLogin("EMP-0042-2")).toBe(true);
    expect(staffCodeFitsFieldLogin("SP-SAMPLE-1")).toBe(false);
    expect(staffCodeFitsFieldLogin(null)).toBe(false);
  });
});

describe("fieldPinProblem", () => {
  it("accepts an ordinary 6-digit PIN", () => expect(fieldPinProblem("482913")).toBeNull());
  it.each(["12345", "1234567", "12a456", 123456])("refuses the wrong shape %s", (pin) =>
    expect(fieldPinProblem(pin)).toMatch(/exactly 6 digits/),
  );
  it.each(["000000", "777777", "123456", "654321", "345678"])("refuses the obvious %s", (pin) =>
    expect(fieldPinProblem(pin)).toMatch(/too easy/),
  );
});

describe("isFieldPinEligible — only the restricted Driver / Helper profile", () => {
  it("admits restricted + driver_helper", () =>
    expect(isFieldPinEligible({ cohort: "restricted", profile: "driver_helper" })).toBe(true));
  it.each([
    [{ cohort: "restricted", profile: "storekeeper" }],
    [{ cohort: "full", profile: null }],
    [{ cohort: "god", profile: null }],
    [{ cohort: "sales", profile: "rep" }],
    [null],
    [undefined],
  ] as [Parameters<typeof isFieldPinEligible>[0]][])("refuses %j (a Title with no row resolves FULL, so it is refused too)", (row) =>
    expect(isFieldPinEligible(row)).toBe(false),
  );
});

describe("field session scope", () => {
  it.each([
    "/api/scm/delivery-planning",
    "/api/scm/delivery-planning/do/DO-1",
    "/api/scm/delivery-jobs/do/DO-1/photo/1",
    "/api/projects/12",
    "/api/attendance/punch",
    "/api/users/me/profile-pic",
    "/api/auth/me",
  ])("allows %s", (p) => expect(fieldSessionAllowsPath(p)).toBe(true));

  it.each([
    "/api/pos/exchange-web-session",
    "/api/totp/setup",
    "/api/users",
    "/api/users/5/reset-password",
    "/api/hr/payroll",
    "/api/finance",
    "/api/roles",
    "/api/scm/mfg-sales-orders",
    "/api/scm/accounting-receipts",
    "/api/projects-print/1",
    "/api/scm/delivery-planningX",
  ])("refuses %s", (p) => expect(fieldSessionAllowsPath(p)).toBe(false));

  it("every allowed prefix is an /api path with no trailing slash", () => {
    for (const p of FIELD_API_PREFIXES) expect(p).toMatch(/^\/api\/[a-z/-]+[a-z]$/);
  });

  const crew = policy("restricted", "driver_helper");

  it("an ordinary session is never touched, whatever the path", () => {
    expect(fieldSessionRefusal({ session_origin: null, position_policy: null }, "/api/hr/payroll")).toBeNull();
    expect(fieldSessionRefusal({ session_origin: "pos", position_policy: null }, "/api/roles")).toBeNull();
  });

  it("a field session is refused an office module with 403", () => {
    const r = fieldSessionRefusal({ session_origin: "field", position_policy: crew }, "/api/scm/mfg-sales-orders");
    expect(r?.status).toBe(403);
    expect(r?.body.code).toBe("field_session_scope");
  });

  it("a field session passes a field screen", () => {
    expect(fieldSessionRefusal({ session_origin: "field", position_policy: crew }, "/api/scm/delivery-planning")).toBeNull();
  });

  it("a field session whose Title stopped being crew is ended with 401, even on a field path", () => {
    const r = fieldSessionRefusal(
      { session_origin: "field", position_policy: policy("full", null) },
      "/api/scm/delivery-planning",
    );
    expect(r?.status).toBe(401);
    expect(r?.body.code).toBe("field_pin_not_eligible");
  });
});

describe("isLocked", () => {
  const now = Date.parse("2026-11-10T00:00:00Z");
  it("future lock is in force; past, null and garbage are not", () => {
    expect(isLocked("2026-11-10T00:05:00Z", now)).toBe(true);
    expect(isLocked(new Date(now + 1000), now)).toBe(true);
    expect(isLocked("2026-11-09T23:59:00Z", now)).toBe(false);
    expect(isLocked(null, now)).toBe(false);
    expect(isLocked("not a date", now)).toBe(false);
  });
});
