import { describe, expect, it } from "vitest";
import { mergeByLabel } from "./ServiceMetrics";

describe("Quality Overview breakdowns", () => {
  it("counts one category typed in two cases once", () => {
    expect(mergeByLabel([
      { label: "Product defect", value: 59, color: null },
      { label: "Others", value: 28, color: null },
      { label: "Product Defect ", value: 13, color: null },
    ])).toEqual([
      { label: "Product defect", value: 72, color: null },
      { label: "Others", value: 28, color: null },
    ]);
  });
});
