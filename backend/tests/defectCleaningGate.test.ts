// The Sabah/Sarawak gate for the defect cleaning stage (owner 2026-10-12).
// isEastMalaysiaState decides where the cleaning stage runs; it must NOT overlap
// the region-review states (those go to Nancy and have no cleaning stage), and
// must match the canonical Title-Case spellings (mig 0175).
import { describe, expect, test } from "vitest";
import {
  DEFECT_REVIEW_REGION_STATES,
  EAST_MALAYSIA_STATES,
  isEastMalaysiaState,
  isDefectRegionState,
} from "../src/services/projectGates";

describe("isEastMalaysiaState", () => {
  test("matches exactly Sabah and Sarawak, case/space tolerant", () => {
    expect(isEastMalaysiaState("Sabah")).toBe(true);
    expect(isEastMalaysiaState("  sarawak ")).toBe(true);
    expect(isEastMalaysiaState("SARAWAK")).toBe(true);
  });

  test("rejects peninsular states, the region-review states, and empties", () => {
    expect(isEastMalaysiaState("Selangor")).toBe(false);
    expect(isEastMalaysiaState("Pulau Pinang")).toBe(false);
    expect(isEastMalaysiaState("")).toBe(false);
    expect(isEastMalaysiaState(null)).toBe(false);
    expect(isEastMalaysiaState(undefined)).toBe(false);
  });

  test("never overlaps the region-review (Nancy) states — they have no cleaning stage", () => {
    for (const s of EAST_MALAYSIA_STATES) {
      expect(isDefectRegionState(s)).toBe(false);
    }
    for (const s of DEFECT_REVIEW_REGION_STATES) {
      expect(isEastMalaysiaState(s)).toBe(false);
    }
  });
});
