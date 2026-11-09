import { describe, expect, it } from "vitest";
import { fieldPinReasonText, showsFieldPin, type FieldPinStatus } from "./fieldPin";

const s = (over: Partial<FieldPinStatus> = {}): FieldPinStatus => ({
  eligible: true, reason: "ok", login: "EMP-0042", hasPin: false, locked: false, lockedUntil: null, setAt: null, ...over,
});

describe("showsFieldPin — office staff never see the crew PIN card", () => {
  it("shows for a crew member, hides for office staff without a PIN, shows a leftover PIN", () => {
    expect(showsFieldPin(s())).toBe(true);
    expect(showsFieldPin(s({ eligible: false, reason: "not_crew_title" }))).toBe(false);
    expect(showsFieldPin(s({ eligible: false, reason: "not_crew_title", hasPin: true }))).toBe(true);
    expect(showsFieldPin(null)).toBe(false);
  });
});

describe("fieldPinReasonText", () => {
  it("is silent when eligible and names the staff code when it cannot be typed", () => {
    expect(fieldPinReasonText(s())).toBeNull();
    expect(fieldPinReasonText(s({ eligible: false, reason: "staff_code_shape", login: "SP-1" }))).toContain("SP-1");
    expect(fieldPinReasonText(s({ eligible: false, reason: "no_staff_code" }))).toMatch(/no staff code/);
  });
});
