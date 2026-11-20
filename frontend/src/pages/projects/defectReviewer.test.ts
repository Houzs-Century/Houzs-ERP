import { describe, test, expect } from "vitest";
import {
  canReviewDefect,
  canPurchaseDefect,
  defectActionLabel,
  isDefectRegionState,
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
});
