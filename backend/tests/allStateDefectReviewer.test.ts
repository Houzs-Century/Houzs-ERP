import { describe, it, expect } from "vitest";
import {
  isAllStateDefectReviewer,
  isDefectReviewerPosition,
} from "../src/services/projectGates";

// Owner 2026-11-26: Farra (Service Exec) finalises the whole defect list — she
// reviews fresh defects in EVERY state, on top of Nancy (region) and Shukor (the
// rest). She is keyed on her ACCOUNT ID, not her role or position, because both
// are shared: her role "Purchaser" with Sim, her position "Operation Executive"
// with Nancy. These tests pin that the twin does NOT inherit the power, and that
// the all-state concept is distinct from the region-split Storekeeper Supervisor
// gate.
describe("isAllStateDefectReviewer", () => {
  it("is true for Farra's account id (prod users.id 83)", () => {
    expect(isAllStateDefectReviewer({ id: 83 })).toBe(true);
  });

  it("is false for a different account, and fails closed on a missing id", () => {
    expect(isAllStateDefectReviewer({ id: 999 })).toBe(false);
    expect(isAllStateDefectReviewer({})).toBe(false);
    expect(isAllStateDefectReviewer(null)).toBe(false);
    expect(isAllStateDefectReviewer(undefined)).toBe(false);
  });

  it("is a SEPARATE concept from the Storekeeper Supervisor region reviewer", () => {
    // Farra's position must NOT make her the Shukor region-split reviewer; her
    // all-state power comes only from the email gate above.
    expect(isDefectReviewerPosition({ position_name: "Operation Executive" })).toBe(false);
    expect(isDefectReviewerPosition({ position_name: "Storekeeper Supervisor" })).toBe(true);
  });
});
