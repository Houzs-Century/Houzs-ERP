/* The defect-photo remark pack/unpack. Owner 2026-09-28: a defect photo carries
 * a Model and a Reason; both are stored in one caption and both must survive the
 * round trip so everyone can read them. Legacy free-text captions (a bare
 * "Elevation") must still read out rather than vanish.
 */
import { describe, expect, test } from "vitest";

import {
  defectRemarkComplete,
  formatDefectCaption,
  parseDefectCaption,
} from "./defectRemark";

describe("formatDefectCaption / parseDefectCaption", () => {
  test("round-trips a Model + Reason", () => {
    const cap = formatDefectCaption({ model: "AKEMI Elevation", reason: "Dented corner" });
    expect(cap).toBe("Model: AKEMI Elevation\nReason: Dented corner");
    expect(parseDefectCaption(cap)).toEqual({ model: "AKEMI Elevation", reason: "Dented corner" });
  });

  test("trims both fields", () => {
    expect(formatDefectCaption({ model: "  X  ", reason: "  y  " })).toBe("Model: X\nReason: y");
  });

  test("a multi-line reason keeps its wrapped lines under Reason", () => {
    const cap = "Model: ZANOTTI Bed\nReason: torn fabric\nand a broken leg";
    expect(parseDefectCaption(cap)).toEqual({ model: "ZANOTTI Bed", reason: "torn fabric\nand a broken leg" });
  });

  test("a legacy free-text caption reads out as the reason, no model", () => {
    expect(parseDefectCaption("Elevation")).toEqual({ model: null, reason: "Elevation" });
  });

  test("empty / null caption yields nulls", () => {
    expect(parseDefectCaption("")).toEqual({ model: null, reason: null });
    expect(parseDefectCaption(null)).toEqual({ model: null, reason: null });
    expect(parseDefectCaption(undefined)).toEqual({ model: null, reason: null });
  });

  test("a structured caption with an empty model still returns the reason", () => {
    expect(parseDefectCaption("Model: \nReason: scratched")).toEqual({ model: null, reason: "scratched" });
  });
});

describe("defectRemarkComplete — the upload gate", () => {
  test("needs both fields non-blank", () => {
    expect(defectRemarkComplete({ model: "X", reason: "y" })).toBe(true);
    expect(defectRemarkComplete({ model: "X", reason: "  " })).toBe(false);
    expect(defectRemarkComplete({ model: "", reason: "y" })).toBe(false);
    expect(defectRemarkComplete(null)).toBe(false);
    expect(defectRemarkComplete(undefined)).toBe(false);
  });
});
