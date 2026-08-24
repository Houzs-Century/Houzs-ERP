// The admin PIN door used to be LOOSER than the invite door, and the gap was
// silent. `POST /api/users/invite` refused a `pos_pin` on a non-sales position
// with a message; `POST /api/pos/admin-set-pin/:userId` stored it. A PIN issued
// that way is a credential that can never sign in — `/pin-login` answers
// `not_pos_role` (403), which the tablet renders as a wrong PIN, so the member
// reads as forgetful while the real fault is their title.
//
// These execute the decision (`posPinWriteRefusal`) and the read that feeds it
// (`readPosPinStatus`) rather than matching the handler's spelling, because the
// two predecessors of `canTargetSalesperson` in this same router both died in
// ways a source-text pin cannot see.
import { describe, expect, test } from "vitest";
import {
  isPosPin,
  isPosPinPosition,
  posPinWriteRefusal,
  readPosPinStatus,
} from "../src/services/posPin";
import type { Env } from "../src/types";

type Row = Record<string, unknown> | null;

/** Minimal stand-in for the D1-shaped binding: prepare().bind().first(). */
function fakeEnv(row: Row): Env {
  return {
    DB: {
      prepare: () => ({
        bind: () => ({ first: async () => row }),
      }),
    },
  } as unknown as Env;
}

describe("isPosPin", () => {
  test("accepts exactly six digits", () => {
    expect(isPosPin("123456")).toBe(true);
  });

  test("refuses the near-misses a keypad produces", () => {
    expect(isPosPin("12345")).toBe(false);
    expect(isPosPin("1234567")).toBe(false);
    expect(isPosPin("12 456")).toBe(false);
    expect(isPosPin("")).toBe(false);
    expect(isPosPin(123456)).toBe(false);
  });
});

describe("isPosPinPosition", () => {
  test("Sales Executive — the title in the report — is eligible", () => {
    expect(isPosPinPosition("sales_executive")).toBe(true);
  });

  test("every non-sales slug is refused", () => {
    expect(isPosPinPosition("outlet_manager")).toBe(false);
    expect(isPosPinPosition("driver")).toBe(false);
    expect(isPosPinPosition(null)).toBe(false);
    expect(isPosPinPosition(undefined)).toBe(false);
  });
});

describe("posPinWriteRefusal", () => {
  test("lets an eligible sales member through", () => {
    expect(posPinWriteRefusal({ hasStaffRow: true, positionEligible: true })).toBeNull();
  });

  test("refuses a member with no sales profile", () => {
    expect(
      posPinWriteRefusal({ hasStaffRow: false, positionEligible: true })?.error,
    ).toBe("no_staff_row");
  });

  test("refuses a non-sales title — the gap this test exists for", () => {
    const refusal = posPinWriteRefusal({ hasStaffRow: true, positionEligible: false });
    expect(refusal?.error).toBe("not_pos_role");
    // The message has to name the fixable thing, or the admin retypes the PIN.
    expect(refusal?.message).toContain("Sales position");
  });

  test("a missing staff row is reported before the title", () => {
    // Both wrong: telling someone to change a title on a member who has no
    // sales profile at all sends them to fix the wrong field.
    expect(
      posPinWriteRefusal({ hasStaffRow: false, positionEligible: false })?.error,
    ).toBe("no_staff_row");
  });
});

describe("readPosPinStatus", () => {
  test("maps a ready sales member with a PIN on file", async () => {
    const status = await readPosPinStatus(
      fakeEnv({
        staff_id: "1d1c0a1e-0000-4000-8000-000000000001",
        staff_active: true,
        position_slug: "sales_executive",
        has_pin: true,
        updated_at: "2026-08-24T00:00:00Z",
      }),
      26,
    );
    expect(status).toEqual({
      hasStaffRow: true,
      staffActive: true,
      positionSlug: "sales_executive",
      positionEligible: true,
      hasPin: true,
      updatedAt: "2026-08-24T00:00:00Z",
    });
  });

  test("a member with no staff row reads as not-ready, not as an error", async () => {
    const status = await readPosPinStatus(
      fakeEnv({
        staff_id: null,
        staff_active: null,
        position_slug: "sales_executive",
        has_pin: null,
        updated_at: null,
      }),
      99,
    );
    expect(status.hasStaffRow).toBe(false);
    expect(status.hasPin).toBe(false);
    expect(status.updatedAt).toBeNull();
    expect(posPinWriteRefusal(status)?.error).toBe("no_staff_row");
  });

  test("an unknown user id is not silently 'has a PIN'", async () => {
    // The LEFT JOINs mean a missing user returns no row at all. Anything that
    // let that read as hasPin:true would tell an admin a credential exists.
    const status = await readPosPinStatus(fakeEnv(null), 123456);
    expect(status.hasPin).toBe(false);
    expect(status.hasStaffRow).toBe(false);
    expect(status.positionEligible).toBe(false);
  });

  test("an inactive staff row is surfaced, not hidden", async () => {
    // The tablet's picker filters on scm.staff.active, so a PIN set against an
    // inactive profile works nowhere and the screen has to be able to say so.
    const status = await readPosPinStatus(
      fakeEnv({
        staff_id: "1d1c0a1e-0000-4000-8000-000000000002",
        staff_active: false,
        position_slug: "sales",
        has_pin: true,
        updated_at: null,
      }),
      27,
    );
    expect(status.staffActive).toBe(false);
    expect(status.hasPin).toBe(true);
  });
});
