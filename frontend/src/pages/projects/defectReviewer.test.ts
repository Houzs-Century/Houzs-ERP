import { describe, test, expect } from "vitest";
import {
  canReviewDefect,
  canPurchaseDefect,
  defectActionLabel,
  defectStage,
  isAllStateDefectReviewer,
  isDefectRegionState,
  REVIEWER_DEFECT_ACTIONS,
  PURCHASER_DEFECT_ACTIONS,
} from "./defectReviewer";

describe("defectReviewer", () => {
  test("region states route to the Ops Exec, the rest to the Storekeeper Supervisor", () => {
    const shukor = { permissions: [], position_name: "Storekeeper Supervisor", role_name: "staff" };
    const nancy = { permissions: [], position_name: "Warehouse", role_name: "Ops Exec" };
    expect(canReviewDefect(shukor, "Selangor")).toBe(true);
    expect(canReviewDefect(nancy, "Selangor")).toBe(false);
    expect(canReviewDefect(nancy, "Perak")).toBe(true);
    expect(canReviewDefect(shukor, "Perak")).toBe(false);
  });

  test("admin reviews any state; a plain user reviews none", () => {
    const admin = { permissions: ["*"], position_name: "", role_name: "" };
    const plain = { permissions: [], position_name: "Sales", role_name: "Sales" };
    expect(canReviewDefect(admin, "Perak")).toBe(true);
    expect(canReviewDefect(admin, "Selangor")).toBe(true);
    expect(canReviewDefect(plain, "Selangor")).toBe(false);
    expect(canReviewDefect(null, "Selangor")).toBe(false);
  });

  test("the org.defect.reviewer capability stands in for the Storekeeper Supervisor title", () => {
    const capReviewer = { permissions: [], role_name: "staff", capabilities: { "org.defect.reviewer": true } };
    expect(canReviewDefect(capReviewer, "Selangor")).toBe(true);
    expect(canReviewDefect(capReviewer, "Perak")).toBe(false);
  });

  test("purchaser or BD (or admin) may close an escalation", () => {
    expect(canPurchaseDefect({ permissions: [], role_name: "Purchaser" })).toBe(true);
    expect(canPurchaseDefect({ permissions: [], role_name: "BD Exec" })).toBe(true);
    expect(canPurchaseDefect({ permissions: ["*"], role_name: "" })).toBe(true);
    expect(canPurchaseDefect({ permissions: [], role_name: "Sales" })).toBe(false);
  });

  test("replace reads as Exchange on screen; done and legacy keep their labels", () => {
    expect(defectActionLabel("replace")).toBe("Exchange");
    expect(defectActionLabel("done")).toBe("Done");
    expect(defectActionLabel("ongoing")).toBe("Ongoing");
    expect(defectActionLabel(null)).toBe("Ongoing");
  });

  test("isDefectRegionState is case and space tolerant", () => {
    expect(isDefectRegionState("  perak ")).toBe(true);
    expect(isDefectRegionState("PULAU PINANG")).toBe(true);
    expect(isDefectRegionState("Johor")).toBe(false);
    expect(isDefectRegionState(null)).toBe(false);
  });

  test("the five statuses read with their on-screen labels", () => {
    expect(defectActionLabel("done_clean")).toBe("Done Clean");
    expect(defectActionLabel("exchange")).toBe("Exchange");
    expect(defectActionLabel("service")).toBe("Service");
    expect(defectActionLabel("in_progress")).toBe("In Progress");
    expect(defectActionLabel("done")).toBe("Done");
    // Legacy escalate reads as Exchange; anything else as Ongoing.
    expect(defectActionLabel("replace")).toBe("Exchange");
    expect(defectActionLabel("")).toBe("Ongoing");
  });

  test("defectStage routes each status to the right lane", () => {
    // Fresh: no action yet, or a legacy 'ongoing' upload.
    expect(defectStage(null)).toBe("fresh");
    expect(defectStage("ongoing")).toBe("fresh");
    // Purchaser (Farra): escalated or in progress, incl. legacy 'replace'.
    expect(defectStage("exchange")).toBe("purchaser");
    expect(defectStage("service")).toBe("purchaser");
    expect(defectStage("in_progress")).toBe("purchaser");
    expect(defectStage("replace")).toBe("purchaser");
    // Resolved: cleaned by the reviewer, or closed by the purchaser.
    expect(defectStage("done_clean")).toBe("resolved");
    expect(defectStage("done")).toBe("resolved");
  });

  test("each actor's buttons post the status the lane expects", () => {
    expect(REVIEWER_DEFECT_ACTIONS.map((a) => a.status)).toEqual([
      "done_clean",
      "exchange",
      "service",
    ]);
    expect(PURCHASER_DEFECT_ACTIONS.map((a) => a.status)).toEqual(["in_progress", "done"]);
    // Every reviewer button escalates or resolves — none is a purchaser status.
    for (const a of REVIEWER_DEFECT_ACTIONS) expect(defectStage(a.status)).not.toBe("fresh");
  });
});

// Owner 2026-11-26: Farra (Service Exec) finalises the whole defect list — she
// reviews fresh defects in EVERY state, on top of Nancy (region) and Shukor (the
// rest). Keyed on her account id because her role "Purchaser" and position
// "Operation Executive" are both shared (Sim is also a Purchaser), so a
// role/position rule would wrongly sweep the twin in.
describe("all-state defect finaliser (Farra)", () => {
  const farra = { id: 83, role_name: "Purchaser", position_name: "Operation Executive" };
  const sim = { id: 999, role_name: "Purchaser", position_name: "Operation Executive" };

  test("recognises Farra by account id", () => {
    expect(isAllStateDefectReviewer(farra)).toBe(true);
  });

  test("a purchaser twin who shares her role and position is NOT the finaliser", () => {
    expect(isAllStateDefectReviewer(sim)).toBe(false);
  });

  test("fails closed on a missing id", () => {
    expect(isAllStateDefectReviewer({})).toBe(false);
    expect(isAllStateDefectReviewer(null)).toBe(false);
    expect(isAllStateDefectReviewer(undefined)).toBe(false);
  });

  test("Farra may triage fresh defects in EVERY state — region, non-region, or none", () => {
    expect(canReviewDefect(farra, "Pulau Pinang")).toBe(true); // Nancy's region
    expect(canReviewDefect(farra, "Selangor")).toBe(true); // Shukor's side
    expect(canReviewDefect(farra, null)).toBe(true);
  });

  test("the purchaser twin still cannot triage fresh defects on any state", () => {
    expect(canReviewDefect(sim, "Pulau Pinang")).toBe(false);
    expect(canReviewDefect(sim, "Selangor")).toBe(false);
  });
});
