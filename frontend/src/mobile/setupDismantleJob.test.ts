import { describe, it, expect } from "vitest";
import { isSetupDismantleJob } from "./setupDismantleJob";

describe("isSetupDismantleJob — booth POD visibility on the driver run sheet", () => {
  it("shows for a PMS project SETUP window", () => {
    expect(isSetupDismantleJob({ dp_job_type: "SETUP" })).toBe(true);
  });

  it("shows for a PMS project / DP DISMANTLE job", () => {
    expect(isSetupDismantleJob({ dp_job_type: "DISMANTLE" })).toBe(true);
  });

  it("is case/space-insensitive on the feed value", () => {
    expect(isSetupDismantleJob({ dp_job_type: " setup " })).toBe(true);
    expect(isSetupDismantleJob({ dp_job_type: "Dismantle" })).toBe(true);
  });

  it("does NOT show for a customer delivery, even with a disposal note", () => {
    expect(isSetupDismantleJob({ dp_job_type: null })).toBe(false);
    expect(isSetupDismantleJob({})).toBe(false);
  });

  it("does NOT show for other DP job types", () => {
    for (const t of ["DELIVERY", "PICKUP", "SERVICE", "SUPPLIER_PICKUP"]) {
      expect(isSetupDismantleJob({ dp_job_type: t })).toBe(false);
    }
  });
});
