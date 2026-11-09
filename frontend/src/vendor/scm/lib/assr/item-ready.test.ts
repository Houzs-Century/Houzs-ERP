import { describe, expect, test } from "vitest";
import { actionRequiredLabel, returnDoPath } from "./item-ready";

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
