import { describe, expect, test } from "vitest";
import { actionRequiredLabel, itemReadySummary, qcStageChip, returnDoAttachmentCategory, returnDoPath } from "./item-ready";

describe("Pending Item Ready labels", () => {
  test("names each QC route", () => {
    expect(actionRequiredLabel("pass")).toBe("Approved - to Delivery");
    expect(actionRequiredLabel("fail")).toBe("Send back to supplier");
    expect(actionRequiredLabel("na")).toBe("Others");
  });
  test("an undecided route reads as such", () => {
    expect(actionRequiredLabel(null)).toBe("Not decided");
  });
  test("DO endpoints", () => {
    expect(returnDoPath(7, null)).toBe("/api/assr/7/return-dos");
    expect(returnDoPath(7, 3)).toBe("/api/assr/7/return-dos/3");
  });
});

describe("Pending Item Ready stage header", () => {
  test("a passed QC shows a green chip and the route", () => {
    expect(qcStageChip("pass")).toEqual({ label: "QC Passed", tone: "ok" });
    expect(itemReadySummary("pass")).toBe("QC Result: Approved - to Delivery");
  });
  test("no QC yet shows no chip and the waiting text", () => {
    expect(qcStageChip(null)).toBeNull();
    expect(itemReadySummary(null)).toBe("Awaiting supplier return + QC");
  });
  test("each DO keeps its own attachment category", () => {
    expect(returnDoAttachmentCategory(12)).toBe("return_do_12");
  });
});
